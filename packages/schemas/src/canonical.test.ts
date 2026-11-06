import {
  CanonicalError,
  SUPPORTED_CANONICAL_VERSIONS,
  canonicalAuditEntry,
  canonicalConsentRecord,
  type AuditFields,
  type ConsentFields,
} from "./canonical";

const TENANT = "11111111-1111-4111-8111-111111111111";
const HEX_AB = "ab".repeat(32);
const HEX_CD = "cd".repeat(32);

const audit: AuditFields = {
  tenantId: TENANT,
  seqNo: "42",
  ts: "2026-11-06T09:30:00.000Z",
  actorType: "system",
  actorId: null,
  action: "consent.granted",
  refTable: "consent_records",
  refId: "22222222-2222-4222-8222-222222222222",
  payloadSha256: HEX_AB,
};

const consent: ConsentFields = {
  tenantId: TENANT,
  consentId: "33333333-3333-4333-8333-333333333333",
  principalId: "44444444-4444-4444-8444-444444444444",
  noticeId: "55555555-5555-4555-8555-555555555555",
  noticeSha256: HEX_CD,
  purposes: [
    { key: "marketing", granted: false, retentionDays: 0 },
    { key: "analytics", granted: true, retentionDays: 365 },
  ],
  status: "granted",
  grantedAt: "2026-11-06T09:30:00.000Z",
  withdrawnAt: null,
  collectionMethod: "web_sdk",
};

describe("canonical string v1 is frozen", () => {
  test("supported versions are exactly [1]; bumping needs new vectors", () => {
    expect([...SUPPORTED_CANONICAL_VERSIONS]).toEqual([1]);
  });

  test("audit entry golden vector", () => {
    expect(canonicalAuditEntry(audit)).toBe(
      `["saral.audit",1,"${TENANT}","42","2026-11-06T09:30:00.000Z","system",null,` +
        `"consent.granted","consent_records","22222222-2222-4222-8222-222222222222","${HEX_AB}"]`,
    );
  });

  test("consent record golden vector (purposes sorted by key)", () => {
    expect(canonicalConsentRecord(consent)).toBe(
      `["saral.consent",1,"${TENANT}","33333333-3333-4333-8333-333333333333",` +
        `"44444444-4444-4444-8444-444444444444","55555555-5555-4555-8555-555555555555","${HEX_CD}",` +
        `[["analytics",true,365],["marketing",false,0]],"granted","2026-11-06T09:30:00.000Z",null,"web_sdk"]`,
    );
  });

  test("explicit version 1 equals the default", () => {
    expect(canonicalAuditEntry(audit, 1)).toBe(canonicalAuditEntry(audit));
    expect(canonicalConsentRecord(consent, 1)).toBe(canonicalConsentRecord(consent));
  });

  test("an unsupported version throws", () => {
    expect(() => canonicalAuditEntry(audit, 2)).toThrow(CanonicalError);
    expect(() => canonicalConsentRecord(consent, 0)).toThrow(CanonicalError);
  });
});

describe("canonical strings are unambiguous", () => {
  test("purpose order does not change the consent string", () => {
    const reversed = { ...consent, purposes: [...consent.purposes].reverse() };
    expect(canonicalConsentRecord(reversed)).toBe(canonicalConsentRecord(consent));
  });

  test("delimiter-laden actorId stays one field and round-trips", () => {
    const nasty = 'a|b","c\\d\ne\u0000é\u{1F600}';
    const s = canonicalAuditEntry({ ...audit, actorType: "principal", actorId: nasty });
    const parsed = JSON.parse(s) as unknown[];
    expect(parsed).toHaveLength(11);
    expect(parsed[6]).toBe(nasty);
    expect(s).not.toContain("\n");
  });

  test("records that differ in one field give different strings", () => {
    const a = canonicalAuditEntry({ ...audit, actorType: "dpo", actorId: "a|b" });
    const b = canonicalAuditEntry({ ...audit, actorType: "dpo", actorId: "a" });
    expect(a).not.toBe(b);
    expect(JSON.parse(a) as unknown[]).toHaveLength((JSON.parse(b) as unknown[]).length);
  });
});

