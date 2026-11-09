import { createHash, randomUUID } from "node:crypto";
import { sha256Hex } from "@saral/audit-chain";
import { Database } from "../../src/db/database.js";
import { ReminderJob } from "../../src/reminders/reminder-job.js";
import { WebhookService } from "../../src/webhooks/webhook.service.js";
import { WebhookWorker } from "../../src/webhooks/worker.js";
import { startApi, type Api } from "./harness.js";

let api: Api;
let job: ReminderJob;
beforeAll(async () => {
  api = await startApi();
  job = api.app.get(ReminderJob);
});
afterAll(async () => {
  await api.stop();
});
beforeEach(async () => {
  // Every test starts from nothing: no incidents, no records, no reminders, no deliveries and no endpoints, in either organisation.
  for (const t of [api.A.id, api.B.id]) {
    await api.db.owner.query("DELETE FROM webhook_deliveries WHERE tenant_id = $1", [t]);
    await api.db.owner.query("DELETE FROM reminders_sent WHERE tenant_id = $1", [t]);
    await api.db.owner.query("DELETE FROM breach_incidents WHERE tenant_id = $1", [t]);
    await api.db.owner.query("DELETE FROM ropa_versions WHERE tenant_id = $1", [t]);
    await api.db.owner.query("UPDATE webhook_endpoints SET disabled_at = coalesce(disabled_at, now()) WHERE tenant_id = $1", [t]);
  }
  api.hooks.calls = [];
  api.hooks.script = [200];
});

const HOUR = 3_600_000;
const DAY = 24 * HOUR;
const bearer = (t: string) => ({ Authorization: `Bearer ${t}` });
const rows = async (sql: string, params: unknown[] = []) => (await api.db.owner.query(sql, params)).rows as Record<string, unknown>[];
const sha = (t: string) => createHash("sha256").update(t, "utf8").digest("hex");

const REPORT = {
  title: "Laptop lost", description: "A laptop with a customer list was lost on a train.", nature: ["confidentiality"], dataCategories: ["phone numbers"],
  likelyConsequences: "Calls from strangers.", measuresTaken: "The laptop was wiped remotely.",
};
/** An incident found at `found`, so the Board's deadline is 72 hours after it. */
async function breach(tenant: { dpo: string }, found: Date): Promise<{ id: string; deadline: number }> {
  const res = await api.http().post("/v1/breaches").set(bearer(tenant.dpo)).send({ ...REPORT, discoveredAt: found.toISOString() });
  expect(res.status).toBe(201);
  return { id: res.body.id as string, deadline: found.getTime() + 72 * HOUR };
}
const post = (token: string, id: string, path: string, body?: unknown) => api.http().post(`/v1/breaches/${id}${path}`).set(bearer(token)).send(body as object);
async function signOff(tenant: { dpo: string }, id: string) {
  const drafts = (await api.http().get(`/v1/breaches/${id}/drafts`).set(bearer(tenant.dpo))).body as { boardSha256: string; principalSha256: string };
  expect((await post(tenant.dpo, id, "/sign-off", { boardSha256: drafts.boardSha256, principalSha256: drafts.principalSha256 })).status).toBe(200);
}
async function tellBoard(tenant: { dpo: string }, id: string) {
  await signOff(tenant, id);
  expect((await post(tenant.dpo, id, "/board-notified", { notifiedAt: new Date().toISOString(), reference: "DPB-1" })).status).toBe(200);
}

const NEW = ["breach.deadline_soon", "breach.deadline_passed", "ropa.review_soon", "ropa.review_overdue"];
const subscribe = async (tenant: { admin: string }, name: string, events: string[] = NEW) => {
  const res = await api.http().post("/v1/webhook-endpoints").set(bearer(tenant.admin)).send({ url: `https://${name}.example.org/hook`, events });
  expect(res.status).toBe(201);
  return res.body.id as string;
};
const deliveriesOf = (endpoint: string) => rows("SELECT event_type, payload, state FROM webhook_deliveries WHERE endpoint_id = $1 ORDER BY created_at, id", [endpoint]);

