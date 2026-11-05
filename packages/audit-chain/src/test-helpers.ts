import type { AuditFields } from "@saral/schemas";
import { GENESIS_HASH, sealEntry, sha256Hex, type ChainEntry } from "./index";

export const TENANT = "11111111-1111-4111-8111-111111111111";
export const KEY = new Uint8Array(32).fill(7);
export const resolveKey = (v: number): Uint8Array | undefined => (v === 1 ? KEY : undefined);

function uuidFor(n: number): string {
  return `00000000-0000-4000-8000-${n.toString(16).padStart(12, "0")}`;
}

export function fieldsFor(seq: number): AuditFields {
  return {
    tenantId: TENANT,
    seqNo: String(seq),
    ts: new Date(Date.UTC(2026, 10, 6, 9, 0, seq)).toISOString(),
    actorType: "system",
    actorId: null,
    action: "consent.granted",
    refTable: "consent_records",
    refId: uuidFor(seq),
    payloadSha256: sha256Hex(`payload-${String(seq)}`),
  };
}

/** Builds a valid chain of `n` entries starting at seqNo `first` after `prevHash`. */
export function makeChain(n: number, key: Uint8Array = KEY, first = 1, prevHash = GENESIS_HASH): ChainEntry[] {
  const out: ChainEntry[] = [];
  let prev = prevHash;
  for (let i = 0; i < n; i++) {
    const e = sealEntry(fieldsFor(first + i), prev, key);
    out.push(e);
    prev = e.entryHash;
  }
  return out;
}
