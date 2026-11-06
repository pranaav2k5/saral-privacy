import { createHash, randomUUID } from "node:crypto";
import { issueApiKey } from "../../src/auth/api-keys.js";
import { startApi, type Api, type Tenant } from "./harness.js";

let api: Api;
beforeAll(async () => {
  api = await startApi();
});
afterAll(async () => {
  await api.stop();
});

const NOTICE = {
  organisationName: "Example Controller Pvt Ltd",
  websiteUrl: "https://example.org",
  grievanceEmail: "privacy@example.org",
  grievanceAddress: "1 Example Road, Bengaluru 560001",
  thirdParties: ["Example Analytics Ltd"],
  processesChildrenData: false,
  withdrawalUrl: "https://example.org/privacy#withdraw",
  rightsRequestUrl: "https://example.org/privacy#rights",
};
const ANALYTICS = {
  key: "analytics",
  name: "Understand how the app is used",
  description: "We count which screens are opened so we can fix the ones people get stuck on.",
  dataItems: ["device type", "screens opened"],
  retention: "12 months",
  retentionDays: 365,
  purposeCategory: ["analytics"],
  piiCategory: ["device type"],
  thirdPartyDisclosure: true,
  thirdPartyName: "Example Analytics Ltd",
};
const MARKETING = {
  key: "marketing",
  name: "Send product updates",
  description: "We email you about new features.",
  dataItems: ["email address"],
  retention: "Until you withdraw",
  retentionDays: 730,
  purposeCategory: ["marketing"],
  piiCategory: ["email address"],
  thirdPartyDisclosure: false,
  primaryPurpose: false,
};
const body = (over: Record<string, unknown> = {}) => ({ language: "en", notice: NOTICE, purposes: [ANALYTICS, MARKETING], ...over });
const publish = (t: Tenant, b: unknown = body(), key = t.admin) => api.http().post("/v1/notices").set("Authorization", `Bearer ${key}`).send(b as object);
const rows = (sql: string, params: unknown[] = []) => api.db.owner.query(sql, params).then((r) => r.rows as Record<string, unknown>[]);
const count = async (t: Tenant) => ((await rows("SELECT count(*)::int AS n FROM privacy_notices WHERE tenant_id = $1", [t.id]))[0] as { n: number }).n;