/** Saves a record whose next review is due on `due` (the job reads nothing else from it). */
async function savedRecord(tenantId: string, version: number, due: string | undefined, id = randomUUID()) {
  const text = JSON.stringify({ review: { lastReviewedOn: "2026-01-01", ...(due === undefined ? {} : { nextReviewDue: due }) } });
  await api.db.owner.query("INSERT INTO ropa_versions (id, tenant_id, version, document_json, document_sha256, created_by) VALUES ($1, $2, $3, $4, $5, 'test')", [id, tenantId, version, text, sha(text)]);
  return id;
}

describe("breach reminders", () => {
  test("a breach whose Board deadline is within 24 hours queues one reminder, with ids and dates and no words, to the endpoints that asked for it", async () => {
    const ep = await subscribe(api.A, "soon");
    const other = await subscribe(api.A, "other", ["consent.granted"]);
    const b = await breach(api.A, new Date(Date.now() - HOUR));
    const report = await job.run({ now: new Date(b.deadline - 24 * HOUR) });
    expect(report.queued["breach.deadline_soon"]).toBe(1);
    const d = await deliveriesOf(ep);
    expect(d).toHaveLength(1);
    expect(d[0]).toMatchObject({ event_type: "breach.deadline_soon", state: "pending" });
    expect(d[0]?.payload).toEqual({ breachId: b.id, boardDeadline: new Date(b.deadline).toISOString() });
    expect(JSON.stringify(d[0]?.payload)).not.toContain("Laptop");
    expect(await deliveriesOf(other)).toHaveLength(0);
  });

  test("the reminder is audited by the system, with a hash of what it was and how many endpoints were told, and the chain still verifies", async () => {
    const ep = await subscribe(api.A, "audited");
    await subscribe(api.A, "audited-two");
    const b = await breach(api.A, new Date(Date.now() - HOUR));
    await job.run({ now: new Date(b.deadline - HOUR) });
    const events = await rows("SELECT actor_type, actor_id, ref_table, ref_id, payload_sha256 FROM consent_audit_log WHERE tenant_id = $1 AND action = 'reminder.sent' AND ref_id = $2", [api.A.id, b.id]);
    expect(events).toEqual([{
      actor_type: "system", actor_id: "system:reminder-job", ref_table: "breach_incidents", ref_id: b.id,
      payload_sha256: sha256Hex(JSON.stringify(["saral.reminder", 1, api.A.id, "breach", b.id, "soon", 2])),
    }]);
    expect(ep).toBeDefined();
    expect((await api.http().get("/v1/audit/verify").set(bearer(api.A.auditor))).body.ok).toBe(true);
  });

  test("running again changes nothing, and a reminder is not queued twice even by two runs at once", async () => {
    const ep = await subscribe(api.A, "once");
    const b = await breach(api.A, new Date(Date.now() - HOUR));
    const now = new Date(b.deadline - 2 * HOUR);
    // Open the connections first: the pool makes them one at a time on demand, which would let the first run finish before the others began.
    const db = api.app.get(Database);
    await Promise.all(Array.from({ length: 8 }, () => db.inScope({}, (c) => c.query("SELECT pg_sleep(0.3)"))));
    const runs = await Promise.all(Array.from({ length: 6 }, () => job.run({ now })));
    expect(runs.reduce((n, r) => n + r.queued["breach.deadline_soon"], 0)).toBe(1);
    // The others wait for the lock and find the reminder sent; without the lock they would collide on the table's key and fail.
    expect(runs.flatMap((r) => r.failures)).toEqual([]);
    const again = await job.run({ now });
    expect(again.queued["breach.deadline_soon"]).toBe(0);
    expect(await deliveriesOf(ep)).toHaveLength(1);
    expect(await rows("SELECT 1 FROM reminders_sent WHERE tenant_id = $1", [api.A.id])).toHaveLength(1);
  });

  test("once the deadline has passed a second reminder is queued, once, and the first is not repeated", async () => {
    const ep = await subscribe(api.A, "passed");
    const b = await breach(api.A, new Date(Date.now() - HOUR));
    await job.run({ now: new Date(b.deadline - HOUR) });
    const late = await job.run({ now: new Date(b.deadline + HOUR) });
    expect(late.queued).toMatchObject({ "breach.deadline_passed": 1, "breach.deadline_soon": 0 });
    await job.run({ now: new Date(b.deadline + 2 * HOUR) });
    expect((await deliveriesOf(ep)).map((d) => d.event_type)).toEqual(["breach.deadline_soon", "breach.deadline_passed"]);
  });

  test("a breach found long ago that was never reminded is reminded that the deadline has passed, and not that it is near", async () => {
    const ep = await subscribe(api.A, "catchup");
    const b = await breach(api.A, new Date(Date.now() - 10 * DAY));
    const r = await job.run({ now: new Date() });
    expect(r.queued).toMatchObject({ "breach.deadline_passed": 1, "breach.deadline_soon": 0 });
    expect((await deliveriesOf(ep)).map((d) => d.event_type)).toEqual(["breach.deadline_passed"]);
    expect(b.id).toBeDefined();
  });

  test("nothing is queued while more than 24 hours remain", async () => {
    const ep = await subscribe(api.A, "early");
    const b = await breach(api.A, new Date(Date.now() - HOUR));
    const r = await job.run({ now: new Date(b.deadline - 24 * HOUR - 1) });
    expect(r.queued["breach.deadline_soon"]).toBe(0);
    expect(await deliveriesOf(ep)).toHaveLength(0);
    expect(await rows("SELECT 1 FROM reminders_sent")).toHaveLength(0);
  });

  test("a breach the Board has been told about, or that is closed, is never reminded; one that is signed off but not yet told still is", async () => {
    const ep = await subscribe(api.A, "told");
    const told = await breach(api.A, new Date(Date.now() - HOUR));
    await tellBoard(api.A, told.id);
    const signed = await breach(api.A, new Date(Date.now() - 2 * HOUR));
    await signOff(api.A, signed.id);
    const plain = await breach(api.A, new Date(Date.now() - 3 * HOUR));
    const r = await job.run({ now: new Date(Date.now() + 100 * DAY) });
    expect(r.queued["breach.deadline_passed"]).toBe(2);
    const ids = (await deliveriesOf(ep)).map((d) => (d.payload as { breachId: string }).breachId).sort();
    expect(ids).toEqual([signed.id, plain.id].sort());
  });

  test("with nobody asking for the reminder nothing is recorded as sent, it is counted as waiting, and it goes out when an endpoint asks", async () => {
    await subscribe(api.A, "wrong-event", ["consent.granted"]);
    const b = await breach(api.A, new Date(Date.now() - HOUR));
    const now = new Date(b.deadline - HOUR);
    const first = await job.run({ now });
    expect(first.queued["breach.deadline_soon"]).toBe(0);
    expect(first.waiting).toBe(1);
    expect(await rows("SELECT 1 FROM reminders_sent WHERE tenant_id = $1", [api.A.id])).toHaveLength(0);
    expect(await rows("SELECT 1 FROM consent_audit_log WHERE tenant_id = $1 AND action = 'reminder.sent' AND ref_id = $2", [api.A.id, b.id])).toHaveLength(0);
    const ep = await subscribe(api.A, "late-subscriber");
    const second = await job.run({ now });
    expect(second.queued["breach.deadline_soon"]).toBe(1);
    expect(second.waiting).toBe(0);
    expect(await deliveriesOf(ep)).toHaveLength(1);
  });

  test("a disabled endpoint is not told", async () => {
    const ep = await subscribe(api.A, "disabled");
    await api.http().delete(`/v1/webhook-endpoints/${ep}`).set(bearer(api.A.admin));
    const b = await breach(api.A, new Date(Date.now() - HOUR));
    const r = await job.run({ now: new Date(b.deadline - HOUR) });
    expect(r.waiting).toBe(1);
    expect(await deliveriesOf(ep)).toHaveLength(0);
  });

  test("each organisation's incidents go to its own endpoints only", async () => {
    const a = await subscribe(api.A, "mine-a");
    const bEp = await subscribe(api.B, "mine-b");
    const incident = await breach(api.B, new Date(Date.now() - HOUR));
    await job.run({ now: new Date(incident.deadline - HOUR) });
    expect(await deliveriesOf(a)).toHaveLength(0);
    expect(await deliveriesOf(bEp)).toHaveLength(1);
    expect(await rows("SELECT tenant_id FROM reminders_sent")).toEqual([{ tenant_id: api.B.id }]);
  });

  test("the worker delivers it, signed, as an event of the new type holding ids and a date only", async () => {
    const ep = await subscribe(api.A, "delivered");
    const b = await breach(api.A, new Date(Date.now() - HOUR));
    await job.run({ now: new Date(b.deadline - HOUR) });
    await api.app.get(WebhookWorker).runOnce(new Date(Date.now() + 1000));
    const call = api.hooks.calls.find((c) => c.url === "https://delivered.example.org/hook") as { body: string; headers: Record<string, string> };
    expect(call).toBeDefined();
    const body = JSON.parse(call.body) as { type: string; data: Record<string, unknown> };
    expect(body.type).toBe("breach.deadline_soon");
    expect(Object.keys(body.data).sort()).toEqual(["boardDeadline", "breachId"]);
    expect(call.headers["X-Saral-Signature"]).toMatch(/^t=\d+,v1=[0-9a-f]{64}$/);
    expect(ep).toBeDefined();
  });
});

