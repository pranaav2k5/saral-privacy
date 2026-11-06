import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";

const VERSION = 1;
const NONCE_BYTES = 12;
const TAG_BYTES = 16;

function checkKey(key: Uint8Array): void {
  if (key.length !== 32) throw new Error("contact key must be 32 bytes");
}

/** Binds a sealed contact to its row: moved to another tenant or person it no longer decrypts. */
const aad = (tenantId: string, principalId: string): Buffer => Buffer.from(`${tenantId}:${principalId}`, "utf8");

/**
 * AES-256-GCM. Layout: version byte (1), 12-byte random nonce, ciphertext, 16-byte tag. This is the only place a raw
 * phone number or email address is kept at rest, and only so a data protection officer can answer a rights request.
 */
export function encryptContact(key: Uint8Array, tenantId: string, principalId: string, contact: string): Uint8Array {
  checkKey(key);
  const nonce = randomBytes(NONCE_BYTES);
  const cipher = createCipheriv("aes-256-gcm", key, nonce);
  cipher.setAAD(aad(tenantId, principalId));
  const body = Buffer.concat([cipher.update(contact, "utf8"), cipher.final()]);
  return new Uint8Array(Buffer.concat([Buffer.from([VERSION]), nonce, body, cipher.getAuthTag()]));
}

export function decryptContact(key: Uint8Array, tenantId: string, principalId: string, sealed: Uint8Array): string {
  checkKey(key);
  if (sealed.length < 1 + NONCE_BYTES + TAG_BYTES) throw new Error("sealed contact is too short");
  if (sealed[0] !== VERSION) throw new Error(`unsupported contact encryption version ${String(sealed[0])}`);
  const buf = Buffer.from(sealed);
  const decipher = createDecipheriv("aes-256-gcm", key, buf.subarray(1, 1 + NONCE_BYTES));
  decipher.setAAD(aad(tenantId, principalId));
  decipher.setAuthTag(buf.subarray(buf.length - TAG_BYTES));
  return Buffer.concat([decipher.update(buf.subarray(1 + NONCE_BYTES, buf.length - TAG_BYTES)), decipher.final()]).toString("utf8");
}
