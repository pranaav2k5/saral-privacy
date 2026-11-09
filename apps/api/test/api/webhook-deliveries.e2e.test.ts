import { randomUUID } from "node:crypto";
import { startApi, type Api } from "./harness.js";
import { WebhookWorker } from "../../src/webhooks/worker.js";

let api: Api;
let worker: WebhookWorker;
beforeAll(async () => {
  api = await startApi();
  worker = api.app.get(WebhookWorker);
});
afterAll(async () => {
  await api.stop();
});
beforeEach(() => {
  api.hooks.calls = [];
  api.hooks.answers = [];
  api.hooks.script = [200];
});

const bearer = (t: string) => ({ Authorization: `Bearer ${t}` });
const owner = (sql: string, params: unknown[] = []) => api.db.owner.query(sql, params).then((r) => r.rows as Record<string, unknown>[]);
const register = async (tenant: { admin: string }, name: string) =>
  (await api.http().post("/v1/webhook-endpoints").set(bearer(tenant.admin)).send({ url: `https://${name}.example.org/hook`, events: ["consent.granted", "consent.withdrawn"] })).body as { id: string };
const listDeliveries = (token: string, endpoint: string, query = "") => api.http().get(`/v1/webhook-endpoints/${endpoint}/deliveries${query}`).set(bearer(token));
const again = (token: string, endpoint: string, delivery: string) => api.http().post(`/v1/webhook-endpoints/${endpoint}/deliveries/${delivery}/redeliver`).set(bearer(token));
const endpointList = async (tenant: { admin: string }) => (await api.http().get("/v1/webhook-endpoints").set(bearer(tenant.admin))).body as { id: string; disabledAt: string | null; disabledReason: string | null }[];

/** Puts a delivery straight into a state; `ageMinutes` makes older ones sort later. */
async function delivery(tenantId: string, endpointId: string, state: "pending" | "delivered" | "failed", over: { attempts?: number; ageMinutes?: number; status?: number | null; error?: string | null } = {}) {
  const id = randomUUID();
  await owner(
    `INSERT INTO webhook_deliveries (id, tenant_id, endpoint_id, event_type, payload, state, attempts, last_status, last_error, created_at, delivered_at, next_attempt_at)
     VALUES ($1, $2, $3, 'consent.granted', '{"consentId":"c1"}', $4, $5, $6, $7, now() - make_interval(mins => $8), CASE WHEN $4 = 'delivered' THEN now() END, now() - interval '1 minute')`,
    [id, tenantId, endpointId, state, over.attempts ?? (state === "failed" ? 15 : state === "delivered" ? 1 : 0), over.status === undefined ? (state === "delivered" ? 200 : null) : over.status, over.error ?? null, over.ageMinutes ?? 0],
  );
  return id;
}
/** Registers an endpoint in a tenant that has none active (a tenant may have at most ten). */
async function freshEndpoint(tenant: { id: string; admin: string }, name: string) {
  await owner("UPDATE webhook_endpoints SET disabled_at = coalesce(disabled_at, now()) WHERE tenant_id = $1", [tenant.id]);
  return (await register(tenant, name)).id;
}