describe("record of processing reminders", () => {
  const today = () => new Date().toISOString().slice(0, 10);
  const inDays = (n: number) => new Date(Date.now() + n * DAY).toISOString().slice(0, 10);

  test("a review due within 14 days queues a reminder with the version and the date, and not twice", async () => {
    const ep = await subscribe(api.A, "ropa-soon");
    const id = await savedRecord(api.A.id, 1, inDays(10));
    const r = await job.run({ now: new Date() });
    expect(r.queued["ropa.review_soon"]).toBe(1);
    expect((await deliveriesOf(ep))[0]).toMatchObject({ event_type: "ropa.review_soon", payload: { ropaVersionId: id, version: 1, nextReviewDue: inDays(10) } });
    await job.run({ now: new Date() });
    expect(await deliveriesOf(ep)).toHaveLength(1);
  });

  test("a review that is overdue queues an overdue reminder, and after a soon one both have been sent once", async () => {
    const ep = await subscribe(api.A, "ropa-overdue");
    await savedRecord(api.A.id, 1, inDays(3));
    await job.run({ now: new Date() });
    const later = await job.run({ now: new Date(Date.now() + 5 * DAY) });
    expect(later.queued).toMatchObject({ "ropa.review_overdue": 1, "ropa.review_soon": 0 });
    expect((await deliveriesOf(ep)).map((d) => d.event_type)).toEqual(["ropa.review_soon", "ropa.review_overdue"]);
  });

  test("a review due today is soon, and one due yesterday is overdue", async () => {
    const ep = await subscribe(api.A, "ropa-edge");
    await savedRecord(api.A.id, 1, today());
    expect((await job.run({ now: new Date() })).queued).toMatchObject({ "ropa.review_soon": 1, "ropa.review_overdue": 0 });
    await savedRecord(api.A.id, 2, inDays(-1));
    expect((await job.run({ now: new Date() })).queued).toMatchObject({ "ropa.review_overdue": 1 });
    expect(ep).toBeDefined();
  });

  test("a record with no next review date, or one far off, queues nothing", async () => {
    const ep = await subscribe(api.A, "ropa-none");
    await savedRecord(api.A.id, 1, undefined);
    expect((await job.run({ now: new Date() })).queued["ropa.review_soon"]).toBe(0);
    await savedRecord(api.A.id, 2, inDays(15));
    const r = await job.run({ now: new Date() });
    expect(r.queued["ropa.review_soon"] + r.queued["ropa.review_overdue"]).toBe(0);
    expect(await deliveriesOf(ep)).toHaveLength(0);
  });

  test("only the newest version counts: an old overdue one that a newer version has put right is not reminded", async () => {
    const ep = await subscribe(api.A, "ropa-latest");
    await savedRecord(api.A.id, 1, inDays(-30));
    await savedRecord(api.A.id, 2, inDays(200));
    await job.run({ now: new Date() });
    expect(await deliveriesOf(ep)).toHaveLength(0);
  });

  test("a new version that is due again gets its own reminders", async () => {
    const ep = await subscribe(api.A, "ropa-again");
    await savedRecord(api.A.id, 1, inDays(5));
    await job.run({ now: new Date() });
    await savedRecord(api.A.id, 2, inDays(6));
    await job.run({ now: new Date() });
    expect((await deliveriesOf(ep)).map((d) => (d.payload as { version: number }).version)).toEqual([1, 2]);
  });

  test("an organisation with no record has nothing to be reminded of", async () => {
    await subscribe(api.A, "ropa-empty");
    const r = await job.run({ now: new Date() });
    expect(Object.values(r.queued).reduce((a, b) => a + b, 0)).toBe(0);
    expect(r.failures).toEqual([]);
  });

  test("a stored record that cannot be read is skipped without stopping the run", async () => {
    const ep = await subscribe(api.A, "ropa-garbled");
    const text = '{"review":"not an object"}';
    await api.db.owner.query("INSERT INTO ropa_versions (id, tenant_id, version, document_json, document_sha256, created_by) VALUES ($1, $2, 1, $3, $4, 'test')", [randomUUID(), api.A.id, text, sha(text)]);
    const r = await job.run({ now: new Date() });
    expect(r.failures).toEqual([]);
    expect(await deliveriesOf(ep)).toHaveLength(0);
  });
});

