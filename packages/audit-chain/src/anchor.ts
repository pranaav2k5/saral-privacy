import { hashesEqual } from "./hash";
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