describe("the delivery log", () => {
  test("lists an endpoint's deliveries newest first, in words that need no payload, and never shows the payload or a secret", async () => {
    const ep = await freshEndpoint(api.A, "log");
    const old = await delivery(api.A.id, ep, "failed", { ageMinutes: 30, status: 500, error: "HTTP 500" });
    const mid = await delivery(api.A.id, ep, "delivered", { ageMinutes: 20 });
    const latest = await delivery(api.A.id, ep, "pending", { ageMinutes: 1, attempts: 2, status: 503, error: "HTTP 503" });
    const res = await listDeliveries(api.A.admin, ep);
    expect(res.status).toBe(200);
    expect(res.body.map((d: { id: string }) => d.id)).toEqual([latest, mid, old]);
    expect(res.body[0]).toEqual({
      id: latest, eventType: "consent.granted", state: "pending", attempts: 2, createdAt: expect.any(String),
      nextAttemptAt: expect.any(String), deliveredAt: null, lastStatus: 503, lastError: "HTTP 503",
    });
    expect(res.body[1]).toMatchObject({ state: "delivered", nextAttemptAt: null, lastStatus: 200 });
    expect(res.body[1].deliveredAt).toEqual(expect.any(String));
    expect(res.body[2]).toMatchObject({ state: "failed", nextAttemptAt: null, lastError: "HTTP 500" });
    const text = JSON.stringify(res.body);
    expect(text).not.toContain("consentId");
    expect(text).not.toContain("whsec_");
    expect(Object.keys(res.body[0]).sort()).toEqual(["attempts", "createdAt", "deliveredAt", "eventType", "id", "lastError", "lastStatus", "nextAttemptAt", "state"]);
  });

  test("can be narrowed to one state, and an unknown state is a bad request", async () => {
    const ep = await freshEndpoint(api.A, "state");
    await delivery(api.A.id, ep, "failed", { ageMinutes: 5 });
    await delivery(api.A.id, ep, "delivered", { ageMinutes: 4 });
    expect((await listDeliveries(api.A.admin, ep, "?state=failed")).body.map((d: { state: string }) => d.state)).toEqual(["failed"]);
    expect((await listDeliveries(api.A.admin, ep, "?state=delivered")).body.map((d: { state: string }) => d.state)).toEqual(["delivered"]);
    expect((await listDeliveries(api.A.admin, ep, "?state=pending")).body).toEqual([]);
    const bad = await listDeliveries(api.A.admin, ep, "?state=lost");
    expect(bad.status).toBe(400);
    expect(bad.body.field).toBe("state");
  });

  test("shows the latest 50 unless asked for fewer or more, at most 100", async () => {
    const ep = await freshEndpoint(api.A, "many");
    await owner(
      `INSERT INTO webhook_deliveries (id, tenant_id, endpoint_id, event_type, payload, state, attempts, created_at)
       SELECT gen_random_uuid(), $1, $2, 'consent.granted', '{}', 'delivered', 1, now() - make_interval(secs => g) FROM generate_series(1, 120) g`,
      [api.A.id, ep],
    );
    expect((await listDeliveries(api.A.admin, ep)).body).toHaveLength(50);
    expect((await listDeliveries(api.A.admin, ep, "?limit=7")).body).toHaveLength(7);
    expect((await listDeliveries(api.A.admin, ep, "?limit=100")).body).toHaveLength(100);
    for (const limit of ["0", "101", "-1", "abc", "1.5", ""]) {
      const res = await listDeliveries(api.A.admin, ep, `?limit=${limit}`);
      expect({ limit, status: res.status, field: res.body.field }).toEqual({ limit, status: 400, field: "limit" });
    }
  });

  test("is still there after the endpoint is disabled", async () => {
    const ep = await freshEndpoint(api.A, "history");
    await delivery(api.A.id, ep, "failed");
    await api.http().delete(`/v1/webhook-endpoints/${ep}`).set(bearer(api.A.admin));
    expect((await listDeliveries(api.A.admin, ep)).body).toHaveLength(1);
  });

  test("is for the owning tenant's administrator only: others get 404, other scopes 403, a bad id 400", async () => {
    const ep = await freshEndpoint(api.A, "scope");
    expect((await listDeliveries(api.B.admin, ep)).status).toBe(404);
    expect((await listDeliveries(api.A.admin, randomUUID())).status).toBe(404);
    expect((await listDeliveries(api.A.admin, "not-a-uuid")).status).toBe(400);
    for (const token of [api.A.dpo, api.A.auditor, api.A.server, api.A.pk]) expect((await listDeliveries(token, ep)).status).toBe(403);
    expect((await api.http().get(`/v1/webhook-endpoints/${ep}/deliveries`)).status).toBe(401);
  });
});

