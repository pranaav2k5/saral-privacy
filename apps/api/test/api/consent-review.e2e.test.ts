import { randomUUID } from "node:crypto";
import { createStaffUser } from "../../src/staff/staff-admin.js";
import { startApi, type Api } from "./harness.js";
import { totpAt } from "./totp.js";

let api: Api;
const P1 = "+919810000001";
const P2 = "+919810000002";
const EMAIL = "Person.One@Example.org";

beforeAll(async () => {
  api = await startApi();
  // Person one in tenant A: two consents, the first withdrawn later. Person two: one. Person one's number also exists in tenant B.
  const first = (await api.grant(api.A, { identifier: P1 })).body;
  await api.grant(api.A, { identifier: P1, purposes: [{ key: "analytics", granted: true }, { key: "marketing", granted: true }] });
  await api.grant(api.A, { identifier: P2 });
  await api.grant(api.A, { identifier: EMAIL });
  await api.http().post(`/v1/consents/${first.consentId}/withdraw`).set(bearer(api.A.pk)).send({ identifier: P1 });
  await api.grant(api.B, { identifier: P1 });
});
afterAll(async () => {
  await api.stop();
});

const bearer = (t: string) => ({ Authorization: `Bearer ${t}` });
const owner = (sql: string, params: unknown[] = []) => api.db.owner.query(sql, params).then((r) => r.rows as Record<string, unknown>[]);
const search = (token: string, body: unknown) => api.http().post("/v1/consents/search").set(bearer(token)).send(body as object);
const summary = (token: string, query = "") => api.http().get(`/v1/consents/summary${query}`).set(bearer(token));
const count = async (sql: string, params: unknown[] = []) => (await owner(sql, params))[0]?.n as number;

