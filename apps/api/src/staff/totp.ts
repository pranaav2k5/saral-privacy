import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";

const ALPHABET = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";
const STEP_SECONDS = 30;
const DIGITS = 6;
const CODE = /^[0-9]{6}$/;

/** RFC 4648 Base32 without padding. */
export function base32Encode(bytes: Uint8Array): string {
  let bits = 0;
  let value = 0;
  let out = "";
  for (const b of bytes) {
    value = (value << 8) | b;
    bits += 8;
    while (bits >= 5) {
      out += ALPHABET[(value >>> (bits - 5)) & 31];
      bits -= 5;
    }
  }
  if (bits > 0) out += ALPHABET[(value << (5 - bits)) & 31];
  return out;
}

/** Case-insensitive; ignores spaces, dashes and padding. Anything outside the alphabet throws. */
export function base32Decode(text: string): Uint8Array {
  const clean = text.toUpperCase().replace(/[\s=-]/g, "");
  let bits = 0;
  let value = 0;
  const out: number[] = [];
  for (const ch of clean) {
    const i = ALPHABET.indexOf(ch);
    if (i < 0) throw new Error("not a Base32 string");
    value = (value << 5) | i;
    bits += 5;
    if (bits >= 8) {
      out.push((value >>> (bits - 8)) & 255);
      bits -= 8;
    }
  }
  return new Uint8Array(out);
}

/** RFC 4226 HOTP with SHA-1 and six digits. */
export function hotp(secret: Uint8Array, counter: bigint): string {
  const msg = Buffer.alloc(8);
  msg.writeBigUInt64BE(counter);
  const h = createHmac("sha1", secret).update(msg).digest();
  const offset = (h[h.length - 1] as number) & 0xf;
  const bin = (((h[offset] as number) & 0x7f) << 24) | ((h[offset + 1] as number) << 16) | ((h[offset + 2] as number) << 8) | (h[offset + 3] as number);
  return String(bin % 10 ** DIGITS).padStart(DIGITS, "0");
}

export type TotpResult = { ok: true; step: bigint } | { ok: false };

/**
 * RFC 6238 TOTP: 30 second steps, one step of clock drift either way. `lastStep` is the newest step already accepted for
 * this account: a code from that step or an older one is refused, so a code works once (replay protection).
 */
export function verifyTotp(secret: Uint8Array, code: string, nowMs: number, lastStep: bigint): TotpResult {
  if (!CODE.test(code)) return { ok: false };
  const current = BigInt(Math.floor(nowMs / 1000 / STEP_SECONDS));
  const given = Buffer.from(code);
  let accepted: bigint | undefined;
  for (const step of [current - 1n, current, current + 1n]) {
    const expected = Buffer.from(hotp(secret, step));
    // Every candidate is compared, so the time taken does not show which step matched.
    if (timingSafeEqual(given, expected) && step > lastStep && accepted === undefined) accepted = step;
  }
  return accepted === undefined ? { ok: false } : { ok: true, step: accepted };
}

export const generateTotpSecret = (): Uint8Array => new Uint8Array(randomBytes(20));

/** The link an authenticator app scans as a QR code. */
export function otpauthUrl(secret: Uint8Array, issuer: string, account: string): string {
  return `otpauth://totp/${encodeURIComponent(issuer)}:${encodeURIComponent(account)}?secret=${base32Encode(secret)}&issuer=${encodeURIComponent(issuer)}&algorithm=SHA1&digits=${String(DIGITS)}&period=${String(STEP_SECONDS)}`;
}
