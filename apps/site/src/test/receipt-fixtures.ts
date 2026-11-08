import { createSign, generateKeyPairSync, type KeyObject } from "node:crypto";

/** Real RS256 receipts signed with generated keys, so the verifier is tested against what it will meet, not against mocks. */
export const b64u = (v: string | Buffer) => Buffer.from(v).toString("base64url");
export function keypair(bits = 2048, kid = "key-1") {
  const { publicKey, privateKey } = generateKeyPairSync("rsa", { modulusLength: bits });
  return { privateKey, jwk: { ...publicKey.export({ format: "jwk" }), kid, alg: "RS256", use: "sig" } as Record<string, unknown> };
}
export function sign(privateKey: KeyObject, header: Record<string, unknown>, payload: unknown): string {
  const input = `${b64u(JSON.stringify(header))}.${b64u(JSON.stringify(payload))}`;
  return `${input}.${b64u(createSign("RSA-SHA256").update(input).sign(privateKey))}`;
}
export const claims = (over: Record<string, unknown> = {}) => ({
  version: "KI-CR-v1.1.0", jurisdiction: "IN", consentTimestamp: Date.parse("2026-11-06T09:30:00Z") / 1000, collectionMethod: "web_sdk",
  consentReceiptID: "5f1d3f5e-8c61-4b1e-9d0a-0f6c1d2b3a4c", language: "en", piiPrincipalId: "0b0f2b0e-4d6b-4d8e-8f55-3a2f6d6f7e11",
  piiControllers: [{ piiController: "Example Controller Pvt Ltd", contact: "Grievance Officer", email: "privacy@example.org", phone: "tel:+91-00000-00000", address: { streetAddress: "1 Example Road", addressLocality: "Bengaluru", postalCode: "560001", addressCountry: "IN" } }],
  policyUrl: "https://example.org/privacy",
  services: [{ service: "Example app", purposes: [
    { purpose: "Understand how the app is used", consentType: "explicit", purposeCategory: ["analytics"], piiCategory: ["device type"], termination: "https://example.org/privacy#withdraw", thirdPartyDisclosure: true, thirdPartyName: "Example Analytics Ltd" },
    { consentType: "explicit", purposeCategory: ["marketing"], piiCategory: ["email address"], termination: "https://example.org/privacy#withdraw", thirdPartyDisclosure: false },
  ] }],
  sensitive: false, spiCat: [], iat: 1_793_000_000, saralNoticeSha256: "a".repeat(64), ...over,
});
export const HEADER = { alg: "RS256", typ: "JWT", kid: "key-1" };
export const K = keypair();
export const JWKS = { keys: [K.jwk] };
