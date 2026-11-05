import { GENESIS_HASH, entryHash, sealEntry, verifyChain, type ChainEntry } from "./index";
import { KEY, TENANT, fieldsFor, makeChain, resolveKey } from "./test-helpers";

const WRONG_KEY = new Uint8Array(32).fill(9);

function edit(chain: ChainEntry[], i: number, patch: Partial<ChainEntry>): ChainEntry[] {
  return chain.map((e, j) => (j === i ? { ...e, ...patch } : e));
}

describe("sealEntry", () => {
  test("links to the previous hash and records versions", () => {
    const e = sealEntry(fieldsFor(1), GENESIS_HASH, KEY);
    expect(e.prevHash).toBe(GENESIS_HASH);
    expect(e.canonicalSchemaVersion).toBe(1);
    expect(e.hmacSchemaVersion).toBe(1);
    expect(e.entryHash).toMatch(/^[0-9a-f]{64}$/);
  });

  test("rejects invalid fields instead of sealing them", () => {
    expect(() => sealEntry({ ...fieldsFor(1), action: "BAD" }, GENESIS_HASH, KEY)).toThrow();
  });
});

describe("verifyChain", () => {
  test("a five-entry chain verifies and reports its head", () => {
    const chain = makeChain(5);
    const r = verifyChain(chain, resolveKey);
    expect(r).toEqual({ ok: true, count: 5, headHash: chain[4]?.entryHash, lastSeqNo: "5" });
  });

  test("an empty list verifies with the starting hash as head", () => {
    expect(verifyChain([], resolveKey)).toEqual({ ok: true, count: 0, headHash: GENESIS_HASH, lastSeqNo: null });
  });

  test.each([
    ["ts", { ts: "2026-11-06T09:00:59.000Z" }],
    ["actorType", { actorType: "dpo" as const }],
    ["actorId", { actorId: "someone" }],
    ["action", { action: "consent.withdrawn" }],
    ["refTable", { refTable: "dsr_requests" }],
    ["refId", { refId: "00000000-0000-4000-8000-0000000000ff" }],
    ["payloadSha256", { payloadSha256: "f".repeat(64) }],
    ["entryHash", { entryHash: "f".repeat(64) }],
  ])("editing %s of the third entry is reported at seqNo 3", (_name, patch) => {
    const r = verifyChain(edit(makeChain(5), 2, patch as Partial<ChainEntry>), resolveKey);
    expect(r).toEqual({ ok: false, failure: "hash_mismatch", seqNo: "3" });
  });

  test("editing prevHash is reported as prev_mismatch", () => {
    const r = verifyChain(edit(makeChain(5), 3, { prevHash: "e".repeat(64) }), resolveKey);
    expect(r).toEqual({ ok: false, failure: "prev_mismatch", seqNo: "4" });
  });

  test("deleting a middle entry is reported as seq_gap", () => {
    const chain = makeChain(5);
    const r = verifyChain([...chain.slice(0, 2), ...chain.slice(3)], resolveKey);
    expect(r).toEqual({ ok: false, failure: "seq_gap", seqNo: "4" });
  });

  test("swapping two entries is rejected", () => {
    const c = makeChain(4);
    const r = verifyChain([c[0], c[2], c[1], c[3]] as ChainEntry[], resolveKey);
    expect(r.ok).toBe(false);
  });

  test("a repeated entry is rejected", () => {
    const c = makeChain(3);
    expect(verifyChain([c[0], c[1], c[1], c[2]] as ChainEntry[], resolveKey).ok).toBe(false);
  });

  test("a forged entry sealed with the wrong key is a hash_mismatch", () => {
    const chain = makeChain(5);
    const forged = sealEntry({ ...fieldsFor(3), action: "consent.withdrawn" }, chain[1]?.entryHash as string, WRONG_KEY);
    const r = verifyChain([...chain.slice(0, 2), forged, ...chain.slice(3)], resolveKey);
    expect(r).toEqual({ ok: false, failure: "hash_mismatch", seqNo: "3" });
  });

  test("entries from two tenants are rejected", () => {
    const chain = makeChain(3);
    const other = edit(chain, 2, { tenantId: "99999999-9999-4999-8999-999999999999" });
    expect(verifyChain(other, resolveKey)).toEqual({ ok: false, failure: "tenant_mismatch", seqNo: "3" });
  });

  test("an hmacSchemaVersion with no key is unknown_key", () => {
    const chain = makeChain(3);
    expect(verifyChain(edit(chain, 1, { hmacSchemaVersion: 7 }), resolveKey)).toEqual({
      ok: false,
      failure: "unknown_key",
      seqNo: "2",
    });
  });

  test("an unsupported canonical version is unsupported_version", () => {
    const chain = makeChain(3);
    expect(verifyChain(edit(chain, 0, { canonicalSchemaVersion: 2 }), resolveKey)).toEqual({
      ok: false,
      failure: "unsupported_version",
      seqNo: "1",
    });
  });

  test("a malformed field is invalid_fields, not a crash", () => {
    const chain = makeChain(3);
    expect(verifyChain(edit(chain, 1, { action: "NOT VALID" }), resolveKey)).toEqual({
      ok: false,
      failure: "invalid_fields",
      seqNo: "2",
    });
  });

  test("the first entry must follow the starting hash (genesis by default)", () => {
    const later = makeChain(3, KEY, 4, "d".repeat(64));
    expect(verifyChain(later, resolveKey)).toMatchObject({ ok: false });
  });

  test("a later segment verifies when given its starting hash and sequence", () => {
    const whole = makeChain(6);
    const segment = whole.slice(3);
    const r = verifyChain(segment, resolveKey, { startPrevHash: whole[2]?.entryHash, startSeqNo: "3" });
    expect(r).toEqual({ ok: true, count: 3, headHash: whole[5]?.entryHash, lastSeqNo: "6" });
  });

  test("a segment with the wrong starting sequence is a seq_gap", () => {
    const whole = makeChain(6);
    const r = verifyChain(whole.slice(3), resolveKey, { startPrevHash: whole[2]?.entryHash, startSeqNo: "5" });
    expect(r).toEqual({ ok: false, failure: "seq_gap", seqNo: "4" });
  });

  test("seqNo comparison survives values beyond 2^53", () => {
    const base = 9007199254740993n; // 2^53 + 1
    const a = sealEntry({ ...fieldsFor(1), seqNo: String(base) }, GENESIS_HASH, KEY);
    const b = sealEntry({ ...fieldsFor(2), seqNo: String(base + 1n) }, a.entryHash, KEY);
    expect(verifyChain([a, b], resolveKey, { startPrevHash: GENESIS_HASH, startSeqNo: String(base - 1n) })).toMatchObject({
      ok: true,
      count: 2,
    });
  });

  test("an entry hash is exactly HMAC over prevHash || canonical (no extra fields)", () => {
    const e = makeChain(1)[0] as ChainEntry;
    expect(e.entryHash).toBe(
      entryHash(KEY, GENESIS_HASH, JSON.stringify(["saral.audit", 1, TENANT, "1", e.ts, "system", null, "consent.granted", "consent_records", e.refId, e.payloadSha256])),
    );
  });
});
