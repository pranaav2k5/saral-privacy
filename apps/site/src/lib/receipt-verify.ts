/**
 * Checks a consent receipt (an RS256 JWT) against a public key set, in the browser, with Web Crypto. Nothing is sent anywhere.
 * It applies the same rules as the server's own check in `packages/receipts`: three canonical base64url parts, RS256 only, a key
 * that is in the set by its `kid`, no weak key, a valid signature, and the fields of a consent receipt. It does not import that
 * package, because that one uses Node's crypto.
 */

export const MAX_TOKEN_CHARS = 16 * 1024;
const MAX_KEYS = 100;
const MIN_MODULUS_BITS = 2048;
const MIN_EXPONENT = BigInt(65537);
const B64URL = /^[A-Za-z0-9_-]+$/;
const UUID_V4 = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const SHA256_HEX = /^[0-9a-f]{64}$/;
const MAX_SECONDS = 8_640_000_000_000;

export type VerifyFailure = "malformed" | "bad_alg" | "bad_key" | "unknown_kid" | "weak_key" | "bad_signature" | "bad_claims";

export interface PurposeSummary {
  name: string | null;
  categories: string[];
  data: string[];
  /** The receipt's `termination` field: where the person can withdraw consent (an address, not a length of time). */
  withdrawVia: string;
  sharedWith: string | null;
}

export interface ReceiptSummary {
  receiptId: string;
  consentedAt: string;
  language: string | undefined;
  controllers: string[];
  policyUrl: string;
  noticeSha256: string | undefined;
  services: { service: string; purposes: PurposeSummary[] }[];
}

export type VerifyResult = { ok: true; kid: string; summary: ReceiptSummary } | { ok: false; code: VerifyFailure; message: string };

export interface Jwks {
  keys: Record<string, unknown>[];
}

const isObject = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);
const isStrings = (v: unknown): v is string[] => Array.isArray(v) && v.every((x) => typeof x === "string");

class Refused extends Error {
  constructor(
    readonly code: VerifyFailure,
    message: string,
  ) {
    super(message);
  }
}

/** Decodes one base64url part, refusing padding, other alphabets and encodings that are not the canonical one. */
function decode(part: string | undefined): Uint8Array {
  if (part === undefined || !B64URL.test(part)) throw new Refused("malformed", "a part is not base64url");
  let bin: string;
  try {
    bin = atob(part.replace(/-/g, "+").replace(/_/g, "/") + "=".repeat((4 - (part.length % 4)) % 4));
  } catch {
    throw new Refused("malformed", "a part is not base64url");
  }
  if (btoa(bin).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "") !== part) throw new Refused("malformed", "a part is not in its canonical form");
  return Uint8Array.from(bin, (c) => c.charCodeAt(0));
}

function decodeObject(part: string | undefined, what: string): Record<string, unknown> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(decode(part)));
  } catch (e) {
    if (e instanceof Refused) throw e;
    throw new Refused("malformed", `the ${what} is not JSON`);
  }
  if (!isObject(parsed)) throw new Refused("malformed", `the ${what} must be a JSON object`);
  return parsed;
}

function bitLength(bytes: Uint8Array): number {
  let i = 0;
  while (i < bytes.length && bytes[i] === 0) i++;
  if (i === bytes.length) return 0;
  return (bytes.length - i - 1) * 8 + (32 - Math.clz32(bytes[i] as number));
}

