import { createHmac, createPublicKey, generateKeyPairSync, sign, type KeyObject } from "node:crypto";
import type { ReceiptInput } from "./claims";

export const b64u = (v: string | Buffer): string => Buffer.from(v).toString("base64url");

export const validInput = (): ReceiptInput => ({
  receiptId: "7f0c2d1e-5b8a-4c3d-9e6f-1a2b3c4d5e6f",
  principalId: "44444444-4444-4444-8444-444444444444",
  consentedAt: new Date("2026-11-06T09:30:00.000Z"),
  collectionMethod: "web_sdk: banner opt-in",
  language: "en",
  controller: {
    piiController: "Example Controller Pvt Ltd",
    contact: "Grievance Officer",
    address: {
      streetAddress: "1 Example Road",
      addressLocality: "Bengaluru",
      addressRegion: "KA",
      postalCode: "560001",
      addressCountry: "IN",
    },
    email: "privacy@example.org",
    phone: "tel:+91-00000-00000",
    piiControllerUrl: "https://example.org",
  },
  policyUrl: "https://example.org/privacy/v3",
  service: "Example app",
  purposes: [
    {
      purpose: "Send product updates",
      consentType: "EXPLICIT",
      purposeCategory: ["marketing"],
      piiCategory: ["email"],
      primaryPurpose: false,
      termination: "https://example.org/privacy/v3#withdraw",
      thirdPartyDisclosure: false,
    },
  ],
});

export interface TestKey {
  privateKey: KeyObject;
  publicJwk: { kty: "RSA"; n: string; e: string };
  kid: string;
}

export function rsaKey(modulusLength = 2048): { privateKey: KeyObject; publicKey: KeyObject } {
  return generateKeyPairSync("rsa", { modulusLength });
}

/** Builds a compact token by hand, so tests can forge things the library refuses to produce. */
export function forge(
  header: Record<string, unknown>,
  payload: unknown,
  opts: { privateKey?: KeyObject; signature?: string } = {},
): string {
  const h = b64u(JSON.stringify(header));
  const p = b64u(JSON.stringify(payload));
  const input = `${h}.${p}`;
  let sig = opts.signature ?? "";
  if (opts.signature === undefined && opts.privateKey) {
    sig = sign("RSA-SHA256", Buffer.from(input), opts.privateKey).toString("base64url");
  }
  return `${input}.${sig}`;
}

export function hs256(header: Record<string, unknown>, payload: unknown, secret: string | Buffer): string {
  const input = `${b64u(JSON.stringify(header))}.${b64u(JSON.stringify(payload))}`;
  return `${input}.${createHmac("sha256", secret).update(input).digest("base64url")}`;
}

export function publicJwkOf(privateKey: KeyObject): { kty: "RSA"; n: string; e: string } {
  const jwk = createPublicKey(privateKey).export({ format: "jwk" });
  return { kty: "RSA", n: jwk.n as string, e: jwk.e as string };
}