describe("finding a person's consents", () => {
  test("lists them newest first with what the DPO needs to answer the person, and nothing that identifies them", async () => {
    const res = await search(api.A.dpo, { identifier: P1 });
    expect(res.status).toBe(200);
    expect(res.body.truncated).toBe(false);
    expect(res.body.consents).toHaveLength(2);
    const [newer, older] = res.body.consents;
    expect(newer).toMatchObject({ status: "granted", withdrawnAt: null, collectionMethod: "web_sdk", notice: { id: api.A.noticeId, version: expect.any(Number), language: expect.any(String) } });
    expect(newer.purposes).toEqual([{ key: "analytics", granted: true }, { key: "marketing", granted: true }]);
    expect(older).toMatchObject({ status: "withdrawn" });
    expect(older.withdrawnAt).toEqual(expect.any(String));
    expect(older.purposes).toEqual([{ key: "analytics", granted: true }, { key: "marketing", granted: false }]);
    expect(Date.parse(newer.grantedAt)).toBeGreaterThanOrEqual(Date.parse(older.grantedAt));
    const stored = await owner("SELECT r.id, rc.id AS receipt_id FROM consent_records r JOIN consent_receipts rc ON rc.consent_id = r.id WHERE r.id = $1", [older.id]);
    expect(older.receiptId).toBe(stored[0]?.receipt_id);
    const text = JSON.stringify(res.body);
    expect(text).not.toContain("9810000001");
    expect(text).not.toMatch(/pseudonym|principal/i);
    expect(Object.keys(newer).sort()).toEqual(["collectionMethod", "grantedAt", "id", "notice", "purposes", "receiptId", "status", "withdrawnAt"]);
  });

  test("finds the same person however the number is typed, and an email whatever its case", async () => {
    for (const identifier of ["+91 98100 00001", "+91-98100-00001", " +919810000001 "]) expect((await search(api.A.dpo, { identifier })).body.consents).toHaveLength(2);
    expect((await search(api.A.dpo, { identifier: "person.one@example.org" })).body.consents).toHaveLength(1);
    expect((await search(api.A.dpo, { identifier: "PERSON.ONE@EXAMPLE.ORG" })).body.consents).toHaveLength(1);
  });

  test("someone who has never given consent has none, and searching for them creates nothing", async () => {
    const people = await count("SELECT count(*)::int AS n FROM tenant_principals");
    const audit = await count("SELECT count(*)::int AS n FROM consent_audit_log");
    const res = await search(api.A.dpo, { identifier: "+919810099999" });
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ consents: [], truncated: false });
    expect(await count("SELECT count(*)::int AS n FROM tenant_principals")).toBe(people);
    expect(await count("SELECT count(*)::int AS n FROM consent_audit_log")).toBe(audit);
  });

  test("shows only the organisation's own people: the same number in another organisation is another person", async () => {
    const a = (await search(api.A.dpo, { identifier: P1 })).body.consents as { notice: { id: string } }[];
    const b = (await search(api.B.dpo, { identifier: P1 })).body.consents as { notice: { id: string } }[];
    expect(a.every((c) => c.notice.id === api.A.noticeId)).toBe(true);
    expect(b).toHaveLength(1);
    expect(b[0]?.notice.id).toBe(api.B.noticeId);
  });

  test("a search that finds a person is an audit event naming who looked and which person, and never the identifier", async () => {
    const before = await count("SELECT count(*)::int AS n FROM consent_audit_log WHERE tenant_id = $1 AND action = 'consent.searched'", [api.A.id]);
    await search(api.A.dpo, { identifier: P2 });
    const events = await owner("SELECT actor_type, actor_id, ref_table, ref_id FROM consent_audit_log WHERE tenant_id = $1 AND action = 'consent.searched' ORDER BY seq_no DESC", [api.A.id]);
    expect(events).toHaveLength(before + 1);
    // Person two and the person who used an email each have exactly one consent.
    const person = await owner("SELECT principal_id AS id FROM consent_records WHERE tenant_id = $1 GROUP BY principal_id HAVING count(*) = 1", [api.A.id]);
    expect(events[0]).toMatchObject({ actor_type: "system", ref_table: "tenant_principals" });
    expect(events[0]?.actor_id).toMatch(/^api-key:/);
    expect(person.map((p) => p.id)).toContain(events[0]?.ref_id);
    expect((await api.http().get("/v1/audit/verify").set(bearer(api.A.auditor))).body.ok).toBe(true);
  });

  test("shows 100 at most and says when there were more", async () => {
    const person = await owner("SELECT principal_id, notice_id, notice_sha256, purposes FROM consent_records WHERE tenant_id = $1 LIMIT 1", [api.B.id]);
    const p = person[0] as { principal_id: string; notice_id: string; notice_sha256: string; purposes: unknown };
    await owner(
      `INSERT INTO consent_records (id, tenant_id, principal_id, notice_id, notice_sha256, purposes, status, granted_at, collection_method)
       SELECT gen_random_uuid(), $1, $2, $3, $4, $5::jsonb, 'granted', now() - make_interval(secs => g), 'api' FROM generate_series(1, 120) g`,
      [api.B.id, p.principal_id, p.notice_id, p.notice_sha256, JSON.stringify(p.purposes)],
    );
    const res = await search(api.B.dpo, { identifier: P1 });
    expect(res.body.consents).toHaveLength(100);
    expect(res.body.truncated).toBe(true);
  });

  test("exactly 100 is not too many, and 101 is", async () => {
    await api.grant(api.B, { identifier: P2 });
    // The only person in tenant B with a single consent is the one just created.
    const people = await owner("SELECT principal_id FROM consent_records WHERE tenant_id = $1 GROUP BY principal_id HAVING count(*) = 1", [api.B.id]);
    const only = people[0] as { principal_id: string };
    const base = (await owner("SELECT notice_id, notice_sha256, purposes FROM consent_records WHERE tenant_id = $1 AND principal_id = $2", [api.B.id, only.principal_id]))[0] as { notice_id: string; notice_sha256: string; purposes: unknown };
    const add = (n: number) =>
      owner(
        `INSERT INTO consent_records (id, tenant_id, principal_id, notice_id, notice_sha256, purposes, status, granted_at, collection_method)
         SELECT gen_random_uuid(), $1, $2, $3, $4, $5::jsonb, 'granted', now() - make_interval(secs => g), 'api' FROM generate_series(1, $6::int) g`,
        [api.B.id, only.principal_id, base.notice_id, base.notice_sha256, JSON.stringify(base.purposes), n],
      );
    await add(99);
    const exact = await search(api.B.dpo, { identifier: P2 });
    expect(exact.body.consents).toHaveLength(100);
    expect(exact.body.truncated).toBe(false);
    await add(1);
    const over = await search(api.B.dpo, { identifier: P2 });
    expect(over.body.consents).toHaveLength(100);
    expect(over.body.truncated).toBe(true);
  });

  test.each([
    ["no identifier", {}],
    ["a number that is not a number", { identifier: "12345" }],
    ["an identifier that is not text", { identifier: 5 }],
    ["a body that is a list", []],
    ["a body that is text", "hello"],
  ])("%s is a bad request that does not echo what was sent", async (_n, body) => {
    const res = await search(api.A.dpo, body);
    expect(res.status).toBe(400);
    expect(JSON.stringify(res.body)).not.toContain("12345");
  });

  test("is for the data protection officer only", async () => {
    for (const token of [api.A.admin, api.A.auditor, api.A.server, api.A.pk]) expect((await search(token, { identifier: P1 })).status).toBe(403);
    expect((await api.http().post("/v1/consents/search").send({ identifier: P1 })).status).toBe(401);
  });
});

describe("the same, with a staff sign-in", () => {
  const PASSWORD = "correct horse battery staple";
  async function session(role: "dpo" | "tenant_admin") {
    const email = `review-${role}@example.org`;
    await createStaffUser(api.db.owner, api.keys, { tenantId: api.A.id, email, password: PASSWORD, role });
    const l = await api.http().post("/v1/auth/login").send({ tenant: "tenant-a", email, password: PASSWORD });
    const e = await api.http().post("/v1/auth/mfa/enroll").send({ challenge: l.body.challenge });
    const v = await api.http().post("/v1/auth/mfa/verify").send({ challenge: l.body.challenge, code: totpAt(e.body.secret, Date.now()) });
    return v.body.token as string;
  }

  test("an officer's session may search, and it is recorded as the officer's doing; an administrator's may not", async () => {
    const officer = await session("dpo");
    const res = await search(officer, { identifier: P1 });
    expect(res.status).toBe(200);
    const last = (await owner("SELECT actor_type, actor_id FROM consent_audit_log WHERE tenant_id = $1 AND action = 'consent.searched' ORDER BY seq_no DESC LIMIT 1", [api.A.id]))[0];
    expect(last).toMatchObject({ actor_type: "dpo" });
    expect(last?.actor_id).toMatch(/^staff:/);
    expect((await search(await session("tenant_admin"), { identifier: P1 })).status).toBe(403);
    expect((await summary(officer)).status).toBe(200);
  });
});