describe("POST /v1/notices", () => {
  test("publishes a notice: the text is built from a reviewed template, hashed, public, and marked pending review", async () => {
    const res = await publish(api.A);
    expect(res.status).toBe(201);
    expect(res.body).toMatchObject({ language: "en", reviewStatus: "pending-human-review", purposeKeys: ["analytics", "marketing"] });
    expect(res.body.version).toBeGreaterThanOrEqual(2); // the test fixture already holds version 1
    const pub = await api.http().get(`/v1/notices/${res.body.id as string}`);
    expect(pub.status).toBe(200);
    expect(pub.body.canonicalText).toContain("Example Controller Pvt Ltd");
    expect(pub.body.canonicalText).toContain("Understand how the app is used");
    expect(pub.body.canonicalText).toContain("Example Analytics Ltd");
    expect(pub.body.canonicalSha256).toBe(createHash("sha256").update(pub.body.canonicalText as string).digest("hex"));
    expect(res.body.canonicalSha256).toBe(pub.body.canonicalSha256);
    expect(pub.body.reviewStatus).toBe("pending-human-review");
  });

  test("stores what the receipts need: the retention, categories and withdrawal link of each purpose", async () => {
    const res = await publish(api.A);
    const stored = (await rows("SELECT purpose_definitions FROM privacy_notices WHERE id = $1", [res.body.id]))[0]?.purpose_definitions;
    expect(stored).toEqual([
      {
        key: "analytics", purpose: "Understand how the app is used", purposeCategory: ["analytics"], piiCategory: ["device type"],
        termination: NOTICE.withdrawalUrl, retentionDays: 365, thirdPartyDisclosure: true, thirdPartyName: "Example Analytics Ltd",
      },
      {
        key: "marketing", purpose: "Send product updates", purposeCategory: ["marketing"], piiCategory: ["email address"],
        termination: NOTICE.withdrawalUrl, retentionDays: 730, thirdPartyDisclosure: false, primaryPurpose: false,
      },
    ]);
  });

  test("the receipt names a purpose exactly as the notice does, without the spaces the caller put around it", async () => {
    const res = await publish(api.A, body({ purposes: [{ ...MARKETING, name: "  Send product updates  " }] }));
    expect(res.status).toBe(201);
    const stored = (await rows("SELECT purpose_definitions AS d, canonical_text AS t FROM privacy_notices WHERE id = $1", [res.body.id]))[0] as { d: { purpose: string }[]; t: string };
    expect(stored.d[0]?.purpose).toBe("Send product updates");
    expect(stored.t).toContain("Send product updates");
  });

  test("a consent can be recorded against the new notice, and the receipt carries its retention and withdrawal link", async () => {
    const res = await publish(api.A);
    const grant = await api.grant(api.A, { noticeId: res.body.id });
    expect(grant.status).toBe(201);
    const claims = JSON.parse(Buffer.from((grant.body.receipt as string).split(".")[1] as string, "base64url").toString()) as {
      saralNoticeSha256: string;
      services: { purposes: { purpose: string; termination: string }[] }[];
    };
    expect(claims.saralNoticeSha256).toBe(res.body.canonicalSha256);
    expect(claims.services[0]?.purposes[0]).toMatchObject({ purpose: "Understand how the app is used", termination: NOTICE.withdrawalUrl });
  });

  test("every publication is a new version of its language; another language starts at 1; an older version keeps its text", async () => {
    const first = await publish(api.A, body({ notice: { ...NOTICE, organisationName: "Old Name Pvt Ltd" } }));
    const second = await publish(api.A);
    expect(second.body.version).toBe((first.body.version as number) + 1);
    const hindi = await publish(api.A, body({ language: "hi" }));
    expect(hindi.status).toBe(201);
    expect(hindi.body).toMatchObject({ language: "hi", version: 1 });
    const old = await api.http().get(`/v1/notices/${first.body.id as string}`);
    expect(old.body.canonicalText).toContain("Old Name Pvt Ltd");
    expect(old.body.canonicalSha256).toBe(first.body.canonicalSha256);
  });

  test("ten publications at the same moment all succeed with different versions, and the list agrees with the versions", async () => {
    const done = await Promise.all(Array.from({ length: 10 }, () => publish(api.A, body({ language: "hi" }))));
    expect(done.map((r) => r.status)).toEqual(Array(10).fill(201));
    const versions = done.map((r) => r.body.version as number);
    expect(new Set(versions).size).toBe(10);
    const list = (await api.http().get("/v1/notices").set("Authorization", `Bearer ${api.A.admin}`)).body as { language: string; version: number }[];
    const hindi = list.filter((n) => n.language === "hi").map((n) => n.version);
    expect(hindi).toEqual([...hindi].sort((x, y) => y - x));
  });

  test("is an audit event, and the log still verifies", async () => {
    const res = await publish(api.A);
    const entry = (await rows("SELECT action, ref_table, ref_id FROM consent_audit_log WHERE tenant_id = $1 AND action = 'notice.published' AND ref_id = $2", [api.A.id, res.body.id]))[0];
    expect(entry).toMatchObject({ action: "notice.published", ref_table: "privacy_notices" });
    const verify = await api.http().get("/v1/audit/verify").set("Authorization", `Bearer ${api.A.auditor}`);
    expect(verify.body.ok).toBe(true);
  });

  test("publishes only for the caller's own organisation", async () => {
    const before = await count(api.B);
    const res = await publish(api.A);
    expect((await rows("SELECT tenant_id FROM privacy_notices WHERE id = $1", [res.body.id]))[0]?.tenant_id).toBe(api.A.id);
    expect(await count(api.B)).toBe(before);
  });

  test.each([
    ["a browser (publishable) key", (t: Tenant) => t.pk, 403],
    ["a server (sdk) key", (t: Tenant) => t.server, 403],
    ["a dpo key", (t: Tenant) => t.dpo, 403],
    ["an auditor key", (t: Tenant) => t.auditor, 403],
  ])("is refused for %s", async (_n, pick, status) => {
    const before = await count(api.A);
    expect((await publish(api.A, body(), pick(api.A))).status).toBe(status);
    expect(await count(api.A)).toBe(before);
  });

  test("is refused without a key", async () => {
    expect((await api.http().post("/v1/notices").send(body())).status).toBe(401);
  });

  const invalid: [string, unknown, string | RegExp][] = [
    ["a body that is not an object", [], "body"],
    ["no language", body({ language: undefined }), "language"],
    ["a language there is no template for", body({ language: "fr" }), "language"],
    ["no notice", body({ notice: undefined }), "notice"],
    ["a notice that is not an object", body({ notice: "text" }), "notice"],
    ["no purposes", body({ purposes: [] }), "purposes"],
    ["purposes that are not a list", body({ purposes: "analytics" }), "purposes"],
    ["more than 30 purposes", body({ purposes: Array.from({ length: 31 }, (_v, i) => ({ ...MARKETING, key: `p${String(i)}` })) }), "purposes"],
    ["an organisation name that is empty", body({ notice: { ...NOTICE, organisationName: "" } }), "notice.organisationName"],
    ["a withdrawal link that is not https", body({ notice: { ...NOTICE, withdrawalUrl: "http://example.org/w" } }), "notice.withdrawalUrl"],
    ["a line break in the organisation name", body({ notice: { ...NOTICE, organisationName: "A\nB" } }), "notice.organisationName"],
    ["a purpose with no description", body({ purposes: [{ ...ANALYTICS, description: undefined }] }), "purposes[0].description"],
    ["a purpose with no data items", body({ purposes: [{ ...ANALYTICS, dataItems: [] }] }), "purposes[0].dataItems"],
    ["a purpose key that is not a key", body({ purposes: [{ ...ANALYTICS, key: "Not A Key" }] }), "purposes[0].key"],
    ["a purpose key used twice", body({ purposes: [ANALYTICS, { ...MARKETING, key: "analytics" }] }), "purposes[1].key"],
    ["a retention in days that is negative", body({ purposes: [{ ...ANALYTICS, retentionDays: -1 }] }), "purposes[0].retentionDays"],
    ["a retention in days that is not whole", body({ purposes: [{ ...ANALYTICS, retentionDays: 1.5 }] }), "purposes[0].retentionDays"],
    ["a retention in days over 36500", body({ purposes: [{ ...ANALYTICS, retentionDays: 36501 }] }), "purposes[0].retentionDays"],
    ["no purpose category", body({ purposes: [{ ...ANALYTICS, purposeCategory: [] }] }), "purposes[0].purposeCategory"],
    ["a data category that is not text", body({ purposes: [{ ...ANALYTICS, piiCategory: [1] }] }), "purposes[0].piiCategory"],
    ["third-party disclosure that is not true or false", body({ purposes: [{ ...ANALYTICS, thirdPartyDisclosure: "yes" }] }), "purposes[0].thirdPartyDisclosure"],
    ["a disclosure to a third party that is not named", body({ purposes: [{ ...ANALYTICS, thirdPartyName: undefined }] }), "purposes[0].thirdPartyName"],
    ["a third party named but not listed in the notice", body({ purposes: [{ ...ANALYTICS, thirdPartyName: "Somebody Else Ltd" }] }), "purposes[0].thirdPartyName"],
    ["a third party named when nothing is disclosed", body({ purposes: [{ ...MARKETING, thirdPartyName: "Example Analytics Ltd" }] }), "purposes[0].thirdPartyName"],
    ["a field that is not part of a notice (a typo is not ignored)", body({ langauge: "en" }), "langauge"],
    ["more than 10 purpose categories", body({ purposes: [{ ...ANALYTICS, purposeCategory: Array.from({ length: 11 }, (_v, i) => `c${String(i)}`) }] }), "purposes[0].purposeCategory"],
    ["a field that is not part of the notice text", body({ notice: { ...NOTICE, websiteUrls: "https://example.org" } }), "notice.websiteUrls"],
    ["a purpose that is not an object", body({ purposes: ["analytics"] }), "purposes[0]"],
    ["a purpose name that is empty", body({ purposes: [{ ...ANALYTICS, name: "" }] }), "purposes[0].name"],
    ["a data category with a line break", body({ purposes: [{ ...ANALYTICS, piiCategory: ["a\nb"] }] }), "purposes[0].piiCategory"],
    ["a primary-purpose flag that is not true or false", body({ purposes: [{ ...ANALYTICS, primaryPurpose: "yes" }] }), "purposes[0].primaryPurpose"],
    ["a field that is not part of a purpose", body({ purposes: [{ ...ANALYTICS, retentionDay: 3 }] }), "purposes[0].retentionDay"],
  ];
  test.each(invalid)("rejects %s, and stores nothing", async (_n, bad, field) => {
    const before = await count(api.A);
    const res = await publish(api.A, bad);
    expect(res.status).toBe(400);
    expect(res.body.error).toBe("invalid_request");
    expect(res.body.field).toBe(field);
    expect(await count(api.A)).toBe(before);
  });

  test("reports every notice-text problem at once", async () => {
    const res = await publish(api.A, body({ notice: { ...NOTICE, organisationName: "", grievanceEmail: "nope" } }));
    expect(res.status).toBe(400);
    expect((res.body.errors as { field: string }[]).map((e) => e.field)).toEqual(["notice.organisationName", "notice.grievanceEmail"]);
  });

  test("does not echo the submitted text in the error", async () => {
    const res = await publish(api.A, body({ notice: { ...NOTICE, grievanceEmail: "private-looking@value" } }));
    expect(JSON.stringify(res.body)).not.toContain("private-looking");
  });
});

