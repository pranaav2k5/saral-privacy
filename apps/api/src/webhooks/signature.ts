import { createHmac, timingSafeEqual } from "node:crypto";

const MIN_SECRET_BYTES = 32;
/** How long the previous secret keeps signing after a rotation that left it working. */
export const SECRET_OVERLAP_MS = 24 * 3_600_000;

/**
 * Whether deliveries should still carry a signature made with the previous secret: the secret has been rotated at least once, the
 * last rotation left the old one working, and fewer than 24 hours have passed (at exactly 24 hours it has stopped).
 */
export function previousSecretActive(secretVersion: number, rotatedAt: Date | null, now: Date): boolean {
  return secretVersion > 1 && rotatedAt !== null && now.getTime() < rotatedAt.getTime() + SECRET_OVERLAP_MS;
}
export const DEFAULT_TOLERANCE_SECONDS = 300;

/**
 * The header value `t=<unix seconds>,v1=<hex HMAC-SHA256 of "<t>.<body>">`. Send it as `X-Saral-Signature`.
 * While a rotated secret is still allowed to work, pass the previous secret too: the header then holds a second `v1=` signature
 * made with it, after the current one, so a receiver that has not yet switched over and one that has both accept the request.
 */
export function signWebhook(secret: Uint8Array, timestamp: number, body: string, previousSecret?: Uint8Array): string {
  for (const s of previousSecret === undefined ? [secret] : [secret, previousSecret]) {
    if (s.length < MIN_SECRET_BYTES) throw new Error(`webhook secret must be at least ${String(MIN_SECRET_BYTES)} bytes`);
  }
  if (!Number.isInteger(timestamp) || timestamp < 0) throw new Error("timestamp must be a non-negative integer of seconds");
  const sign = (s: Uint8Array): string => createHmac("sha256", s).update(`${String(timestamp)}.${body}`).digest("hex");
  return `t=${String(timestamp)},v1=${sign(secret)}${previousSecret === undefined ? "" : `,v1=${sign(previousSecret)}`}`;
}

/**
 * The check a receiving server runs. Accepts the header if any `v1` value matches (so a secret can be rotated) and the
 * timestamp is within the tolerance either way (so a captured request cannot be replayed later). Never throws.
 */
export function verifyWebhookSignature(
  secret: Uint8Array,
  header: string,
  body: string,
  nowSeconds: number,
  toleranceSeconds: number = DEFAULT_TOLERANCE_SECONDS,
): boolean {
  let timestamp: number | undefined;
  const candidates: string[] = [];
  for (const part of header.split(",")) {
    const eq = part.indexOf("=");
    if (eq < 0) return false;
    const name = part.slice(0, eq);
    const value = part.slice(eq + 1);
    if (name === "t") {
      if (timestamp !== undefined || !/^\d{1,12}$/.test(value)) return false;
      timestamp = Number(value);
    } else if (name === "v1") {
      if (!/^[0-9a-f]{64}$/.test(value)) return false;
      candidates.push(value);
    } else {
      return false;
    }
  }
  if (timestamp === undefined || candidates.length === 0) return false;
  if (Math.abs(nowSeconds - timestamp) > toleranceSeconds) return false;
  let expected: Buffer;
  try {
    expected = Buffer.from(signWebhook(secret, timestamp, body).split("v1=")[1] as string, "hex");
  } catch {
    return false;
  }
  return candidates.some((c) => timingSafeEqual(Buffer.from(c, "hex"), expected));
}

/** The signing secret of one endpoint at one version, derived from a server key. Nothing is stored; rotating bumps the version. */
export function endpointSecret(webhookKey: Uint8Array, endpointId: string, version: number): Uint8Array {
  return new Uint8Array(createHmac("sha256", webhookKey).update(`${endpointId}:${String(version)}`).digest());
}

/** How a secret is shown to the tenant once, when an endpoint is created. */
export const formatSecret = (secret: Uint8Array): string => `whsec_${Buffer.from(secret).toString("base64url")}`;
