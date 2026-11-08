import { mkdtempSync, mkdirSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { anchorBody, buildAnchor, type Anchor, type ChainEntry } from "./index";
import { KEY, TENANT, makeChain } from "./test-helpers";
import { runVerifier } from "./verify-cli";

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "saral-verify-"));
});
afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

const DAY = "2026-11-06";
const write = (name: string, content: string | object): string => {
  const p = join(dir, name);
  writeFileSync(p, typeof content === "string" ? content : JSON.stringify(content));
  return p;
};
async function run(args: string[]) {
  const out: string[] = [];
  const err: string[] = [];
  const code = await runVerifier(args, { out: (l) => out.push(l), err: (l) => err.push(l) });
  return { code, out: out.join("\n"), err: err.join("\n") };
}
const files = (chain: ChainEntry[], anchor: Anchor = buildAnchor(TENANT, DAY, chain)) => ({
  anchor: write("anchor.json", anchorBody(anchor)),
  entries: write("entries.json", chain),
});
const keyFile = (key: Uint8Array = KEY) => write("key.hex", Buffer.from(key).toString("hex") + "\n");

describe("without a key", () => {
  test("says the entries are exactly the anchored ones, and says plainly what it did not check", async () => {
    const f = files(makeChain(5));
    const r = await run(["--anchor", f.anchor, "--entries", f.entries]);
    expect(r.code).toBe(0);
    expect(r.out).toContain("OK: the 5 entries (numbers 1 to 5) for 2026-11-06 are exactly the ones in the anchor.");
    expect(r.out).toContain("Not checked: what each entry says, because no key was given.");
    expect(r.err).toBe("");
  });

  test("names the first entry that does not fit, in words, and exits with 1", async () => {
    const chain = makeChain(5);
    const f = files([...chain.slice(0, 2), ...chain.slice(3)], buildAnchor(TENANT, DAY, chain));
    const r = await run(["--anchor", f.anchor, "--entries", f.entries]);
    expect(r.code).toBe(1);
    expect(r.err).toContain("FAILED: entry 4: a number is missing before it, so an entry was removed or the list is incomplete.");
    expect(r.out).not.toContain("OK");
  });

  test("entries cut off at the end are reported against the anchor", async () => {
    const chain = makeChain(5);
    const f = files(chain.slice(0, 4), buildAnchor(TENANT, DAY, chain));
    const r = await run(["--anchor", f.anchor, "--entries", f.entries]);
    expect(r.code).toBe(1);
    expect(r.err).toContain("FAILED: the entries do not match the anchor");
  });
});

describe("with the day before", () => {
  const all = makeChain(8);
  const day1 = all.slice(0, 5);
  const day2 = all.slice(5);
  const anchor1 = buildAnchor(TENANT, "2026-11-05", day1);
  const anchor2 = buildAnchor(TENANT, "2026-11-06", day2);

  test("the second day is checked to follow the first", async () => {
    const f = files(day2, anchor2);
    const prev = write("prev.json", anchorBody(anchor1));
    const r = await run(["--anchor", f.anchor, "--entries", f.entries, "--previous-anchor", prev]);
    expect(r.code).toBe(0);
    expect(r.out).toContain("It follows the entry before it in the anchor for 2026-11-05.");
  });

  test("without the day before it says the start was not checked", async () => {
    const f = files(day2, anchor2);
    const r = await run(["--anchor", f.anchor, "--entries", f.entries]);
    expect(r.code).toBe(0);
    expect(r.out).toContain("Not checked: that the first entry follows the day before; give --previous-anchor for that.");
  });

  test("the wrong day before does not link", async () => {
    const f = files(day2, anchor2);
    const wrong = write("wrong.json", anchorBody({ ...anchor1, headHash: "b".repeat(64) }));
    const r = await run(["--anchor", f.anchor, "--entries", f.entries, "--previous-anchor", wrong]);
    expect(r.code).toBe(1);
    expect(r.err).toContain("FAILED: entry 6");
  });

  test.each([
    ["another organisation", (a: Anchor) => ({ ...a, tenantId: "99999999-9999-4999-8999-999999999999" })],
    ["a day that does not end where this one starts", (a: Anchor) => ({ ...a, lastSeqNo: "3" })],
  ])("a previous anchor from %s is refused before anything is checked", async (_n, change) => {
    const f = files(day2, anchor2);
    const prev = write("prev.json", anchorBody(change(anchor1)));
    const r = await run(["--anchor", f.anchor, "--entries", f.entries, "--previous-anchor", prev]);
    expect(r.code).toBe(2);
    expect(r.err).toContain("the previous anchor does not lead into this one");
  });
});