describe("GET /v1/notices", () => {
  test("lists the organisation's notices, newest first, without their text", async () => {
    const made = await publish(api.A);
    const res = await api.http().get("/v1/notices").set("Authorization", `Bearer ${api.A.admin}`);
    expect(res.status).toBe(200);
    const list = res.body as { id: string; version: number; language: string; reviewStatus: string; canonicalSha256: string; publishedAt: string; purposeKeys: string[]; canonicalText?: string }[];
    expect(list[0]?.id).toBe(made.body.id);
    expect(list[0]).toMatchObject({ language: "en", reviewStatus: "pending-human-review", purposeKeys: ["analytics", "marketing"] });
    expect(list.every((n) => n.canonicalText === undefined)).toBe(true);
    expect(list.some((n) => n.id === api.A.noticeId)).toBe(true);
    const times = list.map((n) => Date.parse(n.publishedAt));
    expect(times).toEqual([...times].sort((a, b) => b - a));
  });

  test("never lists another organisation's notices", async () => {
    const res = await api.http().get("/v1/notices").set("Authorization", `Bearer ${api.A.admin}`);
    expect((res.body as { id: string }[]).some((n) => n.id === api.B.noticeId)).toBe(false);
  });

  test("is for tenant admins only", async () => {
    expect((await api.http().get("/v1/notices").set("Authorization", `Bearer ${api.A.pk}`)).status).toBe(403);
    expect((await api.http().get("/v1/notices").set("Authorization", `Bearer ${api.A.dpo}`)).status).toBe(403);
    expect((await api.http().get("/v1/notices")).status).toBe(401);
  });
});

