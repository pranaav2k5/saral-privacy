import { createHash, createHmac, timingSafeEqual } from "node:crypto";

/** `prevHash` of the first entry of a tenant's chain. */
export const GENESIS_HASH = "0".repeat(64);

const HEX64 = /^[0-9a-f]{64}$/;
const MIN_KEY_BYTES = 32;

/** True for a 64-character lowercase hex string (a SHA-256 or HMAC-SHA256 digest). */
export function isHash(value: string): boolean {
  return HEX64.test(value);
}

export function sha256Hex(data: string | Uint8Array): string {
  return createHash("sha256").update(data).digest("hex");
}

/** HMAC-SHA256 over `prevHash || canonical` (UTF-8), lowercase hex. prevHash has a fixed width, so the join is unambiguous. */
export function entryHash(key: Uint8Array, prevHash: string, canonical: string): string {
  if (key.length < MIN_KEY_BYTES) {
    throw new Error(`HMAC key must be at least ${String(MIN_KEY_BYTES)} bytes`);
  }
  if (!isHash(prevHash)) throw new Error("prevHash must be 64 lowercase hex characters");
  return createHmac("sha256", key).update(prevHash).update(canonical).digest("hex");
}

/** Constant-time comparison of two hex digests. Returns false when either is not a valid digest. */
export function hashesEqual(a: string, b: string): boolean {
  if (!isHash(a) || !isHash(b)) return false;
  return timingSafeEqual(Buffer.from(a, "hex"), Buffer.from(b, "hex"));
}