describe("sending a failed delivery again", () => {
  test("puts it back in the queue with its attempts unused, and the worker then sends it with the same idempotency key", async () => {
    const ep = await freshEndpoint(api.A, "again");
    const id = await delivery(api.A.id, ep, "failed", { status: 500, error: "HTTP 500" });
    const res = await again(api.A.admin, ep, id);
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ id, state: "pending" });
    expect((await owner("SELECT state, attempts FROM webhook_deliveries WHERE id = $1", [id]))[0]).toEqual({ state: "pending", attempts: 0 });
    expect((await listDeliveries(api.A.admin, ep)).body[0]).toMatchObject({ id, state: "pending", attempts: 0, lastError: "HTTP 500" });

    const run = await worker.runOnce(new Date());
    expect(run.delivered).toBe(1);
    expect(api.hooks.calls).toHaveLength(1);
    expect(api.hooks.calls[0]?.headers["Idempotency-Key"]).toBe(id);
    expect((await owner("SELECT state, attempts, last_error FROM webhook_deliveries WHERE id = $1", [id]))[0]).toEqual({ state: "delivered", attempts: 1, last_error: null });
  });

  test("is an audit event that names neither the payload nor the address", async () => {
    const ep = await freshEndpoint(api.A, "audited");
    const id = await delivery(api.A.id, ep, "failed");
    const count = async () => (await owner("SELECT count(*)::int AS n FROM consent_audit_log WHERE tenant_id = $1 AND action = 'webhook.delivery_redelivered' AND ref_id = $2", [api.A.id, id]))[0]?.n;
    expect(await count()).toBe(0);
    await again(api.A.admin, ep, id);
    expect(await count()).toBe(1);
  });

  test("a delivery that is not failed cannot be sent again, and asking twice is refused the second time", async () => {
    const ep = await freshEndpoint(api.A, "notfailed");
    const pending = await delivery(api.A.id, ep, "pending");
    const delivered = await delivery(api.A.id, ep, "delivered");
    for (const id of [pending, delivered]) {
      const res = await again(api.A.admin, ep, id);
      expect({ status: res.status, error: res.body.error }).toEqual({ status: 409, error: "not_failed" });
    }
    const failed = await delivery(api.A.id, ep, "failed");
    expect((await again(api.A.admin, ep, failed)).status).toBe(200);
    expect((await again(api.A.admin, ep, failed)).status).toBe(409);
  });

  test("an endpoint that is disabled cannot be sent to again", async () => {
    const ep = await freshEndpoint(api.A, "disabledagain");
    const id = await delivery(api.A.id, ep, "failed");
    await api.http().delete(`/v1/webhook-endpoints/${ep}`).set(bearer(api.A.admin));
    const res = await again(api.A.admin, ep, id);
    expect({ status: res.status, error: res.body.error }).toEqual({ status: 409, error: "endpoint_disabled" });
    expect((await owner("SELECT state FROM webhook_deliveries WHERE id = $1", [id]))[0]?.state).toBe("failed");
  });

  test("a delivery is found only under its own endpoint and tenant: anything else is 404", async () => {
    const ep = await freshEndpoint(api.A, "mine");
    const other = await register(api.A, "sibling");
    const id = await delivery(api.A.id, ep, "failed");
    expect((await again(api.A.admin, other.id, id)).status).toBe(404);
    expect((await again(api.B.admin, ep, id)).status).toBe(404);
    expect((await again(api.A.admin, ep, randomUUID())).status).toBe(404);
    expect((await again(api.A.admin, randomUUID(), id)).status).toBe(404);
    expect((await owner("SELECT state FROM webhook_deliveries WHERE id = $1", [id]))[0]?.state).toBe("failed");
  });

  test("bad ids are 400, other scopes 403, no credentials 401", async () => {
    const ep = await freshEndpoint(api.A, "access");
    const id = await delivery(api.A.id, ep, "failed");
    expect((await again(api.A.admin, ep, "nope")).status).toBe(400);
    expect((await again(api.A.admin, "nope", id)).status).toBe(400);
    for (const token of [api.A.dpo, api.A.auditor, api.A.server, api.A.pk]) expect((await again(token, ep, id)).status).toBe(403);
    expect((await api.http().post(`/v1/webhook-endpoints/${ep}/deliveries/${id}/redeliver`)).status).toBe(401);
    expect((await owner("SELECT state FROM webhook_deliveries WHERE id = $1", [id]))[0]?.state).toBe("failed");
  });
});

