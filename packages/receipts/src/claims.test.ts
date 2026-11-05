import { buildReceiptClaims, validateClaims, ReceiptError } from "./claims";
import { createLocalSigner, signReceipt } from "./index";
import { validInput } from "./test-helpers";

const NOW = new Date("2026-11-06T09:30:05.000Z");

describe("buildReceiptClaims", () => {
  test("produces the KI-CR-v1.1.0 receipt for a valid input (golden)", () => {
    expect(buildReceiptClaims(validInput(), NOW)).toEqual({
      version: "KI-CR-v1.1.0",
      jurisdiction: "IN",
      consentTimestamp: 1793957400,
      collectionMethod: "web_sdk: banner opt-in",
      consentReceiptID: "7f0c2d1e-5b8a-4c3d-9e6f-1a2b3c4d5e6f",
      language: "en",
      piiPrincipalId: "44444444-4444-4444-8444-444444444444",
      piiControllers: [
        {
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
      ],
      policyUrl: "https://example.org/privacy/v3",
      services: [
        {
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
        },
      ],
      sensitive: false,
      spiCat: [],
      iat: 1793957405,
    });
  });

  test("the language is optional and omitted when absent", () => {
    const input = validInput();
    delete input.language;
    expect("language" in buildReceiptClaims(input, NOW)).toBe(false);
  });

  const bad: [string, (i: ReturnType<typeof validInput>) => void][] = [
    ["a non-https policy URL", (i) => void (i.policyUrl = "http://example.org/p")],
    ["a javascript: policy URL", (i) => void (i.policyUrl = "javascript:alert(1)")],
    ["a receipt id that is not a v4 UUID", (i) => void (i.receiptId = "11111111-1111-1111-8111-111111111111")],
    ["a principal id that is an email", (i) => void (i.principalId = "person@example.org")],
    ["a principal id that is a phone number", (i) => void (i.principalId = "+910000000000")],
    ["no purposes", (i) => void (i.purposes = [])],
    ["an empty service name", (i) => void (i.service = " ")],
    ["an empty collection method", (i) => void (i.collectionMethod = "")],
    ["a controller email without @", (i) => void (i.controller.email = "privacy.example.org")],
    ["a phone that is not an RFC 3966 tel: URI", (i) => void (i.controller.phone = "+91 00000 00000")],
    ["a language that is not ISO 639-1", (i) => void (i.language = "eng")],
    ["an invalid consent date", (i) => void (i.consentedAt = new Date("nope"))],
    ["an empty purposeCategory", (i) => void (i.purposes[0]!.purposeCategory = [])],
    ["an empty piiCategory", (i) => void (i.purposes[0]!.piiCategory = [])],
    ["an empty termination", (i) => void (i.purposes[0]!.termination = "")],
    ["third party disclosure without a name", (i) => {
      i.purposes[0]!.thirdPartyDisclosure = true;
    }],
    ["sensitive without categories", (i) => void (i.sensitive = true)],
  ];

  test.each(bad)("rejects %s", (_name, mutate) => {
    const input = validInput();
    mutate(input);
    expect(() => buildReceiptClaims(input, NOW)).toThrow(ReceiptError);
  });

  test("accepts third party disclosure with a name and sensitive data with categories", () => {
    const input = validInput();
    input.purposes[0]!.thirdPartyDisclosure = true;
    input.purposes[0]!.thirdPartyName = "Example Analytics Ltd";
    input.sensitive = true;
    input.spiCat = ["health"];
    const c = buildReceiptClaims(input, NOW);
    expect(c.sensitive).toBe(true);
    expect(c.spiCat).toEqual(["health"]);
    expect(c.services[0]?.purposes[0]?.thirdPartyName).toBe("Example Analytics Ltd");
  });

  test("does not mutate its input", () => {
    const input = validInput();
    const before = JSON.stringify(input);
    buildReceiptClaims(input, NOW);
    expect(JSON.stringify(input)).toBe(before);
  });
});

describe("references to the consent and the notice (extension claims)", () => {
  const REFS = {
    consentId: "33333333-3333-4333-8333-333333333333",
    noticeId: "55555555-5555-4555-8555-555555555555",
    noticeSha256: "ab".repeat(32),
  };

  test("are added as saral-prefixed claims when given, and omitted when not", () => {
    const withRefs = buildReceiptClaims({ ...validInput(), ...REFS }, NOW);
    expect(withRefs.saralConsentId).toBe(REFS.consentId);
    expect(withRefs.saralNoticeId).toBe(REFS.noticeId);
    expect(withRefs.saralNoticeSha256).toBe(REFS.noticeSha256);
    const without = buildReceiptClaims(validInput(), NOW);
    expect("saralConsentId" in without).toBe(false);
    expect("saralNoticeId" in without).toBe(false);
    expect("saralNoticeSha256" in without).toBe(false);
  });

  test.each([
    ["a consent id that is not a UUID", { consentId: "nope" }],
    ["a notice id that is not a UUID", { noticeId: "nope" }],
    ["a notice hash that is not 64 lowercase hex", { noticeSha256: "AB".repeat(32) }],
    ["a notice hash that is too short", { noticeSha256: "ab" }],
  ])("rejects %s", (_n, bad) => {
    expect(() => buildReceiptClaims({ ...validInput(), ...REFS, ...bad }, NOW)).toThrow(ReceiptError);
  });

  test("a receipt carrying the references verifies and round-trips them", () => {
    const c = JSON.parse(JSON.stringify(buildReceiptClaims({ ...validInput(), ...REFS }, NOW))) as unknown;
    expect(validateClaims(c)).toMatchObject({ saralConsentId: REFS.consentId, saralNoticeSha256: REFS.noticeSha256 });
    expect(() => validateClaims({ ...(c as object), saralNoticeSha256: "zz" })).toThrow(ReceiptError);
  });
});

describe("a receipt that is too large to verify is never signed", () => {
  test("signing refuses a payload the verifier would refuse (16 KiB limit)", async () => {
    const { signer } = await createLocalSigner();
    const input = validInput();
    input.purposes = Array.from({ length: 60 }, (_, i) => ({ ...(input.purposes[0] as object), purpose: `p${String(i)} ` + "x".repeat(400) })) as typeof input.purposes;
    const claims = buildReceiptClaims(input, NOW);
    await expect(signReceipt(claims, signer)).rejects.toThrow(/too large/);
  });
});

describe("validateClaims", () => {
  const good = (): unknown => JSON.parse(JSON.stringify(buildReceiptClaims(validInput(), NOW)));

  test("accepts built claims", () => {
    expect(validateClaims(good())).toMatchObject({ version: "KI-CR-v1.1.0" });
  });

  test.each([
    "version", "jurisdiction", "consentTimestamp", "collectionMethod", "consentReceiptID",
    "piiPrincipalId", "piiControllers", "services", "policyUrl", "sensitive", "spiCat",
  ])("rejects claims without the required field %s", (field) => {
    const c = good() as Record<string, unknown>;
    delete c[field];
    expect(() => validateClaims(c)).toThrow(ReceiptError);
  });

  test("rejects a wrong version, a fractional timestamp, and non-objects", () => {
    expect(() => validateClaims({ ...(good() as object), version: "KI-CR-v1.0.0" })).toThrow(ReceiptError);
    expect(() => validateClaims({ ...(good() as object), consentTimestamp: 1.5 })).toThrow(ReceiptError);
    for (const junk of [null, 7, "x", []]) expect(() => validateClaims(junk)).toThrow(ReceiptError);
  });
});
