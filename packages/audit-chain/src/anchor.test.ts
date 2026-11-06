import { GENESIS_HASH, anchorBody, buildAnchor, merkleRoot, sealEntry, verifyAgainstAnchor, verifyChain, type Anchor, type ChainEntry } from "./index";
import { KEY, TENANT, fieldsFor, makeChain, resolveKey } from "./test-helpers";

describe("buildAnchor", () => {
  test("summarises a day of entries", () => {
    const chain = makeChain(4);
    const a = buildAnchor(TENANT, "2026-11-06", chain);
    expect(a).toEqual({
      version: 1,
      tenantId: TENANT,
      date: "2026-11-06",
      count: 4,
      firstSeqNo: "1",
      lastSeqNo: "4",
      headHash: chain[3]?.entryHash,
      merkleRoot: merkleRoot(chain.map((e) => e.entryHash)),
    });
  });

  test.each([["empty list", [] as ChainEntry[], "2026-11-06"], ["bad date", makeChain(1), "06-11-2026"]])(
    "rejects %s",
    (_n, entries, date) => {
      expect(() => buildAnchor(TENANT, date, entries)).toThrow();
    },
  );

  test("rejects entries that belong to another tenant", () => {
    expect(() => buildAnchor("99999999-9999-4999-8999-999999999999", "2026-11-06", makeChain(2))).toThrow(/tenant/);
  });
});

describe("anchorBody", () => {
  test("is byte-stable: fixed key order, compact JSON, trailing newline", () => {
    const a: Anchor = {
      version: 1,
      tenantId: TENANT,
      date: "2026-11-06",
      count: 3,
      firstSeqNo: "1",
      lastSeqNo: "3",
      headHash: "a".repeat(64),
      merkleRoot: "b".repeat(64),
    };
    expect(anchorBody(a)).toBe(
      `{"version":1,"tenantId":"${TENANT}","date":"2026-11-06","count":3,"firstSeqNo":"1","lastSeqNo":"3",` +
        `"headHash":"${"a".repeat(64)}","merkleRoot":"${"b".repeat(64)}"}\n`,
    );
  });

  test("ignores the property order of the input object", () => {
    const a = buildAnchor(TENANT, "2026-11-06", makeChain(2));
    const shuffled = Object.fromEntries(Object.entries(a).reverse()) as unknown as Anchor;
    expect(anchorBody(shuffled)).toBe(anchorBody(a));
  });
});

describe("verifyAgainstAnchor", () => {
  test("a clean chain matches its anchor", () => {
    const chain = makeChain(6);
    const anchor = buildAnchor(TENANT, "2026-11-06", chain);
    expect(verifyAgainstAnchor(chain, anchor, resolveKey)).toMatchObject({ ok: true, count: 6 });
  });

  test("dropping the newest entry passes verifyChain alone but fails against the anchor", () => {
    const chain = makeChain(6);
    const anchor = buildAnchor(TENANT, "2026-11-06", chain);
    const truncated = chain.slice(0, 5);
    expect(verifyChain(truncated, resolveKey).ok).toBe(true);
    expect(verifyAgainstAnchor(truncated, anchor, resolveKey)).toMatchObject({ ok: false, failure: "anchor_mismatch" });
  });

  test("rewriting history with the real key is caught by the anchor", () => {
    const chain = makeChain(6);
    const anchor = buildAnchor(TENANT, "2026-11-06", chain);
    // An attacker holding the HMAC key edits entry 3 and re-seals everything after it.
    const forged: ChainEntry[] = chain.slice(0, 2);
    let prev = forged[1]?.entryHash as string;
    for (let seq = 3; seq <= 6; seq++) {
      const f = seq === 3 ? { ...fieldsFor(seq), action: "consent.withdrawn" } : fieldsFor(seq);
      const e = sealEntry(f, prev, KEY);
      forged.push(e);
      prev = e.entryHash;
    }
    expect(verifyChain(forged, resolveKey).ok).toBe(true);
    expect(verifyAgainstAnchor(forged, anchor, resolveKey)).toMatchObject({ ok: false, failure: "anchor_mismatch" });
  });

  test("a chain failure is reported as the chain failure", () => {
    const chain = makeChain(4);
    const anchor = buildAnchor(TENANT, "2026-11-06", chain);
    const bad = chain.map((e, i) => (i === 1 ? { ...e, action: "consent.withdrawn" } : e));
    expect(verifyAgainstAnchor(bad, anchor, resolveKey)).toEqual({ ok: false, failure: "hash_mismatch", seqNo: "2" });
  });

  test("a wrong count, head or tenant in the anchor fails", () => {
    const chain = makeChain(3);
    const anchor = buildAnchor(TENANT, "2026-11-06", chain);
    for (const bad of [
      { ...anchor, count: 4 },
      { ...anchor, headHash: GENESIS_HASH },
      { ...anchor, merkleRoot: GENESIS_HASH },
      { ...anchor, firstSeqNo: "2" },
      { ...anchor, tenantId: "99999999-9999-4999-8999-999999999999" },
    ]) {
      expect(verifyAgainstAnchor(chain, bad, resolveKey)).toMatchObject({ ok: false, failure: "anchor_mismatch" });
    }
  });

  test("a day that continues an earlier day verifies with its starting hash", () => {
    const whole = makeChain(8);
    const day2 = whole.slice(4);
    const anchor = buildAnchor(TENANT, "2026-11-07", day2);
    expect(
      verifyAgainstAnchor(day2, anchor, resolveKey, { startPrevHash: whole[3]?.entryHash, startSeqNo: "4" }),
    ).toMatchObject({ ok: true, count: 4 });
  });
});