describe("an endpoint that keeps failing", () => {
  /** Ten failures, oldest first, then a delivery on its last attempt that the receiver will refuse. */
  async function aboutToGiveUp(ep: string, failuresBefore: number, deliveredAfter = false) {
    for (let i = 0; i < failuresBefore; i++) await delivery(api.A.id, ep, "failed", { ageMinutes: 100 - i });
    if (deliveredAfter) await delivery(api.A.id, ep, "delivered", { ageMinutes: 50 });
    return delivery(api.A.id, ep, "pending", { attempts: 14, ageMinutes: 1 });
  }
  const stateOf = async (ep: string) => (await endpointList(api.A)).find((e) => e.id === ep);

  test("is disabled after its tenth delivery in a row has failed for good, and says why", async () => {
    const ep = await freshEndpoint(api.A, "dead");
    const last = await aboutToGiveUp(ep, 9);
    api.hooks.script = [500];
    const run = await worker.runOnce(new Date());
    expect(run.failed).toBe(1);
    expect((await owner("SELECT state FROM webhook_deliveries WHERE id = $1", [last]))[0]?.state).toBe("failed");
    const e = await stateOf(ep);
    expect(e?.disabledAt).not.toBeNull();
    expect(e?.disabledReason).toBe("failures");
  });

  describe("after the administrator switches it on again", () => {
    const switchOn = (ep: string) => api.http().post(`/v1/webhook-endpoints/${ep}/enable`).set(bearer(api.A.admin));
    /** An endpoint Saral switched off after ten failures, then switched on by the administrator. */
    async function switchedOnAgain(name: string) {
      const ep = await freshEndpoint(api.A, name);
      for (let i = 0; i < 10; i++) await delivery(api.A.id, ep, "failed", { ageMinutes: 100 - i });
      await owner("UPDATE webhook_endpoints SET disabled_at = now(), disabled_reason = 'failures' WHERE id = $1", [ep]);
      expect((await switchOn(ep)).status).toBe(200);
      return ep;
    }

    test("the failures from before do not count: one new failure for good does not switch it off again", async () => {
      const ep = await switchedOnAgain("again-one");
      await delivery(api.A.id, ep, "pending", { attempts: 14, ageMinutes: 0 });
      api.hooks.script = [500];
      const run = await worker.runOnce(new Date());
      expect(run.failed).toBe(1);
      expect((await stateOf(ep))?.disabledAt).toBeNull();
    });

    test("ten new failures for good do switch it off again", async () => {
      const ep = await switchedOnAgain("again-ten");
      for (let i = 0; i < 9; i++) await delivery(api.A.id, ep, "failed", { ageMinutes: 0 });
      await delivery(api.A.id, ep, "pending", { attempts: 14, ageMinutes: 0 });
      api.hooks.script = [500];
      await worker.runOnce(new Date());
      const e = await stateOf(ep);
      expect(e?.disabledAt).not.toBeNull();
      expect(e?.disabledReason).toBe("failures");
    });

    test("an endpoint that was never switched off and on has its whole history counted, as before", async () => {
      const ep = await freshEndpoint(api.A, "never-off");
      await aboutToGiveUp(ep, 9);
      api.hooks.script = [500];
      await worker.runOnce(new Date());
      expect((await stateOf(ep))?.disabledAt).not.toBeNull();
    });
  });

  test("is an audit event of its own, not recorded as the administrator's doing", async () => {
    const ep = await freshEndpoint(api.A, "deadaudit");
    await aboutToGiveUp(ep, 9);
    api.hooks.script = [500];
    await worker.runOnce(new Date());
    const events = await owner("SELECT action, actor_id FROM consent_audit_log WHERE tenant_id = $1 AND ref_id = $2 AND action LIKE 'webhook.endpoint_%' ORDER BY seq_no", [api.A.id, ep]);
    expect(events.map((e) => e.action)).toContain("webhook.endpoint_auto_disabled");
    expect(events.map((e) => e.action)).not.toContain("webhook.endpoint_disabled");
    expect(events.find((e) => e.action === "webhook.endpoint_auto_disabled")?.actor_id).toBe("system:webhook-worker");
  });

  test("keeps its other waiting events from piling up: they are closed on the next run", async () => {
    const ep = await freshEndpoint(api.A, "deadqueue");
    await aboutToGiveUp(ep, 9);
    const waiting = await delivery(api.A.id, ep, "pending", { attempts: 0, ageMinutes: 0 });
    await owner("UPDATE webhook_deliveries SET next_attempt_at = now() + interval '1 hour' WHERE id = $1", [waiting]);
    api.hooks.script = [500];
    await worker.runOnce(new Date());
    await worker.runOnce(new Date());
    expect((await owner("SELECT state, last_error FROM webhook_deliveries WHERE id = $1", [waiting]))[0]).toEqual({ state: "failed", last_error: "endpoint disabled" });
  });

  test("is not disabled while fewer than ten in a row have failed", async () => {
    const ep = await freshEndpoint(api.A, "nine");
    await aboutToGiveUp(ep, 8);
    api.hooks.script = [500];
    await worker.runOnce(new Date());
    expect((await stateOf(ep))?.disabledAt).toBeNull();
  });

  test("is not disabled if one of the last ten was delivered, because it is not failing for every event", async () => {
    const ep = await freshEndpoint(api.A, "mixed");
    await aboutToGiveUp(ep, 9, true);
    api.hooks.script = [500];
    await worker.runOnce(new Date());
    expect((await stateOf(ep))?.disabledAt).toBeNull();
  });

  test("is not disabled for a delivery that is only being retried: only a final failure counts", async () => {
    const ep = await freshEndpoint(api.A, "retry");
    for (let i = 0; i < 9; i++) await delivery(api.A.id, ep, "failed", { ageMinutes: 100 - i });
    await delivery(api.A.id, ep, "pending", { attempts: 3, ageMinutes: 1 });
    api.hooks.script = [500];
    const run = await worker.runOnce(new Date());
    expect(run.retried).toBe(1);
    expect((await stateOf(ep))?.disabledAt).toBeNull();
  });

  test("does not disable a neighbouring endpoint of the same tenant, or another tenant's", async () => {
    const ep = await freshEndpoint(api.A, "neighbour");
    const sibling = (await register(api.A, "neighbour2")).id;
    const bEp = await freshEndpoint(api.B, "neighbourb");
    for (let i = 0; i < 9; i++) await delivery(api.B.id, bEp, "failed", { ageMinutes: 100 - i });
    await aboutToGiveUp(ep, 9);
    api.hooks.script = [500];
    await worker.runOnce(new Date());
    expect((await stateOf(ep))?.disabledReason).toBe("failures");
    expect((await stateOf(sibling))?.disabledAt).toBeNull();
    expect((await endpointList(api.B)).find((e) => e.id === bEp)?.disabledAt).toBeNull();
  });
});

describe("why an endpoint is disabled", () => {
  test("an active endpoint has no reason, and one an administrator disabled says so", async () => {
    const ep = await freshEndpoint(api.A, "reason");
    expect((await endpointList(api.A)).find((e) => e.id === ep)).toMatchObject({ disabledAt: null, disabledReason: null });
    await api.http().delete(`/v1/webhook-endpoints/${ep}`).set(bearer(api.A.admin));
    expect((await endpointList(api.A)).find((e) => e.id === ep)?.disabledReason).toBe("admin");
  });

  test("an endpoint disabled before reasons were recorded reads as the administrator's doing", async () => {
    const ep = await freshEndpoint(api.A, "legacy");
    await owner("UPDATE webhook_endpoints SET disabled_at = now(), disabled_reason = NULL WHERE id = $1", [ep]);
    expect((await endpointList(api.A)).find((e) => e.id === ep)?.disabledReason).toBe("admin");
  });
});
