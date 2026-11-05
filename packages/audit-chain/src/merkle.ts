import { createHash } from "node:crypto";
import { isHash } from "./hash";

/**
 * RFC 6962 Merkle tree over 32-byte leaves (entry hashes).
 * Leaf hash = SHA-256(0x00 || leaf), node hash = SHA-256(0x01 || left || right). The prefixes stop an
 * inner node from passing as a leaf, and the unbalanced split (no duplicated last leaf) stops
 * [a,b,c] and [a,b,c,c] from sharing a root.
 */

const sha = (...parts: Uint8Array[]): Buffer => {
  const h = createHash("sha256");
  for (const p of parts) h.update(p);
  return h.digest();
};
const LEAF_PREFIX = Uint8Array.of(0);
const NODE_PREFIX = Uint8Array.of(1);

function leafHash(hex: string): Buffer {
  if (!isHash(hex)) throw new Error("leaf must be 64 lowercase hex characters");
  return sha(LEAF_PREFIX, Buffer.from(hex, "hex"));
}

const nodeHash = (l: Uint8Array, r: Uint8Array): Buffer => sha(NODE_PREFIX, l, r);

/** Largest power of two strictly below n (n > 1). */
function split(n: number): number {
  let k = 1;
  while (k * 2 < n) k *= 2;
  return k;
}

function mth(h: readonly Buffer[], lo: number, hi: number): Buffer {
  const n = hi - lo;
  if (n === 1) return h[lo] as Buffer;
  const k = split(n);
  return nodeHash(mth(h, lo, lo + k), mth(h, lo + k, hi));
}

export function merkleRoot(leafHashes: readonly string[]): string {
  if (leafHashes.length === 0) return sha().toString("hex");
  const h = leafHashes.map(leafHash);
  return mth(h, 0, h.length).toString("hex");
}

function path(h: readonly Buffer[], lo: number, hi: number, m: number, out: string[]): void {
  const n = hi - lo;
  if (n === 1) return;
  const k = split(n);
  if (m < k) {
    path(h, lo, lo + k, m, out);
    out.push(mth(h, lo + k, hi).toString("hex"));
  } else {
    path(h, lo + k, hi, m - k, out);
    out.push(mth(h, lo, lo + k).toString("hex"));
  }
}

/** Audit path for the leaf at `index`, ordered from the leaf up to the root. */
export function merkleProof(leafHashes: readonly string[], index: number): string[] {
  if (!Number.isInteger(index) || index < 0 || index >= leafHashes.length) {
    throw new Error("index out of range");
  }
  const h = leafHashes.map(leafHash);
  const out: string[] = [];
  path(h, 0, h.length, index, out);
  return out;
}

/**
 * RFC 9162 section 2.1.3.2. Returns false (never throws) for any malformed input.
 * A proof ties the leaf to the root. `size` only shapes the path, so two sizes with the same path
 * shape accept the same proof; pin the size separately (the anchor's `count` does this).
 */
export function verifyMerkleProof(
  root: string,
  leafHashHex: string,
  index: number,
  size: number,
  proof: readonly string[],
): boolean {
  if (!isHash(root) || !isHash(leafHashHex)) return false;
  if (!Number.isInteger(index) || !Number.isInteger(size) || size < 1 || index < 0 || index >= size) return false;
  if (!proof.every(isHash)) return false;
  let fn = index;
  let sn = size - 1;
  let r = leafHash(leafHashHex);
  for (const p of proof) {
    if (sn === 0) return false;
    const sibling = Buffer.from(p, "hex");
    if (fn % 2 === 1 || fn === sn) {
      r = nodeHash(sibling, r);
      if (fn % 2 === 0) {
        while (fn % 2 === 0 && fn !== 0) {
          fn = Math.floor(fn / 2);
          sn = Math.floor(sn / 2);
        }
      }
    } else {
      r = nodeHash(r, sibling);
    }
    fn = Math.floor(fn / 2);
    sn = Math.floor(sn / 2);
  }
  return sn === 0 && r.toString("hex") === root;
}
