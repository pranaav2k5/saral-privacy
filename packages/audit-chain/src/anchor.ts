import { GENESIS_HASH, hashesEqual, isHash } from "./hash";
import { merkleRoot } from "./merkle";
import { verifyChain, type ChainEntry, type ChainResult, type KeyResolver, type VerifyOptions } from "./chain";

/** What the nightly job writes to S3 (Object Lock) for one tenant and one day. */
export interface Anchor {
  version: 1;
  tenantId: string;
  /** Label chosen by the job (YYYY-MM-DD). Which rows belong to a day is the job's decision. */
  date: string;
  count: number;
  firstSeqNo: string;
  lastSeqNo: string;
  headHash: string;
  merkleRoot: string;
}

export type AnchorResult = ChainResult | { ok: false; failure: "anchor_mismatch"; seqNo: string };

const DATE = /^\d{4}-\d{2}-\d{2}$/;

export function buildAnchor(tenantId: string, date: string, entries: readonly ChainEntry[]): Anchor {
  const first = entries[0];
  const last = entries[entries.length - 1];
  if (first === undefined || last === undefined) throw new Error("cannot anchor an empty list of entries");
  if (!DATE.test(date) || Number.isNaN(Date.parse(`${date}T00:00:00Z`))) throw new Error("date must be YYYY-MM-DD");
  if (entries.some((e) => e.tenantId !== tenantId)) throw new Error("every entry must belong to the anchor's tenant");
  return {
    version: 1,
    tenantId,
    date,
    count: entries.length,
    firstSeqNo: first.seqNo,
    lastSeqNo: last.seqNo,
    headHash: last.entryHash,
    merkleRoot: merkleRoot(entries.map((e) => e.entryHash)),
  };
}

/** The exact bytes stored in S3: fixed key order, compact JSON, one trailing newline. */
export function anchorBody(anchor: Anchor): string {
  return (
    JSON.stringify({
      version: anchor.version,
      tenantId: anchor.tenantId,
      date: anchor.date,
      count: anchor.count,
      firstSeqNo: anchor.firstSeqNo,
      lastSeqNo: anchor.lastSeqNo,
      headHash: anchor.headHash,
      merkleRoot: anchor.merkleRoot,
    }) + "\n"
  );
}

/** Verifies the chain, then checks it against the anchor: this is what catches truncation and key-holder rewrites. */
export function verifyAgainstAnchor(
  entries: readonly ChainEntry[],
  anchor: Anchor,
  resolveKey: KeyResolver,
  opts: VerifyOptions = {},
): AnchorResult {
  const chain = verifyChain(entries, resolveKey, opts);
  if (!chain.ok) return chain;
  const mismatch: AnchorResult = { ok: false, failure: "anchor_mismatch", seqNo: chain.lastSeqNo ?? anchor.firstSeqNo };
  if (anchor.version !== 1 || entries.length === 0) return mismatch;
  const first = entries[0] as ChainEntry;
  if (
    first.tenantId !== anchor.tenantId ||
    chain.count !== anchor.count ||
    first.seqNo !== anchor.firstSeqNo ||
    chain.lastSeqNo !== anchor.lastSeqNo ||
    !hashesEqual(chain.headHash, anchor.headHash) ||
    !hashesEqual(merkleRoot(entries.map((e) => e.entryHash)), anchor.merkleRoot)
  ) {
    return mismatch;
  }
  return chain;
}

const DIGITS = /^[0-9]{1,30}$/;

/**
 * Checks entries against an anchor WITHOUT the HMAC key, which is what an outside auditor has. It proves the entries are
 * exactly the ones the anchor was made from, in order, with every link intact: same organisation, contiguous sequence
 * numbers, each entry pointing at the hash of the one before, and the count, first and last numbers, head hash and Merkle
 * root all equal to the anchor's. A removed, added, reordered or replaced entry fails.
 *
 * What it cannot see is a changed field (an action, a time) that leaves the stored hashes alone, because recomputing a hash
 * needs the key. `verifyAgainstAnchor` does that. `startPrevHash` is the head of the day before, from that day's anchor;
 * without it a day that does not start at sequence number 1 is not checked against what came before it.
 */
export function verifyLinksAgainstAnchor(entries: readonly ChainEntry[], anchor: Anchor, opts: { startPrevHash?: string } = {}): AnchorResult {
  const mismatch = (seqNo: string): AnchorResult => ({ ok: false, failure: "anchor_mismatch", seqNo });
  if (anchor.version !== 1 || entries.length === 0) return mismatch(anchor.firstSeqNo);
  let prev: string | undefined = opts.startPrevHash ?? (anchor.firstSeqNo === "1" ? GENESIS_HASH : undefined);
  let expected: bigint | null = null;
  for (const e of entries) {
    const fail = (failure: "invalid_fields" | "tenant_mismatch" | "seq_gap" | "prev_mismatch"): AnchorResult => ({ ok: false, failure, seqNo: String(e.seqNo) });
    if (e.tenantId !== anchor.tenantId) return fail("tenant_mismatch");
    if (typeof e.seqNo !== "string" || !DIGITS.test(e.seqNo) || typeof e.prevHash !== "string" || typeof e.entryHash !== "string" || !isHash(e.prevHash) || !isHash(e.entryHash)) {
      return fail("invalid_fields");
    }
    const seq = BigInt(e.seqNo);
    if (expected !== null && seq !== expected) return fail("seq_gap");
    if (prev !== undefined && !hashesEqual(e.prevHash, prev)) return fail("prev_mismatch");
    prev = e.entryHash;
    expected = seq + 1n;
  }
  const first = entries[0] as ChainEntry;
  const last = entries[entries.length - 1] as ChainEntry;
  if (
    entries.length !== anchor.count ||
    first.seqNo !== anchor.firstSeqNo ||
    last.seqNo !== anchor.lastSeqNo ||
    !hashesEqual(last.entryHash, anchor.headHash) ||
    !hashesEqual(merkleRoot(entries.map((e) => e.entryHash)), anchor.merkleRoot)
  ) {
    return mismatch(last.seqNo);
  }
  return { ok: true, count: entries.length, headHash: last.entryHash, lastSeqNo: last.seqNo };
}
