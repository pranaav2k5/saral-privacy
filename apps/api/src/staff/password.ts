import { randomBytes, scrypt, timingSafeEqual } from "node:crypto";
import { promisify } from "node:util";

const scryptAsync = promisify(scrypt) as (password: string, salt: Buffer, keylen: number, options: { N: number; r: number; p: number; maxmem: number }) => Promise<Buffer>;

// Pinned parameters (about 32 MiB of memory, a few tens of milliseconds): a stored hash with weaker ones is refused, so a
// tampered record cannot make verification cheap. Raise them by adding a new version, never by editing these.
const N = 32768;
const R = 8;
const P = 1;
const KEYLEN = 64;
const SALT_BYTES = 16;
const MAXMEM = 128 * 1024 * 1024;

export const PASSWORD_MIN = 12;
export const PASSWORD_MAX = 128;

const derive = (password: string, salt: Buffer): Promise<Buffer> => scryptAsync(password.normalize("NFKC"), salt, KEYLEN, { N, r: R, p: P, maxmem: MAXMEM });

/** `scrypt$N$r$p$<salt>$<hash>`, base64url. The password is NFKC-normalised first so the same text always hashes the same. */
export async function hashPassword(password: string): Promise<string> {
  const salt = randomBytes(SALT_BYTES);
  const hash = await derive(password, salt);
  return `scrypt$${String(N)}$${String(R)}$${String(P)}$${salt.toString("base64url")}$${hash.toString("base64url")}`;
}

export async function verifyPassword(password: string, stored: string): Promise<boolean> {
  const parts = stored.split("$");
  if (parts.length !== 6 || parts[0] !== "scrypt" || parts[1] !== String(N) || parts[2] !== String(R) || parts[3] !== String(P)) return false;
  const salt = Buffer.from(parts[4] as string, "base64url");
  const expected = Buffer.from(parts[5] as string, "base64url");
  if (salt.length !== SALT_BYTES || expected.length !== KEYLEN || salt.toString("base64url") !== parts[4]) return false;
  return timingSafeEqual(await derive(password, salt), expected);
}

/** Returns a plain-words problem, or null when the password is acceptable. */
export function checkPasswordPolicy(password: string, email: string): string | null {
  if (password.length < PASSWORD_MIN) return `must be at least ${String(PASSWORD_MIN)} characters`;
  if (password.length > PASSWORD_MAX) return `must be at most ${String(PASSWORD_MAX)} characters`;
  const lower = password.toLowerCase();
  const mail = email.toLowerCase();
  if (lower === mail || lower === mail.split("@")[0]) return "must not be your email address";
  if (new Set(password).size === 1) return "must not be one character repeated";
  return null;
}
