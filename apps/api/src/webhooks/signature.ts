import { createHmac, timingSafeEqual } from "node:crypto";

const MIN_SECRET_BYTES = 32;
export const DEFAULT_TOLERANCE_SECONDS = 300;

/** The header value `t=<unix seconds>,v1=<hex HMAC-SHA256 of "<t>.<body>">`. Send it as `X-Saral-Signature`. */
export function signWebhook(secret: Uint8Array, timestamp: number, body: string): string {
  if (secret.length < MIN_SECRET_BYTES) throw new Error(`webhook secret must be at least ${String(MIN_SECRET_BYTES)} bytes`);
  if (!Number.isInteger(timestamp) || timestamp < 0) throw new Error("timestamp must be a non-negative integer of seconds");
  return `t=${String(timestamp)},v1=${createHmac("sha256", secret).update(`${String(timestamp)}.${body}`).digest("hex")}`;
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