describe("audit validation", () => {
  const bad: [string, Partial<AuditFields>][] = [
    ["tenantId not a uuid", { tenantId: "tenant-1" }],
    ["tenantId uppercase", { tenantId: "AAAAAAAA-AAAA-4AAA-8AAA-AAAAAAAAAAAA" }],
    ["refId not a uuid", { refId: "nope" }],
    ["seqNo with leading zero", { seqNo: "007" }],
    ["seqNo negative", { seqNo: "-1" }],
    ["seqNo not a string of digits", { seqNo: "1e3" }],
    ["seqNo longer than a bigint", { seqNo: "1".repeat(20) }],
    ["ts without milliseconds", { ts: "2026-11-06T09:30:00Z" }],
    ["ts with offset", { ts: "2026-11-06T15:00:00.000+05:30" }],
    ["ts that is not a real date", { ts: "2026-02-31T00:00:00.000Z" }],
    ["actorType unknown", { actorType: "admin" as AuditFields["actorType"] }],
    ["actorId empty", { actorId: "" }],
    ["actorId over 128 chars", { actorId: "x".repeat(129) }],
    ["action without a dot", { action: "granted" }],
    ["action uppercase", { action: "Consent.Granted" }],
    ["refTable with a dash", { refTable: "consent-records" }],
    ["payloadSha256 too short", { payloadSha256: "ab" }],
    ["payloadSha256 uppercase", { payloadSha256: HEX_AB.toUpperCase() }],
  ];

  test.each(bad)("rejects %s", (_name, override) => {
    expect(() => canonicalAuditEntry({ ...audit, ...override })).toThrow(CanonicalError);
  });

  test("the error names the field", () => {
    expect(() => canonicalAuditEntry({ ...audit, seqNo: "x" })).toThrow(/seqNo/);
  });

  test("accepts the largest bigint-width seqNo and a 128-char actorId", () => {
    expect(() =>
      canonicalAuditEntry({ ...audit, seqNo: "9223372036854775807", actorId: "x".repeat(128) }),
    ).not.toThrow();
  });
});

describe("consent validation", () => {
  const bad: [string, Partial<ConsentFields>][] = [
    ["no purposes", { purposes: [] }],
    ["duplicate purpose keys", {
      purposes: [
        { key: "analytics", granted: true, retentionDays: 1 },
        { key: "analytics", granted: false, retentionDays: 1 },
      ],
    }],
    ["purpose key with uppercase", {
      purposes: [{ key: "Analytics", granted: true, retentionDays: 1 }],
    }],
    ["purpose key starting with a digit", {
      purposes: [{ key: "1a", granted: true, retentionDays: 1 }],
    }],
    ["retentionDays negative", {
      purposes: [{ key: "a", granted: true, retentionDays: -1 }],
    }],
    ["retentionDays fractional", {
      purposes: [{ key: "a", granted: true, retentionDays: 1.5 }],
    }],
    ["retentionDays over 36500", {
      purposes: [{ key: "a", granted: true, retentionDays: 36501 }],
    }],
    ["granted not a boolean", {
      purposes: [{ key: "a", granted: "yes" as unknown as boolean, retentionDays: 1 }],
    }],
    ["status unknown", { status: "pending" as ConsentFields["status"] }],
    ["withdrawn without withdrawnAt", { status: "withdrawn", withdrawnAt: null }],
    ["granted with withdrawnAt", { status: "granted", withdrawnAt: "2026-11-07T00:00:00.000Z" }],
    ["collectionMethod unknown", { collectionMethod: "fax" as ConsentFields["collectionMethod"] }],
    ["noticeSha256 not hex", { noticeSha256: "z".repeat(64) }],
    ["grantedAt bad", { grantedAt: "yesterday" }],
    ["principalId not a uuid", { principalId: "+91 00000 00000" }],
  ];

  test.each(bad)("rejects %s", (_name, override) => {
    expect(() => canonicalConsentRecord({ ...consent, ...override })).toThrow(CanonicalError);
  });

  test("a withdrawn record with withdrawnAt is accepted", () => {
    const s = canonicalConsentRecord({
      ...consent,
      status: "withdrawn",
      withdrawnAt: "2026-11-07T10:00:00.000Z",
    });
    expect((JSON.parse(s) as unknown[])[10]).toBe("2026-11-07T10:00:00.000Z");
  });

  test("does not mutate its input", () => {
    const before = JSON.stringify(consent);
    canonicalConsentRecord(consent);
    expect(JSON.stringify(consent)).toBe(before);
  });
});
