import { constants, promises as fs } from "node:fs";
import { dirname, join, resolve, sep } from "node:path";
import { randomBytes } from "node:crypto";

/**
 * Where anchors are kept. `putIfAbsent` must never replace an object: the point of an anchor is that it is written once.
 * (Production keeps them in S3 with Object Lock; that adapter is not built. This is the same contract on a folder.)
 */
export interface ObjectStore {
  putIfAbsent(key: string, body: string): Promise<"written" | "exists">;
  get(key: string): Promise<string | undefined>;
}

/** Where the anchor of one organisation and one UTC day is kept. */
export const anchorKey = (tenantId: string, date: string): string => `anchors/${tenantId}/${date}.json`;

// Lowercase letters, digits, `_`, `.` and `-`, in folders separated by single slashes, none starting with a dot.
const KEY = /^[a-z0-9][a-z0-9_.-]*(\/[a-z0-9][a-z0-9_.-]*)*$/;
const KEY_MAX = 200;
const OBJECT_MAX_BYTES = 64 * 1024;

function checkKey(key: string): void {
  if (key.length === 0 || key.length > KEY_MAX || !KEY.test(key)) throw new Error("invalid object key");
}

/** An object store on a folder. Objects are made read-only, and are published whole or not at all. */
export class FileObjectStore implements ObjectStore {
  private readonly root: string;

  constructor(dir: string) {
    this.root = resolve(dir);
  }

  /** The folder an object lives in must really be inside the root, even if something in between is a link. */
  private async inside(folder: string): Promise<void> {
    const real = await fs.realpath(folder);
    const root = await fs.realpath(this.root);
    if (real !== root && !real.startsWith(root + sep)) throw new Error("the object would be outside the store's folder");
  }

  async putIfAbsent(key: string, body: string): Promise<"written" | "exists"> {
    checkKey(key);
    const path = join(this.root, ...key.split("/"));
    await fs.mkdir(dirname(path), { recursive: true });
    await this.inside(dirname(path));
    // Written to a temporary name and then linked into place: the link fails if the object exists, and a reader never sees half of one.
    const temp = join(dirname(path), `.${randomBytes(8).toString("hex")}.tmp`);
    await fs.writeFile(temp, body, { flag: "wx", mode: 0o444 });
    try {
      await fs.link(temp, path);
      return "written";
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code === "EEXIST") return "exists";
      throw e;
    } finally {
      await fs.unlink(temp).catch(() => undefined);
    }
  }

  async get(key: string): Promise<string | undefined> {
    checkKey(key);
    const path = join(this.root, ...key.split("/"));
    let handle: fs.FileHandle;
    try {
      handle = await fs.open(path, constants.O_RDONLY | constants.O_NONBLOCK);
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code === "ENOENT") return undefined;
      throw e;
    }
    try {
      await this.inside(dirname(path));
      const st = await handle.stat();
      if (!st.isFile()) throw new Error("the object is not a regular file");
      if (st.size > OBJECT_MAX_BYTES) throw new Error("the object is larger than an anchor can be");
      return await handle.readFile("utf8");
    } finally {
      await handle.close();
    }
  }
}