async function importKey(jwk: Record<string, unknown>, subtle: SubtleCrypto): Promise<CryptoKey> {
  if (jwk.kty !== "RSA" || typeof jwk.n !== "string" || typeof jwk.e !== "string") throw new Refused("bad_key", "the key is not an RSA public key");
  if (jwk.use !== undefined && jwk.use !== "sig") throw new Refused("bad_key", "the key is not for signatures");
  if (jwk.alg !== undefined && jwk.alg !== "RS256") throw new Refused("bad_key", "the key is for another algorithm");
  let n: Uint8Array;
  let e: Uint8Array;
  try {
    n = decode(jwk.n);
    e = decode(jwk.e);
  } catch {
    throw new Refused("bad_key", "the key's numbers are not base64url");
  }
  if (bitLength(n) < MIN_MODULUS_BITS) throw new Refused("weak_key", "the key is under 2048 bits");
  if (BigInt("0x" + Array.from(e, (b) => b.toString(16).padStart(2, "0")).join("")) < MIN_EXPONENT) throw new Refused("weak_key", "the key's exponent is too small");
  try {
    return await subtle.importKey("jwk", { kty: "RSA", n: jwk.n, e: jwk.e, alg: "RS256", ext: true }, { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" }, false, ["verify"]);
  } catch {
    throw new Refused("bad_key", "the key could not be used");
  }
}

function summarise(c: unknown): ReceiptSummary {
  const bad = (why: string): never => {
    throw new Refused("bad_claims", why);
  };
  if (!isObject(c)) return bad("the receipt is not an object");
  if (c.version !== "KI-CR-v1.1.0") bad("the version is not KI-CR-v1.1.0");
  if (typeof c.consentReceiptID !== "string" || !UUID_V4.test(c.consentReceiptID)) bad("the receipt id is not a UUID");
  const ts = c.consentTimestamp;
  if (typeof ts !== "number" || !Number.isInteger(ts) || ts < 0 || ts > MAX_SECONDS) bad("the consent time is not a time");
  if (typeof c.policyUrl !== "string") bad("there is no policy address");
  if (c.language !== undefined && (typeof c.language !== "string" || !/^[a-z]{2}$/.test(c.language))) bad("the language is not a code");
  if (c.saralNoticeSha256 !== undefined && (typeof c.saralNoticeSha256 !== "string" || !SHA256_HEX.test(c.saralNoticeSha256))) bad("the notice fingerprint is not a hash");
  if (!Array.isArray(c.piiControllers) || c.piiControllers.length === 0 || !c.piiControllers.every((x) => isObject(x) && typeof x.piiController === "string")) bad("there is no controller");
  if (!Array.isArray(c.services) || c.services.length === 0) return bad("there is no service");
  const services = (c.services as unknown[]).map((s) => {
    if (!isObject(s) || typeof s.service !== "string" || !Array.isArray(s.purposes) || s.purposes.length === 0) return bad("a service has no purposes");
    const purposes = (s.purposes as unknown[]).map((p): PurposeSummary => {
      if (!isObject(p) || !isStrings(p.purposeCategory) || !isStrings(p.piiCategory) || typeof p.termination !== "string" || typeof p.thirdPartyDisclosure !== "boolean") return bad("a purpose is incomplete");
      if (p.purpose !== undefined && typeof p.purpose !== "string") bad("a purpose has no readable name");
      if (p.thirdPartyName !== undefined && typeof p.thirdPartyName !== "string") bad("a third party has no readable name");
      return {
        name: typeof p.purpose === "string" ? p.purpose : null,
        categories: p.purposeCategory,
        data: p.piiCategory,
        withdrawVia: p.termination,
        sharedWith: p.thirdPartyDisclosure ? (typeof p.thirdPartyName === "string" ? p.thirdPartyName : "a third party that is not named") : null,
      };
    });
    return { service: s.service, purposes };
  });
  return {
    receiptId: c.consentReceiptID as string,
    consentedAt: new Date((ts as number) * 1000).toISOString(),
    language: c.language as string | undefined,
    controllers: (c.piiControllers as Record<string, unknown>[]).map((x) => x.piiController as string),
    policyUrl: c.policyUrl as string,
    noticeSha256: c.saralNoticeSha256 as string | undefined,
    services,
  };
}

/** The key set as fetched: an object with a short list of key objects. Anything else is not used. */
export function parseJwks(value: unknown): Jwks | null {
  if (!isObject(value) || !Array.isArray(value.keys) || value.keys.length > MAX_KEYS || !value.keys.every(isObject)) return null;
  return { keys: value.keys as Record<string, unknown>[] };
}

/**
 * Verifies a receipt against a key set. It proves that the receipt was signed by a key in the set and has not been changed since.
 * It does not prove who the person is, and it cannot know whether the consent has been withdrawn since.
 */
export async function verifyReceiptToken(token: string, jwks: { keys: unknown[] }, subtle: SubtleCrypto = globalThis.crypto.subtle): Promise<VerifyResult> {
  try {
    const t = token.trim();
    const parts = t.length <= MAX_TOKEN_CHARS ? t.split(".") : [];
    if (parts.length !== 3) throw new Refused("malformed", "a receipt has three parts separated by dots");
    const [h, p, s] = parts as [string, string, string];
    const header = decodeObject(h, "header");
    if (header.alg !== "RS256") throw new Refused("bad_alg", "only RS256 is accepted");
    const payload = decodeObject(p, "payload");
    const signature = decode(s);
    const jwk = typeof header.kid === "string" ? jwks.keys.find((k) => isObject(k) && k.kid === header.kid) : undefined;
    if (jwk === undefined || !isObject(jwk)) throw new Refused("unknown_kid", "the key named in the receipt is not in the key set");
    const key = await importKey(jwk, subtle);
    let signed: boolean;
    try {
      signed = await subtle.verify("RSASSA-PKCS1-v1_5", key, signature as BufferSource, new TextEncoder().encode(`${h}.${p}`) as BufferSource);
    } catch {
      signed = false;
    }
    if (!signed) throw new Refused("bad_signature", "the signature does not match");
    return { ok: true, kid: header.kid as string, summary: summarise(payload) };
  } catch (e) {
    if (e instanceof Refused) return { ok: false, code: e.code, message: reasonInWords(e.code) };
    return { ok: false, code: "malformed", message: reasonInWords("malformed") };
  }
}

const WORDS: Record<VerifyFailure, string> = {
  malformed: "This is not a consent receipt. A receipt is one long piece of text made of three parts separated by dots. Check that you copied all of it and nothing else.",
  bad_alg: "This receipt uses a kind of signature that is not accepted here, so it cannot be checked. A receipt from Saral is signed with RS256.",
  bad_key: "The key that should check this receipt could not be used, so the receipt could not be checked.",
  unknown_kid: "This receipt names a signing key that this service does not publish, so it was not issued by this service or was issued with a key that has since been removed.",
  weak_key: "The key that should check this receipt is too weak to trust, so the receipt could not be checked.",
  bad_signature: "The signature does not match. The receipt has been changed since it was signed, or it was not issued by this service. Do not rely on it.",
  bad_claims: "The signature is right, but the receipt does not have the fields of a consent receipt, so it cannot be read.",
};

/** What a refusal means, for a person who is not a programmer. */
export const reasonInWords = (code: VerifyFailure): string => WORDS[code];
