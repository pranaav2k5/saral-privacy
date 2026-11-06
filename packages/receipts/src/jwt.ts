import { createPublicKey, verify } from "node:crypto";
import { ReceiptError, validateClaims, type KantaraReceiptClaims } from "./claims";
import type { JwkPublic } from "./jwks";

/** Produces RS256 (RSASSA-PKCS1-v1_5 with SHA-256) signatures. A KMS adapter implements the same interface. */
export interface ReceiptSigner {
  readonly kid: string;
  sign(signingInput: Uint8Array): Promise<Uint8Array>;
}

export type VerificationCode =
  | "malformed"
  | "bad_alg"
  | "bad_key"
  | "unknown_kid"
  | "weak_key"
  | "bad_signature"
  | "bad_claims";

export class ReceiptVerificationError extends Error {
  constructor(
    readonly code: VerificationCode,
    message: string,
  ) {
    super(message);
    this.name = "ReceiptVerificationError";
  }
}

const MIN_MODULUS_BITS = 2048;
const MIN_EXPONENT = 65537n;
const B64URL = /^[A-Za-z0-9_-]+$/;
/** A receipt is a few KiB. Reject anything larger before parsing it. */
export const MAX_TOKEN_CHARS = 16 * 1024;

const b64u = (v: Uint8Array | string): string => Buffer.from(v).toString("base64url");

/** Decodes a base64url segment, rejecting padding, other alphabets and non-canonical encodings. */
function decodeSegment(seg: string | undefined): Buffer {
  if (seg === undefined || !B64URL.test(seg)) throw new ReceiptVerificationError("malformed", "bad base64url segment");
  const buf = Buffer.from(seg, "base64url");
  if (buf.toString("base64url") !== seg) throw new ReceiptVerificationError("malformed", "non-canonical base64url");
  return buf;
}

function decodeJsonObject(seg: string | undefined, what: string): Record<string, unknown> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(decodeSegment(seg).toString("utf8"));
  } catch (e) {
    if (e instanceof ReceiptVerificationError) throw e;
    throw new ReceiptVerificationError("malformed", `${what} is not JSON`);
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    throw new ReceiptVerificationError("malformed", `${what} must be a JSON object`);
  }
  return parsed as Record<string, unknown>;
}

/** Signs validated claims as a compact JWS: header `{alg: RS256, typ: JWT, kid}`, claims as the payload. */
export async function signReceipt(claims: KantaraReceiptClaims, signer: ReceiptSigner): Promise<string> {
  validateClaims(claims);
  if (signer.kid === "") throw new ReceiptError("signer must have a kid");
  const header = b64u(JSON.stringify({ alg: "RS256", typ: "JWT", kid: signer.kid }));
  const payload = b64u(JSON.stringify(claims));
  const input = `${header}.${payload}`;
  const signature = await signer.sign(Buffer.from(input, "ascii"));
  const token = `${input}.${b64u(signature)}`;
  // The verifier refuses tokens over the limit, so a receipt that large must not be issued: nobody could check it.
  if (token.length > MAX_TOKEN_CHARS) throw new ReceiptError(`receipt is too large (${String(token.length)} characters, limit ${String(MAX_TOKEN_CHARS)})`);
  return token;
}

function bitLength(n: Buffer): number {
  let i = 0;
  while (i < n.length && n[i] === 0) i++;
  if (i === n.length) return 0;
  return (n.length - i - 1) * 8 + (32 - Math.clz32(n[i] as number));
}

function publicKeyFrom(jwk: Record<string, unknown>) {
  if (jwk.kty !== "RSA" || typeof jwk.n !== "string" || typeof jwk.e !== "string") {
    throw new ReceiptVerificationError("bad_key", "key must be an RSA public JWK");
  }
  if (jwk.use !== undefined && jwk.use !== "sig") throw new ReceiptVerificationError("bad_key", "key use is not sig");
  if (jwk.alg !== undefined && jwk.alg !== "RS256") throw new ReceiptVerificationError("bad_key", "key alg is not RS256");
  let n: Buffer;
  let e: Buffer;
  try {
    n = decodeSegment(jwk.n);
    e = decodeSegment(jwk.e);
  } catch {
    throw new ReceiptVerificationError("bad_key", "key members are not base64url");
  }
  if (bitLength(n) < MIN_MODULUS_BITS) throw new ReceiptVerificationError("weak_key", "RSA modulus is under 2048 bits");
  if (BigInt("0x" + e.toString("hex")) < MIN_EXPONENT) throw new ReceiptVerificationError("weak_key", "RSA exponent is too small");
  try {
    return createPublicKey({ key: { kty: "RSA", n: jwk.n, e: jwk.e }, format: "jwk" });
  } catch {
    throw new ReceiptVerificationError("bad_key", "key could not be imported");
  }
}

/**
 * Verifies a receipt JWT against a JWKS. Accepts only RS256, requires a `kid` that is in the key set,
 * refuses weak keys, and validates the claims. Throws ReceiptVerificationError with a `code`.
 */
export async function verifyReceipt(
  jwt: string,
  jwks: { keys: readonly JwkPublic[] },
): Promise<KantaraReceiptClaims> {
  const parts = typeof jwt === "string" && jwt.length <= MAX_TOKEN_CHARS ? jwt.split(".") : [];
  if (parts.length !== 3) throw new ReceiptVerificationError("malformed", "a compact JWS has three segments");
  const [h, p, s] = parts as [string, string, string];
  const header = decodeJsonObject(h, "header");
  if (header.alg !== "RS256") throw new ReceiptVerificationError("bad_alg", "only RS256 is accepted");
  const payload = decodeJsonObject(p, "payload");
  const signature = decodeSegment(s);

  const jwk = typeof header.kid === "string" ? jwks.keys.find((k) => k.kid === header.kid) : undefined;
  if (jwk === undefined) throw new ReceiptVerificationError("unknown_kid", "kid is missing or not in the key set");
  const key = publicKeyFrom(jwk as unknown as Record<string, unknown>);

  let ok: boolean;
  try {
    ok = verify("RSA-SHA256", Buffer.from(`${h}.${p}`, "ascii"), key, signature);
  } catch {
    ok = false;
  }
  if (!ok) throw new ReceiptVerificationError("bad_signature", "signature does not match");

  try {
    return validateClaims(payload);
  } catch (e) {
    throw new ReceiptVerificationError("bad_claims", e instanceof Error ? e.message : "invalid claims");
  }
}
