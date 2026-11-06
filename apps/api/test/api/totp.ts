import { createHmac } from "node:crypto";

// An independent HOTP in the test (RFC 4226), so the TOTP the API checks is not computed by the code under test.
function b32(text: string): Buffer {
  const alphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";
  let bits = 0, value = 0;
  const out: number[] = [];
  for (const ch of text.replace(/=/g, "")) {
    value = (value << 5) | alphabet.indexOf(ch);
    bits += 5;
    if (bits >= 8) { out.push((value >>> (bits - 8)) & 255); bits -= 8; }
  }
  return Buffer.from(out);
}
export function totpAt(secret: string, ms: number): string {
  const msg = Buffer.alloc(8);
  msg.writeBigUInt64BE(BigInt(Math.floor(ms / 30000)));
  const h = createHmac("sha1", b32(secret)).update(msg).digest();
  const o = (h[h.length - 1] as number) & 15;
  const bin = (((h[o] as number) & 0x7f) << 24) | ((h[o + 1] as number) << 16) | ((h[o + 2] as number) << 8) | (h[o + 3] as number);
  return String(bin % 1_000_000).padStart(6, "0");
}
