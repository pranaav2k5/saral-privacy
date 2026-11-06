import { createHmac, timingSafeEqual } from "node:crypto";

export type TokenPurpose = "session" | "challenge";
export type StaffRole = "tenant_admin" | "dpo";

export interface TokenPayload {
  purpose: TokenPurpose;
  /** Staff user id. */
  sub: string;
  /** Tenant id. */
  tid: string;
  role: StaffRole;
  /** The user's session version when the token was made; bumping it signs everyone out. */
  ver: number;
  iat: number;
  exp: number;
  /** When the person last signed in with a password and a code (seconds). Refreshing never moves it. */
  auth: number;
}

const HEADER = "st_v1";
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const SKEW_SECONDS = 60;

const mac = (key: Uint8Array, payloadB64: string): Buffer => createHmac("sha256", key).update(`saral.token.v1.${payloadB64}`).digest();

/**
 * `st_v1.<payload>.<HMAC-SHA256>`. An opaque signed token for this service only, not a JWT: it is made and checked by the API
 * itself with a server key, so there is no algorithm field to confuse and nothing for a third party to verify.
 */
export function signToken(key: Uint8Array, payload: TokenPayload): string {
  if (key.length < 32) throw new Error("token key must be at least 32 bytes");
  const body = Buffer.from(JSON.stringify(payload)).toString("base64url");
  return `${HEADER}.${body}.${mac(key, body).toString("base64url")}`;
}

const isInt = (v: unknown): v is number => typeof v === "number" && Number.isInteger(v) && v >= 0;

export type VerifyResult = { ok: true; payload: TokenPayload } | { ok: false };

/** Checks the signature, the purpose, the shape and the lifetime. Never throws. */
export function verifyToken(key: Uint8Array, token: string, purpose: TokenPurpose, nowMs: number): VerifyResult {
  const parts = typeof token === "string" ? token.split(".") : [];
  if (parts.length !== 3 || parts[0] !== HEADER || key.length < 32) return { ok: false };
  const [, body, sig] = parts as [string, string, string];
  let given: Buffer;
  try {
    given = Buffer.from(sig, "base64url");
  } catch {
    return { ok: false };
  }
  const expected = mac(key, body);
  if (given.length !== expected.length || !timingSafeEqual(given, expected)) return { ok: false };
  let p: Record<string, unknown>;
  try {
    p = JSON.parse(Buffer.from(body, "base64url").toString("utf8")) as Record<string, unknown>;
  } catch {
    return { ok: false };
  }
  if (typeof p !== "object" || p === null) return { ok: false };
  const nowSec = nowMs / 1000;
  if (
    p.purpose !== purpose || typeof p.sub !== "string" || !UUID.test(p.sub) || typeof p.tid !== "string" || !UUID.test(p.tid) ||
    (p.role !== "tenant_admin" && p.role !== "dpo") || !isInt(p.ver) || !isInt(p.iat) || !isInt(p.exp) || !isInt(p.auth) ||
    nowSec >= p.exp || p.iat > nowSec + SKEW_SECONDS
  ) {
    return { ok: false };
  }
  return { ok: true, payload: p as unknown as TokenPayload };
}
