// The page and the server check a receipt's fields with separate code (the server's uses Node's crypto and cannot run in a browser). This
// test runs both over the same payloads, so a rule added to one and not the other fails here.
import { validateClaims } from "../../../../packages/receipts/src/claims";
import { verifyReceiptToken } from "./receipt-verify";
import { HEADER, JWKS, K, claims, sign } from "@/test/receipt-fixtures";

const c = claims();
const ctl = c.piiControllers[0] as Record<string, unknown>;
const svc = c.services[0] as { service: string; purposes: Record<string, unknown>[] };
const purpose = svc.purposes[0] as Record<string, unknown>;
const withController = (over: Record<string, unknown>) => ({ piiControllers: [{ ...ctl, ...over }] });
const withPurpose = (over: Record<string, unknown>) => ({ services: [{ ...svc, purposes: [{ ...purpose, ...over }] }] });
const without = (key: string): Record<string, unknown> => ({ [key]: undefined });

const cases: [string, Record<string, unknown>][] = [
  ["a valid receipt", {}],
  ["a valid receipt with the optional extras", { piiControllers: [{ ...ctl, onBehalf: true, piiControllerUrl: "https://example.org/about", address: { ...(ctl.address as object), addressRegion: "KA" } }], services: [{ ...svc, purposes: [{ ...purpose, primaryPurpose: true }] }], saralConsentId: "0b0f2b0e-4d6b-4d8e-8f55-3a2f6d6f7e11", saralNoticeId: "0b0f2b0e-4d6b-4d8e-8f55-3a2f6d6f7e12" }],
  ["a sensitive receipt that lists its categories", { sensitive: true, spiCat: ["health"] }],
  ["no iat", without("iat")],
  ["a negative iat", { iat: -1 }],
  ["an iat that is not whole", { iat: 1.5 }],
  ["no jurisdiction", without("jurisdiction")],
  ["a blank jurisdiction", { jurisdiction: "  " }],
  ["no collection method", without("collectionMethod")],
  ["a blank collection method", { collectionMethod: " " }],
  ["a receipt id that is not a v4 uuid", { consentReceiptID: "5f1d3f5e-8c61-1b1e-9d0a-0f6c1d2b3a4c" }],
  ["a receipt id in capitals", { consentReceiptID: "5F1D3F5E-8C61-4B1E-9D0A-0F6C1D2B3A4C" }],
  ["no principal id", without("piiPrincipalId")],
  ["a principal id that is an email address", { piiPrincipalId: "someone@example.org" }],
  ["a language that is not a code", { language: "english" }],
  ["a negative consent time", { consentTimestamp: -5 }],
  ["a consent time that is not whole", { consentTimestamp: 1.5 }],
  ["another version", { version: "KI-CR-v1.0.0" }],
  ["a policy address over http", { policyUrl: "http://example.org/privacy" }],
  ["a policy address with credentials", { policyUrl: "https://user:pass@example.org/privacy" }],
  ["a policy address that is not an address", { policyUrl: "not a url" }],
  ["no policy address", without("policyUrl")],
  ["no sensitive flag", without("sensitive")],
  ["a sensitive flag that is text", { sensitive: "no" }],
  ["a sensitive receipt with no categories", { sensitive: true, spiCat: [] }],
  ["no spiCat", without("spiCat")],
  ["a blank spiCat entry", { spiCat: [" "] }],
  ["a bad saral consent id", { saralConsentId: "nope" }],
  ["a bad saral notice id", { saralNoticeId: "nope" }],
  ["a bad notice fingerprint", { saralNoticeSha256: "abc" }],
  ["no controllers", { piiControllers: [] }],
  ["a controller that is not an object", { piiControllers: ["x"] }],
  ["a controller with a bad email", withController({ email: "not an email" })],
  ["a controller with a bad phone", withController({ phone: "12345" })],
  ["a controller with no contact", withController({ contact: "" })],
  ["a controller with no name", withController({ piiController: " " })],
  ["a controller with no address", withController({ address: undefined })],
  ["a controller whose address misses the street", withController({ address: { ...(ctl.address as object), streetAddress: "" } })],
  ["a controller whose address region is blank", withController({ address: { ...(ctl.address as object), addressRegion: " " } })],
  ["a controller url over http", withController({ piiControllerUrl: "http://example.org" })],
  ["a controller flag that is text", withController({ onBehalf: "yes" })],
  ["no services", { services: [] }],
  ["a service with no name", { services: [{ ...svc, service: "" }] }],
  ["a service with no purposes", { services: [{ ...svc, purposes: [] }] }],
  ["a purpose with no consent type", withPurpose({ consentType: undefined })],
  ["a purpose with no categories", withPurpose({ purposeCategory: [] })],
  ["a purpose with a blank category", withPurpose({ purposeCategory: [" "] })],
  ["a purpose with no data", withPurpose({ piiCategory: [] })],
  ["a purpose with a blank termination", withPurpose({ termination: " " })],
  ["a purpose that is shared with no name", withPurpose({ thirdPartyDisclosure: true, thirdPartyName: undefined })],
  ["a purpose whose disclosure flag is text", withPurpose({ thirdPartyDisclosure: "yes" })],
  ["a purpose whose primary flag is text", withPurpose({ primaryPurpose: "yes" })],
  ["a purpose with a blank name", withPurpose({ purpose: " " })],
];

/** The valid receipt with `over` applied. A key set to undefined is removed, as if it had been left out. */
const build = (over: Record<string, unknown>): Record<string, unknown> => {
  const payload: Record<string, unknown> = { ...c, ...over };
  for (const [k, v] of Object.entries(over)) if (v === undefined) delete payload[k];
  return payload;
};
const serverAccepts = (payload: unknown): boolean => {
  try {
    validateClaims(payload);
    return true;
  } catch {
    return false;
  }
};
const pageAccepts = async (payload: unknown): Promise<boolean> => (await verifyReceiptToken(sign(K.privateKey, HEADER, payload), JWKS)).ok;

describe("the page and the server agree on what a receipt must contain", () => {
  test.each(cases)("%s", async (_name, over) => {
    const payload = build(over);
    expect(await pageAccepts(payload)).toBe(serverAccepts(payload));
  });

  test("the table has valid receipts as well as invalid ones, so agreeing is not just agreeing to refuse everything", () => {
    const verdicts = cases.map(([, over]) => serverAccepts(build(over)));
    expect(verdicts.filter(Boolean).length).toBeGreaterThanOrEqual(3);
    expect(verdicts.filter((v) => !v).length).toBeGreaterThanOrEqual(40);
  });
});
