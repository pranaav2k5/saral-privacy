import { mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { FileObjectStore, anchorKey } from "./object-store.js";

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "saral-store-"));
});
afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

const T = "11111111-1111-4111-8111-111111111111";

describe("anchorKey", () => {
  test("names an anchor by organisation and day", () => {
    expect(anchorKey(T, "2026-11-06")).toBe(`anchors/${T}/2026-11-06.json`);
  });
});

describe("FileObjectStore", () => {
  test("writes an object once, under folders it makes, and reads it back exactly", async () => {
    const store = new FileObjectStore(dir);
    expect(await store.putIfAbsent(anchorKey(T, "2026-11-06"), '{"a":1}\n')).toBe("written");
    expect(readFileSync(join(dir, "anchors", T, "2026-11-06.json"), "utf8")).toBe('{"a":1}\n');
    expect(await store.get(anchorKey(T, "2026-11-06"))).toBe('{"a":1}\n');
  });

  test("never replaces an object that is there: the second write says so and the first stays", async () => {
    const store = new FileObjectStore(dir);
    await store.putIfAbsent("anchors/x/one.json", "first");
    expect(await store.putIfAbsent("anchors/x/one.json", "second")).toBe("exists");
    expect(await store.get("anchors/x/one.json")).toBe("first");
  });

  test("makes the file read-only, as a record that is not meant to change", async () => {
    await new FileObjectStore(dir).putIfAbsent("anchors/x/one.json", "first");
    expect(statSync(join(dir, "anchors", "x", "one.json")).mode & 0o222).toBe(0);
  });

  test("two writes at the same moment: exactly one wins", async () => {
    const store = new FileObjectStore(dir);
    const results = await Promise.all(Array.from({ length: 8 }, (_, i) => store.putIfAbsent("anchors/x/race.json", `body-${String(i)}`)));
    expect(results.filter((r) => r === "written")).toHaveLength(1);
    expect(results.filter((r) => r === "exists")).toHaveLength(7);
  });

  test("an object that is not there reads as undefined", async () => {
    expect(await new FileObjectStore(dir).get("anchors/x/none.json")).toBeUndefined();
  });

  test.each([
    ["a path out of the folder", "../outside.json"],
    ["a path out of the folder in the middle", "anchors/../../outside.json"],
    ["an absolute path", "/etc/passwd"],
    ["a doubled slash", "anchors//x.json"],
    ["a dot folder", "anchors/./x.json"],
    ["an empty name", ""],
    ["capital letters or spaces", "Anchors/My File.json"],
    ["a backslash", "anchors\\x.json"],
    ["a name that is far too long", `anchors/${"a".repeat(300)}.json`],
  ])("refuses %s, for reading and writing", async (_n, key) => {
    const store = new FileObjectStore(dir);
    await expect(store.putIfAbsent(key, "x")).rejects.toThrow(/invalid object key/);
    await expect(store.get(key)).rejects.toThrow(/invalid object key/);
  });

  test("does not follow a link out of its folder", async () => {
    const outside = mkdtempSync(join(tmpdir(), "saral-outside-"));
    try {
      mkdirSync(join(dir, "anchors"));
      symlinkSync(outside, join(dir, "anchors", "link"));
      await expect(new FileObjectStore(dir).putIfAbsent("anchors/link/x.json", "x")).rejects.toThrow(/outside/);
      expect(() => readFileSync(join(outside, "x.json"))).toThrow();
    } finally {
      rmSync(outside, { recursive: true, force: true });
    }
  });

  test("a file that is a directory or a pipe is not an object", async () => {
    const store = new FileObjectStore(dir);
    mkdirSync(join(dir, "anchors"));
    mkdirSync(join(dir, "anchors", "folder.json"));
    await expect(store.get("anchors/folder.json")).rejects.toThrow(/not a regular file/);
    writeFileSync(join(dir, "anchors", "ok.json"), "fine");
    expect(await store.get("anchors/ok.json")).toBe("fine");
  });
});
