import { closeSync, constants, fstatSync, openSync, readFileSync } from "node:fs";
import { verifyAgainstAnchor, verifyLinksAgainstAnchor, type Anchor, type AnchorResult } from "./anchor";
import type { ChainEntry } from "./chain";

export interface Io {
  out(line: string): void;
  err(line: string): void;
}

const USAGE = `Usage: saral-audit-verify --anchor <anchor.json> --entries <entries.json> [--previous-anchor <anchor.json>] [--key <version>=<keyfile> ...]

  --anchor           the anchor for one day (the file the nightly job wrote, or the answer of GET /v1/audit/merkle-root)
  --entries          that day's entries (the answer of GET /v1/audit/entries)
  --previous-anchor  the anchor of the day before, to check that this day follows it
  --key              an audit HMAC key as a file of 64 hexadecimal characters, with the key version it is for.
                     Without a key the tool proves the entries are exactly the anchored ones; with it, also that each says what its hash was made from.

Exit code: 0 the entries match, 1 they do not, 2 the input could not be used.`;

const ANCHOR_MAX_BYTES = 4096;
const KEY_MAX_BYTES = 1024;
const ENTRIES_MAX_BYTES = 256 * 1024 * 1024;

class Refused extends Error {}

/** Reads a regular file of bounded size. A directory, a pipe or a huge file is refused before anything is read. */
function readBounded(path: string, max: number, label: string): string {
  let fd: number;
  try {
    // O_NONBLOCK so that opening a pipe cannot hang; the size and kind are checked on the open handle.
    fd = openSync(path, constants.O_RDONLY | constants.O_NONBLOCK);
  } catch (e) {
    const code = (e as NodeJS.ErrnoException).code;
    throw new Refused(`could not read ${label} (${path}): ${code === "ENOENT" ? "it does not exist" : "it could not be opened"}.`);
  }
  try {
    const st = fstatSync(fd);
    if (!st.isFile()) throw new Refused(`${label} (${path}) is not a regular file.`);
    if (st.size > max) throw new Refused(`${label} (${path}) is larger than ${String(max)} bytes.`);
    return readFileSync(fd, "utf8");
  } finally {
    closeSync(fd);
  }
}

function readJson(path: string, max: number, label: string): unknown {
  const text = readBounded(path, max, label);
  try {
    return JSON.parse(text) as unknown;
  } catch {
    throw new Refused(`${label} (${path}) is not valid JSON.`);
  }
}

const isObject = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);

function parseAnchor(raw: unknown, label: string): Anchor {
  if (!isObject(raw)) throw new Refused(`${label} must be an anchor (a JSON object).`);
  const need: [string, "string" | "number"][] = [["version", "number"], ["tenantId", "string"], ["date", "string"], ["count", "number"], ["firstSeqNo", "string"], ["lastSeqNo", "string"], ["headHash", "string"], ["merkleRoot", "string"]];
  for (const [name, type] of need) if (typeof raw[name] !== type) throw new Refused(`${label} has no ${name} (or it is not a ${type}).`);
  if (raw.version !== 1) throw new Refused(`${label} uses version ${String(raw.version)}, which this tool does not know.`);
  if (!/^[0-9]{1,30}$/.test(raw.firstSeqNo as string) || !/^[0-9]{1,30}$/.test(raw.lastSeqNo as string)) throw new Refused(`${label} has a sequence number that is not digits.`);
  return raw as unknown as Anchor;
}

const ENTRY_STRINGS = ["tenantId", "seqNo", "ts", "actorType", "action", "refTable", "refId", "payloadSha256", "prevHash", "entryHash"] as const;

function parseEntries(raw: unknown, label: string): ChainEntry[] {
  if (!Array.isArray(raw)) throw new Refused(`${label} must be a list of entries.`);
  if (raw.length === 0) throw new Refused(`${label} has no entries.`);
  raw.forEach((e: unknown, i) => {
    const n = i + 1;
    if (!isObject(e)) throw new Refused(`entry ${String(n)} is not an object.`);
    for (const f of ENTRY_STRINGS) if (typeof e[f] !== "string") throw new Refused(`entry ${String(n)} has no ${f} (or it is not text).`);
    if (!("actorId" in e) || (e.actorId !== null && typeof e.actorId !== "string")) throw new Refused(`entry ${String(n)} has no actorId (it must be text or null).`);
    for (const f of ["canonicalSchemaVersion", "hmacSchemaVersion"] as const) if (typeof e[f] !== "number") throw new Refused(`entry ${String(n)} has no ${f} (or it is not a number).`);
  });
  return raw as ChainEntry[];
}

function parseKey(path: string): Uint8Array {
  const text = readBounded(path, KEY_MAX_BYTES, "a key file").trim();
  if (!/^[0-9a-fA-F]{64}$/.test(text)) throw new Refused(`the key file (${path}) must hold 64 hexadecimal characters.`);
  return new Uint8Array(Buffer.from(text, "hex"));
}

interface Args {
  anchor: string;
  entries: string;
  previous?: string;
  keys: Map<number, string>;
}