describe("the consent summary", () => {
  test("counts consents by state, and by purpose for the purposes that were agreed to", async () => {
    const res = await summary(api.A.dpo);
    expect(res.status).toBe(200);
    // Tenant A: P1 twice (one withdrawn), P2, the email: four consents, three active and one withdrawn.
    expect(res.body.totals).toEqual({ active: 3, withdrawn: 1, expired: 0 });
    const analytics = res.body.purposes.find((p: { key: string }) => p.key === "analytics");
    const marketing = res.body.purposes.find((p: { key: string }) => p.key === "marketing");
    expect(analytics).toEqual({ key: "analytics", active: 3, withdrawn: 1, expired: 0 });
    // Marketing was agreed to once (the second consent of person one) and refused in the others, which do not count.
    expect(marketing).toEqual({ key: "marketing", active: 1, withdrawn: 0, expired: 0 });
  });

  test("gives one line for every day of the period, the oldest first, with grants and withdrawals made that day", async () => {
    const res = await summary(api.A.dpo, "?days=7");
    expect(res.body.days).toHaveLength(7);
    const dates = res.body.days.map((d: { date: string }) => d.date);
    expect([...dates].sort()).toEqual(dates);
    const today = new Date().toISOString().slice(0, 10);
    expect(res.body.to).toBe(today);
    expect(res.body.from).toBe(dates[0]);
    expect(res.body.days.at(-1)).toEqual({ date: today, granted: 4, withdrawn: 1 });
    expect(res.body.days.slice(0, 6).every((d: { granted: number; withdrawn: number }) => d.granted === 0 && d.withdrawn === 0)).toBe(true);
  });

  test("covers 30 days unless asked for another number from 1 to 366", async () => {
    expect((await summary(api.A.dpo)).body.days).toHaveLength(30);
    expect((await summary(api.A.dpo, "?days=1")).body.days).toHaveLength(1);
    expect((await summary(api.A.dpo, "?days=366")).body.days).toHaveLength(366);
    for (const days of ["0", "367", "-1", "abc", "1.5", ""]) {
      const res = await summary(api.A.dpo, `?days=${days}`);
      expect({ days, status: res.status, field: res.body.field }).toEqual({ days, status: 400, field: "days" });
    }
  });

  test("a consent given before the period still counts in the totals and the purposes, but not in the days", async () => {
    const old = randomUUID();
    const person = (await owner("SELECT principal_id, notice_id, notice_sha256 FROM consent_records WHERE tenant_id = $1 LIMIT 1", [api.A.id]))[0] as { principal_id: string; notice_id: string; notice_sha256: string };
    await owner(
      `INSERT INTO consent_records (id, tenant_id, principal_id, notice_id, notice_sha256, purposes, status, granted_at, collection_method)
       VALUES ($1, $2, $3, $4, $5, '[{"key":"analytics","granted":true,"retentionDays":365}]', 'granted', now() - interval '200 days', 'api')`,
      [old, api.A.id, person.principal_id, person.notice_id, person.notice_sha256],
    );
    const res = await summary(api.A.dpo, "?days=30");
    expect(res.body.totals.active).toBe(4);
    expect(res.body.purposes.find((p: { key: string }) => p.key === "analytics").active).toBe(4);
    expect(res.body.days.reduce((n: number, d: { granted: number }) => n + d.granted, 0)).toBe(4);
    expect((await summary(api.A.dpo, "?days=366")).body.days.reduce((n: number, d: { granted: number }) => n + d.granted, 0)).toBe(5);
    await owner("UPDATE consent_records SET status = 'expired' WHERE id = $1", [old]);
    expect((await summary(api.A.dpo)).body.totals).toEqual({ active: 3, withdrawn: 1, expired: 1 });
  });

  test("is the organisation's own, and holds no personal data", async () => {
    const b = await summary(api.B.dpo);
    expect(b.body.totals.active + b.body.totals.withdrawn).toBeGreaterThan(0);
    expect(JSON.stringify(b.body)).not.toMatch(/\+91|@|pseudonym|principal/i);
    expect((await summary(api.A.dpo)).body.totals.active).not.toBe(b.body.totals.active);
  });

  test("is for the data protection officer only", async () => {
    for (const token of [api.A.admin, api.A.auditor, api.A.server, api.A.pk]) expect((await summary(token)).status).toBe(403);
    expect((await api.http().get("/v1/consents/summary")).status).toBe(401);
  });
});
