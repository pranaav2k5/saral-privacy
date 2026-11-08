import { GENESIS_HASH, buildAnchor, merkleRoot, verifyAgainstAnchor, verifyLinksAgainstAnchor, type Anchor, type ChainEntry } from "./index";
import { KEY, TENANT, makeChain, resolveKey } from "./test-helpers";

const DAY = "2026-11-06";
const clone = (c: ChainEntry[]): ChainEntry[] => c.map((e) => ({ ...e }));
const HASH_A = "a".repeat(64);

describe("verifyLinksAgainstAnchor: what an auditor can check without the HMAC key", () => {
  test("accepts a day of entries that is exactly what the anchor describes", () => {
    const chain = makeChain(5);
    const r = verifyLinksAgainstAnchor(chain, buildAnchor(TENANT, DAY, chain));
    expect(r).toEqual({ ok: true, count: 5, headHash: chain[4]?.entryHash, lastSeqNo: "5" });
  });

  test("accepts a later day when it is told which entry came just before (the previous day's head)", () => {
    const all = makeChain(8);
    const day2 = all.slice(5);
    const anchor = buildAnchor(TENANT, "2026-11-07", day2);
    expect(verifyLinksAgainstAnchor(day2, anchor, { startPrevHash: all[4]?.entryHash as string }).ok).toBe(true);
  });

  test("a later day told the wrong previous head does not link", () => {
    const all = makeChain(8);
    const day2 = all.slice(5);
    const r = verifyLinksAgainstAnchor(day2, buildAnchor(TENANT, "2026-11-07", day2), { startPrevHash: HASH_A });
    expect(r).toEqual({ ok: false, failure: "prev_mismatch", seqNo: "6" });
  });

  test("a later day told nothing about the previous head is still checked inside itself", () => {
    const all = makeChain(8);
    const day2 = all.slice(5);
    expect(verifyLinksAgainstAnchor(day2, buildAnchor(TENANT, "2026-11-07", day2)).ok).toBe(true);
  });

  test("the first day must start at the genesis hash", () => {
    const chain = makeChain(3);
    const forged = clone(chain);
    (forged[0] as { prevHash: string }).prevHash = HASH_A;
    const r = verifyLinksAgainstAnchor(forged, buildAnchor(TENANT, DAY, chain));
    expect(r).toEqual({ ok: false, failure: "prev_mismatch", seqNo: "1" });
    expect((chain[0] as ChainEntry).prevHash).toBe(GENESIS_HASH);
  });

  test("an entry removed from the middle leaves a gap", () => {
    const chain = makeChain(5);
    const r = verifyLinksAgainstAnchor([...chain.slice(0, 2), ...chain.slice(3)], buildAnchor(TENANT, DAY, chain));
    expect(r).toEqual({ ok: false, failure: "seq_gap", seqNo: "4" });
  });

  test("entries cut off at the end no longer match the anchor", () => {
    const chain = makeChain(5);
    const r = verifyLinksAgainstAnchor(chain.slice(0, 4), buildAnchor(TENANT, DAY, chain));
    expect(r).toMatchObject({ ok: false, failure: "anchor_mismatch" });
  });

  test("an entry added at the end no longer matches the anchor", () => {
    const chain = makeChain(6);
    const r = verifyLinksAgainstAnchor(chain, buildAnchor(TENANT, DAY, chain.slice(0, 5)));
    expect(r).toMatchObject({ ok: false, failure: "anchor_mismatch" });
  });

  test("entries in a different order do not link", () => {
    const chain = makeChain(4);
    const r = verifyLinksAgainstAnchor([chain[0], chain[2], chain[1], chain[3]] as ChainEntry[], buildAnchor(TENANT, DAY, chain));
    expect(r.ok).toBe(false);
  });

  test("a whole chain rewritten with another key links inside itself but is not what the anchor holds", () => {
    const honest = makeChain(4);
    const rewritten = makeChain(4, new Uint8Array(32).fill(9));
    const r = verifyLinksAgainstAnchor(rewritten, buildAnchor(TENANT, DAY, honest));
    expect(r).toMatchObject({ ok: false, failure: "anchor_mismatch" });
  });

  test("a changed entry hash breaks the link to the entry after it, or the anchor when it is the last", () => {
    const chain = makeChain(4);
    const anchor = buildAnchor(TENANT, DAY, chain);
    const middle = clone(chain);
    (middle[1] as { entryHash: string }).entryHash = HASH_A;
    expect(verifyLinksAgainstAnchor(middle, anchor)).toEqual({ ok: false, failure: "prev_mismatch", seqNo: "3" });
    const last = clone(chain);
    (last[3] as { entryHash: string }).entryHash = HASH_A;
    expect(verifyLinksAgainstAnchor(last, anchor)).toMatchObject({ ok: false, failure: "anchor_mismatch" });
  });

  test("an entry of another organisation is refused", () => {
    const chain = makeChain(3);
    const mixed = clone(chain);
    (mixed[1] as { tenantId: string }).tenantId = "99999999-9999-4999-8999-999999999999";
    expect(verifyLinksAgainstAnchor(mixed, buildAnchor(TENANT, DAY, chain))).toEqual({ ok: false, failure: "tenant_mismatch", seqNo: "2" });
  });

  test("an anchor for another organisation does not match", () => {
    const chain = makeChain(3);
    const other: Anchor = { ...buildAnchor(TENANT, DAY, chain), tenantId: "99999999-9999-4999-8999-999999999999" };
    expect(verifyLinksAgainstAnchor(chain, other)).toMatchObject({ ok: false });
  });

  test.each([
    ["a sequence number that is not digits", (e: { seqNo: string }) => (e.seqNo = "1x")],
    ["an entry hash that is not a hash", (e: { entryHash: string }) => (e.entryHash = "nothex")],
    ["a previous hash that is not a hash", (e: { prevHash: string }) => (e.prevHash = "A".repeat(64))],
  ])("%s is invalid", (_n, change) => {
    const chain = makeChain(3);
    const bad = clone(chain);
    change(bad[1] as never);
    expect(verifyLinksAgainstAnchor(bad, buildAnchor(TENANT, DAY, chain))).toEqual({ ok: false, failure: "invalid_fields", seqNo: expect.any(String) });
  });

  test("an anchor whose count disagrees with its own sequence numbers is not trusted", () => {
    const chain = makeChain(4);
    const anchor = { ...buildAnchor(TENANT, DAY, chain), count: 5 };
    expect(verifyLinksAgainstAnchor(chain, anchor)).toMatchObject({ ok: false, failure: "anchor_mismatch" });
  });

  test("nothing to check is not a pass", () => {
    const chain = makeChain(2);
    expect(verifyLinksAgainstAnchor([], buildAnchor(TENANT, DAY, chain))).toMatchObject({ ok: false, failure: "anchor_mismatch" });
  });

  test("an anchor of an unknown version is not trusted", () => {
    const chain = makeChain(2);
    const anchor = { ...buildAnchor(TENANT, DAY, chain), version: 2 } as unknown as Anchor;
    expect(verifyLinksAgainstAnchor(chain, anchor)).toMatchObject({ ok: false, failure: "anchor_mismatch" });
  });

  test("checks the Merkle root as well as the head, so a swapped middle entry is caught even when the ends are kept", () => {
    const chain = makeChain(5);
    const anchor = buildAnchor(TENANT, DAY, chain);
    const swapped = clone(chain);
    // Re-link the neighbours around a different middle hash so every link, the count and the head still hold.
    (swapped[2] as { entryHash: string }).entryHash = HASH_A;
    (swapped[3] as { prevHash: string }).prevHash = HASH_A;
    const r = verifyLinksAgainstAnchor(swapped, anchor);
    expect(r).toMatchObject({ ok: false, failure: "anchor_mismatch" });
    expect(merkleRoot(swapped.map((e) => e.entryHash))).not.toBe(anchor.merkleRoot);
  });

  test("its limit: without the key a changed field that keeps the stored hashes passes, and the keyed check catches it", () => {
    const chain = makeChain(3);
    const anchor = buildAnchor(TENANT, DAY, chain);
    const edited = clone(chain);
    (edited[1] as { action: string }).action = "consent.withdrawn";
    expect(verifyLinksAgainstAnchor(edited, anchor).ok).toBe(true);
    expect(verifyAgainstAnchor(edited, anchor, resolveKey)).toEqual({ ok: false, failure: "hash_mismatch", seqNo: "2" });
    expect(verifyAgainstAnchor(chain, anchor, (v) => (v === 1 ? KEY : undefined)).ok).toBe(true);
  });
});
