import { hkdfSync, randomBytes } from "node:crypto";
import { ServiceUnavailableException } from "@nestjs/common";
import { buildJwks, createLocalSigner, type JwkPublic, type ReceiptSigner } from "@saral/receipts";
import type { Settings } from "../settings.js";

/** Where the API gets every secret key. Production reads them from KMS (not built yet); development derives them. */
export interface KeyProvider {
  /** The audit HMAC key version used for new entries. */
  readonly currentAuditKeyVersion: number;
  /** The HMAC key for a version, or undefined if that version does not exist. */
  auditHmacKey(version: number): Uint8Array | undefined;
  /** Key for pseudonymous principal ids (decision D12). */
  pseudonymKey(): Uint8Array;
  /** Server pepper for API key secrets. */
  apiKeyPepper(): Uint8Array;
  /** Key that webhook signing secrets are derived from. */
  webhookKey(): Uint8Array;
  receiptSigner(): ReceiptSigner;
  jwks(): { keys: JwkPublic[] };
}

export const KEY_PROVIDER = Symbol("KEY_PROVIDER");

const MIN_MASTER_CHARS = 32;

const derive = (master: Buffer, label: string): Uint8Array =>
  new Uint8Array(hkdfSync("sha256", master, Buffer.from("saral-privacy/v1"), Buffer.from(label), 32));

/**
 * Development and test keys: every secret is derived from one master secret (or a random one made for this
 * process), and the receipt signing key is a fresh in-memory RSA key. Refuses to run in production, where
 * keys must come from KMS and never from an environment variable.
 */
export async function createDevKeyProvider(masterSecret: string | undefined, nodeEnv: string | undefined): Promise<KeyProvider> {
  if (nodeEnv === "production") {
    throw new Error("The dev key provider is for development only. Production needs a KMS-backed key provider.");
  }
  if (masterSecret !== undefined && masterSecret.length < MIN_MASTER_CHARS) {
    throw new Error(`SARAL_DEV_MASTER_SECRET must be at least ${String(MIN_MASTER_CHARS)} characters`);
  }
  const master = Buffer.from(masterSecret ?? randomBytes(32).toString("hex"), "utf8");
  const audit1 = derive(master, "audit-hmac-v1");
  const pseudonym = derive(master, "pseudonym-v1");
  const pepper = derive(master, "api-key-pepper-v1");
  const webhook = derive(master, "webhook-secret-v1");
  const { signer, publicJwk } = await createLocalSigner();
  const jwks = buildJwks([publicJwk]);
  return {
    currentAuditKeyVersion: 1,
    auditHmacKey: (version) => (version === 1 ? audit1 : undefined),
    pseudonymKey: () => pseudonym,
    apiKeyPepper: () => pepper,
    webhookKey: () => webhook,
    receiptSigner: () => signer,
    jwks: () => jwks,
  };
}

function unavailable(): never {
  throw new ServiceUnavailableException("no key provider is configured for this environment");
}

/** Production placeholder until the KMS-backed provider exists: the process boots, but nothing can use a key. */
const UNAVAILABLE: KeyProvider = {
  currentAuditKeyVersion: 1,
  auditHmacKey: unavailable,
  pseudonymKey: unavailable,
  apiKeyPepper: unavailable,
  webhookKey: unavailable,
  receiptSigner: unavailable,
  jwks: unavailable,
};

export async function createKeyProvider(settings: Settings): Promise<KeyProvider> {
  if (settings.nodeEnv === "production") return UNAVAILABLE;
  return createDevKeyProvider(settings.devMasterSecret, settings.nodeEnv);
}