function parseArgs(argv: readonly string[]): Args | null {
  const seen = new Map<string, string>();
  const keys = new Map<number, string>();
  for (let i = 0; i < argv.length; i += 2) {
    const flag = argv[i] as string;
    const value = argv[i + 1];
    if (value === undefined || !["--anchor", "--entries", "--previous-anchor", "--key"].includes(flag)) return null;
    if (flag === "--key") {
      const m = /^([0-9]{1,6})=(.+)$/.exec(value);
      if (m === null || keys.has(Number(m[1]))) return null;
      keys.set(Number(m[1]), m[2] as string);
    } else {
      if (seen.has(flag)) return null;
      seen.set(flag, value);
    }
  }
  const anchor = seen.get("--anchor");
  const entries = seen.get("--entries");
  if (anchor === undefined || entries === undefined) return null;
  const previous = seen.get("--previous-anchor");
  return { anchor, entries, ...(previous === undefined ? {} : { previous }), keys };
}

/** What a failure means, in words an auditor can act on. */
function say(failure: Exclude<AnchorResult, { ok: true }>, entries: readonly ChainEntry[]): string {
  const at = `entry ${failure.seqNo}`;
  switch (failure.failure) {
    case "seq_gap":
      return `${at}: a number is missing before it, so an entry was removed or the list is incomplete.`;
    case "prev_mismatch":
      return `${at}: it does not point at the entry before it, so entries were changed, removed or reordered.`;
    case "tenant_mismatch":
      return `${at}: it belongs to another organisation than the anchor.`;
    case "invalid_fields":
      return `${at}: a field has a form that an entry cannot have.`;
    case "hash_mismatch":
      return `${at}: what it says does not match its hash.`;
    case "unknown_key": {
      const version = entries.find((e) => e.seqNo === failure.seqNo)?.hmacSchemaVersion;
      return `${at}: no key was given for key version ${String(version)}.`;
    }
    case "key_version_regression":
      return `${at}: it uses an older key version than the entry before it.`;
    case "unsupported_version":
      return `${at}: it uses a format version this tool does not know.`;
    case "anchor_mismatch":
      return "the entries do not match the anchor (the count, the numbers, the head hash or the Merkle root differ), so entries were removed, added or replaced.";
  }
}

/**
 * Checks one day of audit entries against that day's anchor, on files only: no database, no API, no network. Returns the exit
 * code: 0 the entries match, 1 they do not, 2 the input could not be used.
 */
export async function runVerifier(argv: readonly string[], io: Io): Promise<number> {
  const args = parseArgs(argv);
  if (args === null) {
    io.err(USAGE);
    return 2;
  }
  try {
    const anchor = parseAnchor(readJson(args.anchor, ANCHOR_MAX_BYTES, "the anchor"), "the anchor");
    const entries = parseEntries(readJson(args.entries, ENTRIES_MAX_BYTES, "the entries file"), "the entries file");
    const keyBytes = new Map<number, Uint8Array>();
    for (const [version, path] of args.keys) keyBytes.set(version, parseKey(path));

    let startPrevHash: string | undefined;
    let startSeqNo: string | undefined;
    let previousDate: string | undefined;
    if (args.previous !== undefined) {
      const prev = parseAnchor(readJson(args.previous, ANCHOR_MAX_BYTES, "the previous anchor"), "the previous anchor");
      if (prev.tenantId !== anchor.tenantId || BigInt(prev.lastSeqNo) + 1n !== BigInt(anchor.firstSeqNo)) {
        throw new Refused("the previous anchor does not lead into this one (it must be for the same organisation and end at the entry just before this one's first).");
      }
      startPrevHash = prev.headHash;
      startSeqNo = prev.lastSeqNo;
      previousDate = prev.date;
    }

    let result: AnchorResult;
    if (keyBytes.size === 0) {
      result = verifyLinksAgainstAnchor(entries, anchor, startPrevHash === undefined ? {} : { startPrevHash });
    } else {
      // A day that does not start at the beginning of the chain is taken to link to whatever its first entry says it follows,
      // unless the day before was given; the output says that this was not checked.
      const first = entries[0] as ChainEntry;
      const from = startPrevHash ?? (anchor.firstSeqNo === "1" ? undefined : first.prevHash);
      result = verifyAgainstAnchor(entries, anchor, (v) => keyBytes.get(v), {
        ...(from === undefined ? {} : { startPrevHash: from }),
        ...(startSeqNo === undefined ? {} : { startSeqNo }),
      });
    }
    if (!result.ok) {
      io.err(`FAILED: ${say(result, entries)}`);
      return 1;
    }
    const n = entries.length;
    io.out(`OK: the ${String(n)} ${n === 1 ? "entry" : "entries"} (${n === 1 ? "number" : "numbers"} ${n === 1 ? anchor.firstSeqNo : `${anchor.firstSeqNo} to ${anchor.lastSeqNo}`}) for ${anchor.date} are exactly the ones in the anchor.`);
    if (previousDate !== undefined) io.out(`It follows the entry before it in the anchor for ${previousDate}.`);
    else if (anchor.firstSeqNo !== "1") io.out("Not checked: that the first entry follows the day before; give --previous-anchor for that.");
    io.out(keyBytes.size > 0 ? "Every entry also matches the hash made from what it says." : "Not checked: what each entry says, because no key was given.");
    return 0;
  } catch (e) {
    if (e instanceof Refused) {
      io.err(e.message);
      return 2;
    }
    io.err("The check could not be completed.");
    return 2;
  }
}
