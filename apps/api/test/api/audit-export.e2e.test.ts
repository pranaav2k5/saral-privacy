import { buildAnchor, verifyAgainstAnchor, verifyLinksAgainstAnchor, type Anchor, type ChainEntry } from "@saral/audit-chain";
import { AuditService } from "../../src/audit/audit.service.js";
import { startApi, type Api } from "./harness.js";

let api: Api;
/** Entry times come from a fixed clock, so a test that runs across midnight still finds its entries on the day it asks for. */
const DAY = "2026-11-06";
const AT = Date.parse(`${DAY}T10:00:00Z`);
beforeAll(async () => {
  api = await startApi();
  api.app.get(AuditService).now = () => AT;
  for (let i = 0; i < 4; i++) await api.grant(api.A, { identifier: `+91960000010${String(i)}` });
  await api.grant(api.B);
});
afterAll(async () => {
  await api.stop();
});

const today = () => DAY;
const bearer = (t: string) => ({ Authorization: `Bearer ${t}` });
const entries = (token: string, query = `?date=${today()}`) => api.http().get(`/v1/audit/entries${query}`).set(bearer(token));

describe("exporting a day's audit entries", () => {
  test("gives the day's entries in order, with the fields of an entry and nothing else", async () => {
    const res = await entries(api.A.auditor);
    expect(res.status).toBe(200);
    expect(res.body.map((e: ChainEntry) => e.seqNo)).toEqual(["1", "2", "3", "4"]);
    for (const e of res.body as ChainEntry[]) {
      expect(Object.keys(e).sort()).toEqual([
        "action", "actorId", "actorType", "canonicalSchemaVersion", "entryHash", "hmacSchemaVersion", "payloadSha256", "prevHash", "refId", "refTable", "seqNo", "tenantId", "ts",
      ]);
      expect(e.tenantId).toBe(api.A.id);
    }
    const stored = (await api.db.owner.query("SELECT entry_hash FROM consent_audit_log WHERE tenant_id = $1 ORDER BY seq_no", [api.A.id])).rows.map((r: { entry_hash: string }) => r.entry_hash);
    expect(res.body.map((e: ChainEntry) => e.entryHash)).toEqual(stored);
  });

  test("holds no personal data: neither the phone numbers that were used nor anything like them", async () => {
    const text = JSON.stringify((await entries(api.A.auditor)).body);
    expect(text).not.toMatch(/\+91960000010/);
    expect(text).not.toMatch(/\+91[0-9]{10}/);
  });

  test("is exactly what an outside auditor needs: with the day's anchor it checks out with no key, and with the key as well", async () => {
    const list = (await entries(api.A.auditor)).body as ChainEntry[];
    const anchor = (await api.http().get(`/v1/audit/merkle-root?date=${today()}`).set(bearer(api.A.auditor))).body as Anchor;
    expect(verifyLinksAgainstAnchor(list, anchor).ok).toBe(true);
    expect(verifyAgainstAnchor(list, anchor, (v) => api.keys.auditHmacKey(v)).ok).toBe(true);
    expect(anchor).toEqual(buildAnchor(api.A.id, today(), list));
  });

  test("is the tenant's own: another tenant's entries are never in it", async () => {
    const b = (await entries(api.B.auditor)).body as ChainEntry[];
    expect(b).toHaveLength(1);
    expect(b[0]?.tenantId).toBe(api.B.id);
  });

  test("a day with no entries is an empty list, not an error", async () => {
    const res = await entries(api.A.auditor, "?date=2000-01-01");
    expect(res.status).toBe(200);
    expect(res.body).toEqual([]);
  });

  test.each(["", "?date=", "?date=yesterday", "?date=2026-13-45", "?date=2026-1-1"])("the date is required and must be a real day: %s is 400", async (q) => {
    const res = await entries(api.A.auditor, q);
    expect(res.status).toBe(400);
    expect(res.body.field).toBe("date");
  });

  test("a day larger than the limit is refused with advice, as verification is", async () => {
    const service = api.app.get(AuditService);
    const original = service.maxEntries;
    service.maxEntries = 2;
    try {
      const res = await entries(api.A.auditor);
      expect(res.status).toBe(422);
      expect(res.body.error).toBe("too_large");
    } finally {
      service.maxEntries = original;
    }
  });

  test("is for the auditor scope: other scopes get 403, nobody gets 401", async () => {
    for (const token of [api.A.pk, api.A.server]) expect((await entries(token)).status).toBe(403);
    expect((await api.http().get(`/v1/audit/entries?date=${today()}`)).status).toBe(401);
    expect((await entries(api.A.admin)).status).toBe(403);
    expect((await entries(api.A.dpo)).status).toBe(403);
  });
});