describe("the job as a whole", () => {
  test("one organisation failing is reported with its id and the others are still done", async () => {
    await subscribe(api.A, "fail-a");
    const bEp = await subscribe(api.B, "fail-b");
    const a = await breach(api.A, new Date(Date.now() - HOUR));
    const b = await breach(api.B, new Date(Date.now() - HOUR));
    const webhooks = api.app.get(WebhookService);
    const original = webhooks.enqueue.bind(webhooks);
    webhooks.enqueue = async (c, tenantId, type, data) => {
      if (tenantId === api.A.id) throw new Error("the queue is broken");
      return original(c, tenantId, type, data);
    };
    try {
      const r = await job.run({ now: new Date(Math.max(a.deadline, b.deadline) - HOUR) });
      expect(r.failures).toEqual([{ tenantId: api.A.id, message: "the queue is broken" }]);
      expect(r.queued["breach.deadline_soon"]).toBe(1);
      expect(await deliveriesOf(bEp)).toHaveLength(1);
      expect(await rows("SELECT 1 FROM reminders_sent WHERE tenant_id = $1", [api.A.id])).toHaveLength(0);
    } finally {
      webhooks.enqueue = original;
    }
  });

  test("an endpoint can be registered for the four reminder events, and an event that does not exist is still refused", async () => {
    expect((await api.http().post("/v1/webhook-endpoints").set(bearer(api.A.admin)).send({ url: "https://register.example.org/hook", events: NEW })).status).toBe(201);
    const bad = await api.http().post("/v1/webhook-endpoints").set(bearer(api.A.admin)).send({ url: "https://register2.example.org/hook", events: ["breach.exploded"] });
    expect(bad.status).toBe(400);
    expect(bad.body.field).toBe("events");
  });

  test("the report counts the organisations it looked at", async () => {
    const r = await job.run({ now: new Date() });
    expect(r.tenants).toBeGreaterThanOrEqual(2);
  });
});
