import { AuditService } from "../../src/audit/audit.service.js";
import { PHONE, startApi, type Api } from "./harness.js";

let api: Api;

beforeAll(async () => {
  api = await startApi();
});

afterAll(async () => {
  await api.stop();
});

const auditor = (t: { auditor: string }) => ({ Authorization: `Bearer ${t.auditor}` });
const verify = (t: { auditor: string }, query = "") => api.http().get(`/v1/audit/verify${query}`).set(auditor(t));

describe("the audit log of the consent API", () => {
  test("an empty log verifies", async () => {
    const res = await verify(api.B);
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ ok: true, count: 0 });
  });

  test("every user-facing action adds exactly one entry and the chain verifies", async () => {
    const g1 = (await api.grant(api.A, { identifier: "+919500000001" })).body;
    await api.grant(api.A, { identifier: "+919500000002" });
    await api.http().post(`/v1/consents/${g1.consentId}/withdraw`).set("Authorization", `Bearer ${api.A.pk}`).send({ identifier: "+919500000001" });
    // A failed request adds nothing.
    await api.grant(api.A, { purposes: [{ key: "nope", granted: true }] });

    const rows = (await api.db.owner.query("SELECT seq_no, action FROM consent_audit_log WHERE tenant_id = $1 ORDER BY seq_no", [api.A.id])).rows;
    expect(rows.map((r: { action: string }) => r.action)).toEqual(["consent.granted", "consent.granted", "consent.withdrawn"]);
    const res = await verify(api.A);
    expect(res.body).toMatchObject({ ok: true, count: 3, firstSeqNo: "1", lastSeqNo: "3" });
    expect(res.body.merkleRoot).toMatch(/^[0-9a-f]{64}$/);
    expect(res.body.headHash).toMatch(/^[0-9a-f]{64}$/);
  });

  test("a tenant's log is separate: another tenant's actions never appear", async () => {
    await api.grant(api.B);
    expect((await verify(api.B)).body).toMatchObject({ ok: true, count: 1 });
    expect((await verify(api.A)).body.count).toBe(3);
  });

  test("a day can be verified on its own, and its Merkle root is served", async () => {
    const today = new Date().toISOString().slice(0, 10);
    const day = await verify(api.A, `?date=${today}`);
    expect(day.body).toMatchObject({ ok: true, count: 3 });
    const root = await api.http().get(`/v1/audit/merkle-root?date=${today}`).set(auditor(api.A));
    expect(root.status).toBe(200);
    expect(root.body).toMatchObject({ date: today, count: 3, firstSeqNo: "1", lastSeqNo: "3", merkleRoot: day.body.merkleRoot });
    expect((await api.http().get("/v1/audit/merkle-root?date=2000-01-01").set(auditor(api.A))).status).toBe(404);
  });

  test.each(["?date=yesterday", "?date=2026-13-45", "?date=2026-1-1"])("a bad date %s is 400", async (q) => {
    expect((await verify(api.A, q)).status).toBe(400);
    expect((await api.http().get(`/v1/audit/merkle-root${q}`).set(auditor(api.A))).status).toBe(400);
  });

  test("a change made behind the API's back is reported with the failing seq number", async () => {
    await api.db.owner.query("ALTER TABLE consent_audit_log DISABLE TRIGGER audit_no_update_delete");
    try {
      await api.db.owner.query("UPDATE consent_audit_log SET action = 'consent.withdrawn' WHERE tenant_id = $1 AND seq_no = 2", [api.A.id]);
    } finally {
      await api.db.owner.query("ALTER TABLE consent_audit_log ENABLE TRIGGER audit_no_update_delete");
    }
    const res = await verify(api.A);
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ ok: false, failure: "hash_mismatch", seqNo: "2" });
    expect((await verify(api.B)).body.ok).toBe(true); // the other tenant is unaffected
  });
});

describe("a verify request is bounded", () => {
  test("a chain larger than the limit is refused with advice to verify by day, instead of being loaded into memory", async () => {
    const service = api.app.get(AuditService);
    const original = service.maxEntries;
    service.maxEntries = 2;
    try {
      const full = await verify(api.A);
      expect(full.status).toBe(422);
      expect(full.body).toMatchObject({ error: "too_large" });
      expect(full.body.message).toMatch(/date=/);
      const today = new Date().toISOString().slice(0, 10);
      expect((await verify(api.A, `?date=${today}`)).status).toBe(422);
      expect((await api.http().get(`/v1/audit/merkle-root?date=${today}`).set(auditor(api.A))).status).toBe(422);
      expect((await verify(api.A, "?date=2000-01-01")).status).toBe(200); // an empty day is within the limit
    } finally {
      service.maxEntries = original;
    }
    expect((await verify(api.A)).status).toBe(200);
  });
});

describe("concurrency", () => {
  test("100 concurrent consents for one tenant give 100 contiguous seq numbers and a valid chain", async () => {
    const before = (await api.db.owner.query("SELECT count(*)::int AS n FROM consent_audit_log WHERE tenant_id = $1", [api.B.id])).rows[0].n as number;
    const results = await Promise.all(Array.from({ length: 100 }, (_, i) => api.grant(api.B, { identifier: `+9197000${String(10000 + i)}` })));
    expect(results.map((r) => r.status)).toEqual(Array(100).fill(201));
    const seqs = (await api.db.owner.query("SELECT seq_no::int AS s FROM consent_audit_log WHERE tenant_id = $1 ORDER BY seq_no", [api.B.id])).rows.map((r: { s: number }) => r.s);
    expect(seqs).toEqual(Array.from({ length: before + 100 }, (_, i) => i + 1));
    expect((await verify(api.B)).body).toMatchObject({ ok: true, count: before + 100 });
    expect(PHONE).toBeDefined();
  }, 60000);
});