describe("the size of the receipts a notice would produce", () => {
  // A receipt is limited to 16 KiB. One that grants every purpose is the largest the notice can make.
  const wide = (n: number) =>
    Array.from({ length: n }, (_v, i) => ({
      ...MARKETING,
      key: `purpose_${String(i)}`,
      name: `Purpose number ${String(i)}`,
      purposeCategory: Array.from({ length: 10 }, (_w, j) => `${"c".repeat(95)}${String(j)}`),
      piiCategory: Array.from({ length: 10 }, (_w, j) => `${"d".repeat(95)}${String(j)}`),
    }));

  const items = (chars: number) => {
    const out: string[] = [];
    for (let left = chars; left > 0; left -= 100) out.push("p".repeat(Math.min(100, left)));
    return out.length > 0 ? out : ["p"];
  };
  /** Four wide purposes and a fifth whose categories total `chars` characters: the notice grows one character at a time. */
  const sized = (chars: number) => [
    ...wide(4),
    { ...MARKETING, key: "last", name: "Last purpose", purposeCategory: items(Math.min(chars, 1000)), piiCategory: items(Math.max(chars - 1000, 1)) },
  ];

  test("the largest notice accepted yields a receipt just under the limit, and one character more is refused", async () => {
    // A notice is accepted exactly when a receipt granting every purpose fits, so search for where that stops.
    let accepted = 1;
    let refused = 2000;
    let lastId = "";
    let refusals = 0;
    expect((await publish(api.A, body({ purposes: sized(1) }))).status).toBe(201);
    while (refused - accepted > 1) {
      const mid = Math.floor((accepted + refused) / 2);
      const res = await publish(api.A, body({ purposes: sized(mid) }));
      if (res.status === 201) {
        accepted = mid;
        lastId = res.body.id as string;
      } else {
        expect(res.status).toBe(422);
        expect(res.body.error).toBe("receipt_too_large");
        expect(res.body.message).toMatch(/16384/);
        refused = mid;
        refusals++;
      }
    }
    // The limit really was reached inside the range searched, so the checks below are about the limit and not about the range.
    expect(refusals).toBeGreaterThan(0);
    expect(accepted).toBeGreaterThan(1000);
    expect(lastId).not.toBe("");
    const grant = await api.grant(api.A, { noticeId: lastId, purposes: sized(accepted).map((p) => ({ key: p.key, granted: true })) });
    expect(grant.status).toBe(201);
    // Not under-counted (the receipt was issued) and not over-counted by much (it is within about a thousand characters of the limit).
    const length = (grant.body.receipt as string).length;
    expect(length).toBeLessThanOrEqual(16384);
    expect(length).toBeGreaterThan(16384 - 1200);
  });

  test("a refused notice is not stored and is not an audit event", async () => {
    const before = await count(api.A);
    const audits = async () => ((await rows("SELECT count(*)::int AS n FROM consent_audit_log WHERE tenant_id = $1 AND action = 'notice.published'", [api.A.id]))[0] as { n: number }).n;
    const logged = await audits();
    const res = await publish(api.A, body({ purposes: wide(30) }));
    expect(res.status).toBe(422);
    expect(await count(api.A)).toBe(before);
    expect(await audits()).toBe(logged);
  });

  test("an organisation that has no receipt profile yet can still publish, because there is nothing to measure against", async () => {
    const id = randomUUID();
    await api.db.owner.query("INSERT INTO tenants (id, name, slug) VALUES ($1, 'No Profile Org', $2)", [id, `no-profile-${id.slice(0, 8)}`]);
    const { token } = await issueApiKey(api.db.owner, api.keys.apiKeyPepper(), { tenantId: id, kind: "secret", scopes: ["tenant_admin"], name: "admin" });
    const res = await api.http().post("/v1/notices").set("Authorization", `Bearer ${token}`).send(body({ purposes: wide(30) }));
    expect(res.status).toBe(201);
  });
});