describe("with the key", () => {
  test("also proves each entry says what its hash was made from", async () => {
    const f = files(makeChain(3));
    const r = await run(["--anchor", f.anchor, "--entries", f.entries, "--key", `1=${keyFile()}`]);
    expect(r.code).toBe(0);
    expect(r.out).toContain("OK: the 3 entries (numbers 1 to 3) for 2026-11-06 are exactly the ones in the anchor.");
    expect(r.out).toContain("Every entry also matches the hash made from what it says.");
    expect(r.out).not.toContain("Not checked: what each entry says");
  });

  test("catches a changed field that the keyless check cannot see", async () => {
    const chain = makeChain(3);
    const edited = chain.map((e) => ({ ...e }));
    (edited[1] as { action: string }).action = "consent.withdrawn";
    const f = files(edited, buildAnchor(TENANT, DAY, chain));
    expect((await run(["--anchor", f.anchor, "--entries", f.entries])).code).toBe(0);
    const r = await run(["--anchor", f.anchor, "--entries", f.entries, "--key", `1=${keyFile()}`]);
    expect(r.code).toBe(1);
    expect(r.err).toContain("FAILED: entry 2: what it says does not match its hash.");
  });

  test("a wrong key fails the same way, and an entry with a key version that was not given says so", async () => {
    const f = files(makeChain(2));
    const wrong = await run(["--anchor", f.anchor, "--entries", f.entries, "--key", `1=${keyFile(new Uint8Array(32).fill(1))}`]);
    expect(wrong.code).toBe(1);
    expect(wrong.err).toContain("FAILED: entry 1");
    const other = await run(["--anchor", f.anchor, "--entries", f.entries, "--key", `2=${keyFile()}`]);
    expect(other.code).toBe(1);
    expect(other.err).toContain("no key was given for key version 1");
  });

  test.each([
    ["is not hex", "this is not a key"],
    ["is too short", "ab".repeat(16)],
  ])("a key file that %s is refused, and the key is never printed", async (_n, content) => {
    const f = files(makeChain(2));
    const r = await run(["--anchor", f.anchor, "--entries", f.entries, "--key", `1=${write("bad.hex", content)}`]);
    expect(r.code).toBe(2);
    expect(r.err).toContain("must hold 64 hexadecimal characters");
    expect(r.out + r.err).not.toContain(content);
  });
});

describe("bad input", () => {
  test.each([
    ["no arguments", []],
    ["an unknown flag", ["--anchor", "a", "--entries", "b", "--verbose", "x"]],
    ["a flag with no value", ["--anchor"]],
    ["a flag given twice", ["--anchor", "a", "--anchor", "b", "--entries", "c"]],
    ["no entries", ["--anchor", "a"]],
    ["a bad key argument", ["--anchor", "a", "--entries", "b", "--key", "nofile"]],
  ])("%s prints the usage and exits with 2", async (_n, args) => {
    const r = await run(args);
    expect(r.code).toBe(2);
    expect(r.err).toContain("Usage: saral-audit-verify");
  });

  test("a file that is missing, is a directory, or is too big is refused in words", async () => {
    const f = files(makeChain(1));
    const missing = await run(["--anchor", join(dir, "none.json"), "--entries", f.entries]);
    expect(missing.code).toBe(2);
    expect(missing.err).toContain("could not read");
    mkdirSync(join(dir, "folder"));
    const folder = await run(["--anchor", f.anchor, "--entries", join(dir, "folder")]);
    expect(folder.code).toBe(2);
    expect(folder.err).toContain("is not a regular file");
    const huge = write("anchor-big.json", "x".repeat(10_000));
    const big = await run(["--anchor", huge, "--entries", f.entries]);
    expect(big.code).toBe(2);
    expect(big.err).toContain("is larger than");
  });

  test("a symbolic link is read like the file it points to, and a file that is not JSON is refused", async () => {
    const f = files(makeChain(2));
    symlinkSync(f.entries, join(dir, "link.json"));
    expect((await run(["--anchor", f.anchor, "--entries", join(dir, "link.json")])).code).toBe(0);
    const text = write("text.json", "not json");
    const r = await run(["--anchor", f.anchor, "--entries", text]);
    expect(r.code).toBe(2);
    expect(r.err).toContain("is not valid JSON");
  });

  test.each([
    ["entries that are not a list", { entries: [] }, "must be a list of entries"],
    ["an empty list", [], "has no entries"],
    ["an entry that is not an object", [1], "entry 1 is not an object"],
    ["an entry missing a field", [{ tenantId: TENANT }], "entry 1 has no seqNo"],
  ])("%s is refused before any check", async (_n, content, words) => {
    const f = files(makeChain(1));
    const r = await run(["--anchor", f.anchor, "--entries", write("bad-entries.json", content)]);
    expect(r.code).toBe(2);
    expect(r.err).toContain(words);
  });

  test.each([
    ["an anchor that is not an object", "[]", "must be an anchor"],
    ["an anchor with a field missing", JSON.stringify({ version: 1 }), "has no tenantId"],
    ["an anchor of a version this tool does not know", JSON.stringify({ ...buildAnchor(TENANT, DAY, makeChain(1)), version: 2 }), "version 2"],
  ])("%s is refused before any check", async (_n, content, words) => {
    const f = files(makeChain(1));
    const r = await run(["--anchor", write("bad-anchor.json", content), "--entries", f.entries]);
    expect(r.code).toBe(2);
    expect(r.err).toContain(words);
  });
});
