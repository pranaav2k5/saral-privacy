import { canonicalAuditEntry, SUPPORTED_CANONICAL_VERSIONS, type AuditFields } from "@saral/schemas";
import { GENESIS_HASH, entryHash, hashesEqual } from "./hash";

export interface ChainEntry extends AuditFields {
  prevHash: string;
  entryHash: string;
  canonicalSchemaVersion: number;
  hmacSchemaVersion: number;
}

/** Looks up the HMAC key for a key version. Returns undefined for an unknown version. */
export type KeyResolver = (hmacSchemaVersion: number) => Uint8Array | undefined;

export type ChainFailure =
  | "hash_mismatch"
  | "prev_mismatch"
  | "seq_gap"
  | "unknown_key"
  | "unsupported_version"
  | "invalid_fields"
  | "tenant_mismatch";

export type ChainResult =
  | { ok: true; count: number; headHash: string; lastSeqNo: string | null }
  | { ok: false; failure: ChainFailure; seqNo: string };

export interface SealOptions {
  canonicalSchemaVersion?: number;
  hmacSchemaVersion?: number;
}

/** Computes the hash of a new entry that follows `prevHash`. Throws if the fields are invalid. */
export function sealEntry(
  fields: AuditFields,
  prevHash: string,
  key: Uint8Array,
  opts: SealOptions = {},
): ChainEntry {
  const canonicalSchemaVersion = opts.canonicalSchemaVersion ?? 1;
  const hmacSchemaVersion = opts.hmacSchemaVersion ?? 1;
  const canonical = canonicalAuditEntry(fields, canonicalSchemaVersion);
  return {
    ...fields,
    prevHash,
    entryHash: entryHash(key, prevHash, canonical),
    canonicalSchemaVersion,
    hmacSchemaVersion,
  };
}

export interface VerifyOptions {
  /** Hash the first entry must link to. Default: the genesis hash. */
  startPrevHash?: string;
  /** seqNo of the entry just before the first one. Default "0" when starting at genesis, otherwise unchecked. */
  startSeqNo?: string;
}

const DIGITS = /^(0|[1-9][0-9]*)$/;

/**
 * Recomputes every hash in order. Entries must be sorted by seqNo, belong to one tenant, and have
 * contiguous seqNo. This proves the rows were not edited, reordered or removed from the middle. It
 * cannot see rows removed from the end, or a rewrite by someone holding the key: compare against an
 * anchor for that (see `verifyAgainstAnchor`).
 */
export function verifyChain(
  entries: readonly ChainEntry[],
  resolveKey: KeyResolver,
  opts: VerifyOptions = {},
): ChainResult {
  const startPrev = opts.startPrevHash ?? GENESIS_HASH;
  let prev = startPrev;
  let expectedSeq: bigint | null =
    opts.startSeqNo !== undefined && DIGITS.test(opts.startSeqNo)
      ? BigInt(opts.startSeqNo) + 1n
      : opts.startSeqNo === undefined && startPrev === GENESIS_HASH
        ? 1n
        : null;
  const tenant = entries[0]?.tenantId;
  let last: string | null = null;

  for (const e of entries) {
    const fail = (failure: ChainFailure): ChainResult => ({ ok: false, failure, seqNo: e.seqNo });
    if (e.tenantId !== tenant) return fail("tenant_mismatch");
    if (!SUPPORTED_CANONICAL_VERSIONS.includes(e.canonicalSchemaVersion)) return fail("unsupported_version");
    if (typeof e.seqNo !== "string" || !DIGITS.test(e.seqNo)) return fail("invalid_fields");
    const seq = BigInt(e.seqNo);
    if (expectedSeq !== null && seq !== expectedSeq) return fail("seq_gap");
    if (!hashesEqual(e.prevHash, prev)) return fail("prev_mismatch");
    const key = resolveKey(e.hmacSchemaVersion);
    if (key === undefined) return fail("unknown_key");
    let canonical: string;
    try {
      canonical = canonicalAuditEntry(e, e.canonicalSchemaVersion);
    } catch {
      return fail("invalid_fields");
    }
    if (!hashesEqual(entryHash(key, prev, canonical), e.entryHash)) return fail("hash_mismatch");
    prev = e.entryHash;
    expectedSeq = seq + 1n;
    last = e.seqNo;
  }
  return { ok: true, count: entries.length, headHash: prev, lastSeqNo: last };
}
