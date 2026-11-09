import { randomUUID as randomUuid } from "node:crypto";
import { connect, uid } from "../db/helpers.js";
import { PHONE, startApi, type Api } from "./harness.js";
import { WebhookWorker } from "../../src/webhooks/worker.js";
import { sha256Hex } from "@saral/audit-chain";
import { endpointSecret, verifyWebhookSignature } from "../../src/webhooks/signature.js";

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
const register = (token: string, body: Record<string, unknown>) => api.http().post("/v1/webhook-endpoints").set(bearer(token)).send(body);
const rows = async (sql: string, params: unknown[] = []) => (await api.db.owner.query(sql, params)).rows as Record<string, unknown>[];

describe("registering endpoints", () => {
  test("a tenant admin registers an https endpoint and sees the signing secret once", async () => {
    const res = await register(api.A.admin, { url: "https://hooks.example.org/saral", events: ["consent.granted"] });
    expect(res.status).toBe(201);
    expect(res.body).toMatchObject({ url: "https://hooks.example.org/saral", events: ["consent.granted"] });
    expect(res.body.secret).toMatch(/^whsec_[A-Za-z0-9_-]{43}$/);
    const secret = Buffer.from(endpointSecret(api.keys.webhookKey(), res.body.id, 1)).toString("base64url");
    expect(res.body.secret).toBe(`whsec_${secret}`);
    const list = await api.http().get("/v1/webhook-endpoints").set(bearer(api.A.admin));
    expect(list.status).toBe(200);
    expect(JSON.stringify(list.body)).not.toContain("whsec_");
    expect(list.body.map((e: { id: string }) => e.id)).toContain(res.body.id);
  });

  test("another tenant never sees it", async () => {
    const list = await api.http().get("/v1/webhook-endpoints").set(bearer(api.B.admin));
    expect(list.body).toEqual([]);
  });

  test.each([
    ["an http URL", { url: "http://hooks.example.org/x", events: ["consent.granted"] }],
    ["a host that resolves to a private address", { url: "https://internal.example/x", events: ["consent.granted"] }],
    ["a literal private address", { url: "https://169.254.169.254/latest", events: ["consent.granted"] }],
    ["a host that does not resolve", { url: "https://nowhere.test.example/x", events: ["consent.granted"] }],
  ])("rejects %s with 422", async (_n, body) => {
    const res = await register(api.A.admin, body);
    expect(res.status).toBe(422);
    expect(res.body.error).toBe("invalid_url");
  });

  test.each([
    ["no events", { url: "https://hooks.example.org/x", events: [] }],
    ["an unknown event", { url: "https://hooks.example.org/x", events: ["consent.exploded"] }],
    ["a repeated event", { url: "https://hooks.example.org/x", events: ["consent.granted", "consent.granted"] }],
    ["no URL", { events: ["consent.granted"] }],
  ])("rejects %s with 400", async (_n, body) => {
    expect((await register(api.A.admin, body)).status).toBe(400);
  });

  test("only a tenant admin may register or list", async () => {
    for (const token of [api.A.pk, api.A.auditor, api.A.dpo]) {
      expect((await register(token, { url: "https://hooks.example.org/x", events: ["consent.granted"] })).status).toBe(403);
      expect((await api.http().get("/v1/webhook-endpoints").set(bearer(token))).status).toBe(403);
    }
  });

  test("creating an endpoint is an audit event", async () => {
    const before = (await rows("SELECT count(*)::int AS n FROM consent_audit_log WHERE tenant_id = $1 AND action = 'webhook.endpoint_created'", [api.A.id]))[0]?.n as number;
    await register(api.A.admin, { url: "https://audit.example.org/x", events: ["consent.withdrawn"] });
    const after = (await rows("SELECT count(*)::int AS n FROM consent_audit_log WHERE tenant_id = $1 AND action = 'webhook.endpoint_created'", [api.A.id]))[0]?.n as number;
    expect(after).toBe(before + 1);
  });

  test("concurrent registrations cannot exceed the cap of 10 (the count and the insert are serialised per tenant)", async () => {
    await api.db.owner.query("UPDATE webhook_endpoints SET disabled_at = now() WHERE tenant_id = $1 AND disabled_at IS NULL", [api.B.id]);
    const results = await Promise.all(Array.from({ length: 16 }, (_, i) => register(api.B.admin, { url: `https://c${String(i)}.example.org/x`, events: ["consent.granted"] })));
    expect(results.filter((r) => r.status === 201)).toHaveLength(10);
    expect(results.filter((r) => r.status === 409)).toHaveLength(6);
    expect((await rows("SELECT count(*)::int AS n FROM webhook_endpoints WHERE tenant_id = $1 AND disabled_at IS NULL", [api.B.id]))[0]?.n).toBe(10);
  });

  test("a tenant may have at most 10 endpoints", async () => {
    let status = 201;
    for (let i = 0; i < 12 && status === 201; i++) {
      status = (await register(api.B.admin, { url: `https://h${String(i)}.example.org/x`, events: ["consent.granted"] })).status;
    }
    expect(status).toBe(409);
    expect((await rows("SELECT count(*)::int AS n FROM webhook_endpoints WHERE tenant_id = $1", [api.B.id]))[0]?.n).toBe(10);
  });
});

describe("disabling and rotating endpoints", () => {
  const del = (token: string, id: string) => api.http().delete(`/v1/webhook-endpoints/${id}`).set(bearer(token));
  const rotate = (token: string, id: string) => api.http().post(`/v1/webhook-endpoints/${id}/rotate-secret`).set(bearer(token));
  const make = async (tenant: { admin: string }, name: string) => (await register(tenant.admin, { url: `https://${name}.example.org/x`, events: ["consent.granted"] })).body as { id: string; secret: string };

  test("a tenant admin can disable an endpoint: it frees a slot, is listed as disabled, and the change is audited", async () => {
    await api.db.owner.query("UPDATE webhook_endpoints SET disabled_at = now() WHERE tenant_id = $1 AND disabled_at IS NULL", [api.B.id]);
    const e = await make(api.B, "todisable");
    const before = (await rows("SELECT count(*)::int AS n FROM consent_audit_log WHERE tenant_id = $1 AND action = 'webhook.endpoint_disabled'", [api.B.id]))[0]?.n as number;
    expect((await del(api.B.admin, e.id)).status).toBe(204);
    const listed = (await api.http().get("/v1/webhook-endpoints").set(bearer(api.B.admin))).body.find((x: { id: string }) => x.id === e.id);
    expect(listed.disabledAt).not.toBeNull();
    expect((await rows("SELECT count(*)::int AS n FROM consent_audit_log WHERE tenant_id = $1 AND action = 'webhook.endpoint_disabled'", [api.B.id]))[0]?.n).toBe(before + 1);
    expect((await del(api.B.admin, e.id)).status).toBe(404); // already disabled
  });

  test("a disabled endpoint's cap slot is free again: ten can be registered after disabling ten", async () => {
    await api.db.owner.query("UPDATE webhook_endpoints SET disabled_at = now() WHERE tenant_id = $1 AND disabled_at IS NULL", [api.B.id]);
    const made: string[] = [];
    for (let i = 0; i < 10; i++) made.push((await make(api.B, `slot${String(i)}`)).id);
    expect((await register(api.B.admin, { url: "https://eleven.example.org/x", events: ["consent.granted"] })).status).toBe(409);
    expect((await del(api.B.admin, made[0] as string)).status).toBe(204);
    expect((await register(api.B.admin, { url: "https://eleven.example.org/x", events: ["consent.granted"] })).status).toBe(201);
  });

  test("events still waiting for a disabled endpoint are marked failed, not left to pile up", async () => {
    await api.db.owner.query("UPDATE webhook_endpoints SET disabled_at = now() WHERE tenant_id = $1 AND disabled_at IS NULL", [api.A.id]);
    const e = await make(api.A, "pending-then-off");
    await api.grant(api.A, { identifier: "+919820000001" });
    expect((await rows("SELECT count(*)::int AS n FROM webhook_deliveries WHERE endpoint_id = $1 AND state = 'pending'", [e.id]))[0]?.n).toBe(1);
    await del(api.A.admin, e.id);
    api.hooks.calls = [];
    await worker.runOnce(new Date());
    expect(api.hooks.calls).toHaveLength(0);
    expect((await rows("SELECT state, last_error FROM webhook_deliveries WHERE endpoint_id = $1", [e.id]))[0]).toEqual({ state: "failed", last_error: "endpoint disabled" });
  });

  test("rotating gives a new secret, signs later deliveries with it, and the old secret stops verifying", async () => {
    await api.db.owner.query("UPDATE webhook_endpoints SET disabled_at = now() WHERE tenant_id = $1 AND disabled_at IS NULL", [api.A.id]);
    const e = await make(api.A, "rotating");
    const res = await rotate(api.A.admin, e.id);
    expect(res.status).toBe(200);
    expect(res.body.secret).toMatch(/^whsec_/);
    expect(res.body.secret).not.toBe(e.secret);
    expect(res.body.secret).toBe(`whsec_${Buffer.from(endpointSecret(api.keys.webhookKey(), e.id, 2)).toString("base64url")}`);
    await api.grant(api.A, { identifier: "+919820000002" });
    api.hooks.calls = [];
    await worker.runOnce(new Date());
    const call = api.hooks.calls.find((c) => c.url === "https://rotating.example.org/x") as { body: string; headers: Record<string, string> };
    const now = Math.floor(Date.now() / 1000);
    expect(verifyWebhookSignature(endpointSecret(api.keys.webhookKey(), e.id, 2), call.headers["X-Saral-Signature"] as string, call.body, now)).toBe(true);
    expect(verifyWebhookSignature(endpointSecret(api.keys.webhookKey(), e.id, 1), call.headers["X-Saral-Signature"] as string, call.body, now)).toBe(false);
    expect((await rows("SELECT count(*)::int AS n FROM consent_audit_log WHERE tenant_id = $1 AND action = 'webhook.endpoint_rotated'", [api.A.id]))[0]?.n).toBeGreaterThanOrEqual(1);
  });

  test("only the owning tenant's admin may disable or rotate; others get 404, scopes get 403, bad ids get 400, disabled endpoints cannot be rotated", async () => {
    await api.db.owner.query("UPDATE webhook_endpoints SET disabled_at = now() WHERE tenant_id = $1 AND disabled_at IS NULL", [api.A.id]);
    const e = await make(api.A, "guarded");
    expect((await del(api.B.admin, e.id)).status).toBe(404);
    expect((await rotate(api.B.admin, e.id)).status).toBe(404);
    for (const token of [api.A.pk, api.A.auditor, api.A.dpo]) {
      expect((await del(token, e.id)).status).toBe(403);
      expect((await rotate(token, e.id)).status).toBe(403);
    }
    expect((await del(api.A.admin, "nope")).status).toBe(400);
    expect((await rotate(api.A.admin, "nope")).status).toBe(400);
    await del(api.A.admin, e.id);
    expect((await rotate(api.A.admin, e.id)).status).toBe(404);
  });
});

describe("the outbox and delivery", () => {
  let endpointId: string;

  beforeAll(async () => {
    await api.db.owner.query("DELETE FROM webhook_endpoints WHERE tenant_id = $1 AND NOT EXISTS (SELECT 1 FROM webhook_deliveries d WHERE d.endpoint_id = webhook_endpoints.id)", [api.A.id]);
    await api.db.owner.query("UPDATE webhook_endpoints SET disabled_at = now() WHERE tenant_id = $1", [api.A.id]);
    endpointId = (await register(api.A.admin, { url: "https://deliver.example.org/saral", events: ["consent.granted", "consent.withdrawn"] })).body.id;
  });

  test("a consent queues one delivery in the same transaction, and a withdrawal queues another", async () => {
    const granted = (await api.grant(api.A, { identifier: PHONE })).body;
    let queued = await rows("SELECT event_type, state, attempts FROM webhook_deliveries WHERE endpoint_id = $1 ORDER BY created_at", [endpointId]);
    expect(queued).toEqual([{ event_type: "consent.granted", state: "pending", attempts: 0 }]);
    await api.http().post(`/v1/consents/${granted.consentId}/withdraw`).set(bearer(api.A.pk)).send({ identifier: PHONE });
    queued = await rows("SELECT event_type FROM webhook_deliveries WHERE endpoint_id = $1 ORDER BY created_at", [endpointId]);
    expect(queued.map((q) => q.event_type)).toEqual(["consent.granted", "consent.withdrawn"]);
  });

  test("a failed request queues nothing, and other tenants' endpoints get nothing", async () => {
    const before = (await rows("SELECT count(*)::int AS n FROM webhook_deliveries"))[0]?.n;
    await api.grant(api.A, { purposes: [{ key: "nope", granted: true }] });
    expect((await rows("SELECT count(*)::int AS n FROM webhook_deliveries"))[0]?.n).toBe(before);
    expect((await rows("SELECT count(*)::int AS n FROM webhook_deliveries WHERE tenant_id = $1 AND endpoint_id = $2", [api.B.id, endpointId]))[0]?.n).toBe(0);
  });

  test("the worker sends the event with a verifiable signature, an idempotency key, and no personal data", async () => {
    const result = await worker.runOnce(new Date());
    expect(result.delivered).toBeGreaterThanOrEqual(2);
    const call = api.hooks.calls.find((c) => c.url === "https://deliver.example.org/saral" && c.body.includes("consent.granted"));
    expect(call).toBeDefined();
    const c = call as NonNullable<typeof call>;
    expect(c.headers["Content-Type"]).toBe("application/json");
    expect(c.headers["X-Saral-Event"]).toBe("consent.granted");
    const body = JSON.parse(c.body) as { id: string; type: string; createdAt: string; data: { consentId: string } };
    expect(c.headers["Idempotency-Key"]).toBe(body.id);
    expect(body.type).toBe("consent.granted");
    expect(body.data.consentId).toMatch(/^[0-9a-f-]{36}$/);
    const secret = endpointSecret(api.keys.webhookKey(), endpointId, 1);
    expect(verifyWebhookSignature(secret, c.headers["X-Saral-Signature"] as string, c.body, Math.floor(Date.now() / 1000))).toBe(true);
    for (const call2 of api.hooks.calls) expect(call2.body).not.toContain("9876543210");
    const states = await rows("SELECT state, attempts, last_status FROM webhook_deliveries WHERE endpoint_id = $1", [endpointId]);
    expect(states.every((s) => s.state === "delivered" && s.attempts === 1 && s.last_status === 200)).toBe(true);
  });

  test("a delivered event is not sent again", async () => {
    api.hooks.calls = [];
    expect((await worker.runOnce(new Date())).delivered).toBe(0);
    expect(api.hooks.calls).toHaveLength(0);
  });

  test("several workers at once deliver each event exactly once, round after round", async () => {
    // The race is in a narrow window (a claim whose lock lands just after another worker's commit), so one round
    // proves little. Many rounds with four workers make a double delivery show up.
    for (let round = 0; round < 12; round++) {
      await api.db.owner.query("UPDATE webhook_deliveries SET state = 'delivered' WHERE state = 'pending'");
      for (let i = 0; i < 8; i++) await api.grant(api.A, { identifier: `+9197${String(round).padStart(2, "0")}00000${String(i)}` });
      api.hooks.calls = [];
      const results = await Promise.all(Array.from({ length: 4 }, () => worker.runOnce(new Date())));
      expect(results.reduce((n, r) => n + r.delivered, 0)).toBe(8);
      expect(api.hooks.calls).toHaveLength(8);
      expect(new Set(api.hooks.calls.map((c) => c.headers["Idempotency-Key"])).size).toBe(8);
    }
  }, 60000);

  test("two workers claim different deliveries even while neither has finished (SKIP LOCKED)", async () => {
    await api.db.owner.query("UPDATE webhook_deliveries SET state = 'delivered' WHERE state = 'pending'");
    await api.db.owner.query("UPDATE webhook_endpoints SET disabled_at = NULL WHERE id = $1", [endpointId]);
    for (let i = 0; i < 6; i++) await api.grant(api.A, { identifier: `+91985000000${String(i)}` });
    const now = new Date();
    const a = await connect(api.db);
    const b = await connect(api.db);
    try {
      for (const c of [a, b]) {
        await c.query("BEGIN");
        await c.query("SET LOCAL ROLE saral_worker");
      }
      const first = await worker.claim(a, now, 3);
      const second = await Promise.race([worker.claim(b, now, 3), new Promise<"blocked">((r) => setTimeout(() => r("blocked"), 3000))]);
      expect(second).not.toBe("blocked"); // without SKIP LOCKED the second claim would wait for the first transaction
      const ids = [...first, ...(second as typeof first)].map((d) => d.id);
      expect(first).toHaveLength(3);
      expect(second as typeof first).toHaveLength(3);
      expect(new Set(ids).size).toBe(6);
    } finally {
      await a.query("ROLLBACK").catch(() => undefined);
      await b.query("ROLLBACK").catch(() => undefined);
      await a.end();
      await b.end();
    }
    await api.db.owner.query("UPDATE webhook_deliveries SET state = 'delivered' WHERE state = 'pending'");
  }, 20000);

  describe("a slow endpoint cannot hold up the others", () => {
    const fast = "https://fast.example.org/hook";
    const slow = "https://slow.example.org/hook";
    let fastId: string;
    let slowId: string;

    beforeAll(async () => {
      await api.db.owner.query("UPDATE webhook_deliveries SET state = 'delivered' WHERE state = 'pending'");
      await api.db.owner.query("UPDATE webhook_endpoints SET disabled_at = now() WHERE tenant_id = $1 AND disabled_at IS NULL", [api.A.id]);
      fastId = uid("a", 96);
      slowId = uid("a", 97);
      for (const [id, url] of [[fastId, fast], [slowId, slow]] as const) {
        await api.db.owner.query("INSERT INTO webhook_endpoints (id, tenant_id, url, events) VALUES ($1, $2, $3, '{consent.granted}')", [id, api.A.id, url]);
      }
    });

    // Leave things as the other tests expect: the original endpoint on, this describe's two endpoints off.
    afterAll(async () => {
      await api.db.owner.query("UPDATE webhook_deliveries SET state = 'delivered' WHERE state = 'pending'");
      await api.db.owner.query("UPDATE webhook_endpoints SET disabled_at = now() WHERE id = ANY($1)", [[fastId, slowId]]);
      await api.db.owner.query("UPDATE webhook_endpoints SET disabled_at = NULL WHERE id = $1", [endpointId]);
    });

    const queue = async (endpoint: string, n: number) => {
      for (let i = 0; i < n; i++) {
        await api.db.owner.query(
          "INSERT INTO webhook_deliveries (id, tenant_id, endpoint_id, event_type, payload, next_attempt_at) VALUES ($1, $2, $3, 'consent.granted', '{}', now() - interval '1 second')",
          [uid("f", Math.floor(Math.random() * 1e9)), api.A.id, endpoint],
        );
      }
    };

    test("endpoints are served at the same time; the deliveries of one endpoint go one after another", async () => {
      await queue(slowId, 3);
      await queue(fastId, 3);
      api.hooks.delayMs = { [slow]: 250, [fast]: 5 };
      const started = Date.now();
      const result = await worker.runOnce(new Date());
      expect(result.delivered).toBe(6);
      const at = (url: string) => api.hooks.answers.filter((a) => a.url === url).map((a) => a.at - started);
      expect(Math.max(...at(fast))).toBeLessThan(200); // not waiting behind the slow endpoint
      const slowTimes = at(slow);
      expect(slowTimes).toHaveLength(3);
      expect(slowTimes.every((t, i) => i === 0 || t - (slowTimes[i - 1] as number) >= 200)).toBe(true); // one at a time
      api.hooks.delayMs = {};
    });

    test("an endpoint that uses up its time budget has the rest of its batch released, not counted as tried", async () => {
      await queue(slowId, 5);
      api.hooks.delayMs = { [slow]: 80 };
      worker.endpointBudgetMs = 100;
      try {
        const result = await worker.runOnce(new Date());
        expect(result.delivered).toBe(2);
        expect(result.released).toBe(3);
        const left = await rows("SELECT attempts, state FROM webhook_deliveries WHERE state = 'pending' AND endpoint_id = $1", [slowId]);
        expect(left).toEqual([{ attempts: 0, state: "pending" }, { attempts: 0, state: "pending" }, { attempts: 0, state: "pending" }]);
        worker.endpointBudgetMs = 60_000;
        api.hooks.delayMs = {};
        expect((await worker.runOnce(new Date(Date.now() + 1000))).delivered).toBe(3);
      } finally {
        worker.endpointBudgetMs = 60_000;
        api.hooks.delayMs = {};
      }
    });

    test("one tenant with a large backlog cannot take every slot of a claim", async () => {
      await api.db.owner.query("UPDATE webhook_deliveries SET state = 'delivered' WHERE state = 'pending'");
      for (let i = 0; i < 30; i++) await queue(fastId, 1);
      const bEndpoint = uid("b", 98);
      await api.db.owner.query("INSERT INTO webhook_endpoints (id, tenant_id, url, events) VALUES ($1, $2, 'https://b.example.org/hook', '{consent.granted}')", [bEndpoint, api.B.id]);
      for (let i = 0; i < 3; i++) {
        await api.db.owner.query("INSERT INTO webhook_deliveries (id, tenant_id, endpoint_id, event_type, payload, next_attempt_at) VALUES ($1, $2, $3, 'consent.granted', '{}', now() - interval '1 second')", [uid("e", 5000 + i), api.B.id, bEndpoint]);
      }
      const c = await connect(api.db);
      try {
        await c.query("BEGIN");
        await c.query("SET LOCAL ROLE saral_worker");
        const claimed = await worker.claim(c, new Date(), 50, 20);
        expect(claimed.filter((d) => d.tenant_id === api.A.id)).toHaveLength(20);
        expect(claimed.filter((d) => d.tenant_id === api.B.id)).toHaveLength(3);
      } finally {
        await c.query("ROLLBACK").catch(() => undefined);
        await c.end();
      }
      await api.db.owner.query("UPDATE webhook_deliveries SET state = 'delivered' WHERE state = 'pending'");
    });
  });

  test("a delivery left at 15 attempts by a crashed worker is marked failed and does not block anyone else", async () => {
    await api.db.owner.query("UPDATE webhook_deliveries SET state = 'delivered' WHERE state = 'pending'");
    await api.db.owner.query("UPDATE webhook_endpoints SET disabled_at = NULL WHERE id = $1", [endpointId]);
    const stuck = uid("e", 9001);
    await api.db.owner.query(
      "INSERT INTO webhook_deliveries (id, tenant_id, endpoint_id, event_type, payload, attempts, next_attempt_at) VALUES ($1, $2, $3, 'consent.granted', '{}', 15, now() - interval '10 minutes')",
      [stuck, api.A.id, endpointId],
    );
    await api.grant(api.A, { identifier: "+919810000001" });
    api.hooks.calls = [];
    const result = await worker.runOnce(new Date());
    expect(result.delivered).toBe(1);
    const row = (await rows("SELECT state, attempts, last_error FROM webhook_deliveries WHERE id = $1", [stuck]))[0] as { state: string; attempts: number; last_error: string };
    expect(row).toMatchObject({ state: "failed", attempts: 15 });
    expect(row.last_error).toMatch(/abandoned/);
    expect(api.hooks.calls.every((c) => !c.body.includes(stuck))).toBe(true);
  });

  test("a failing endpoint is retried later with backoff, then marked failed after 15 attempts", async () => {
    await api.grant(api.A, { identifier: "+919800000001" });
    api.hooks.script = [500];
    let now = new Date();
    const first = await worker.runOnce(now);
    expect(first).toMatchObject({ delivered: 0, retried: 1, failed: 0 });
    let row = (await rows("SELECT id, state, attempts, last_status, next_attempt_at FROM webhook_deliveries WHERE state = 'pending'"))[0] as { id: string; state: string; attempts: number; last_status: number; next_attempt_at: Date };
    expect(row).toMatchObject({ state: "pending", attempts: 1, last_status: 500 });
    const wait = (row.next_attempt_at.getTime() - now.getTime()) / 1000;
    expect(wait).toBeGreaterThanOrEqual(7.5);
    expect(wait).toBeLessThanOrEqual(12.5);
    expect((await worker.runOnce(now)).retried).toBe(0); // not due yet

    for (let i = 2; i <= 15; i++) {
      now = new Date(now.getTime() + 7 * 3600 * 1000);
      await worker.runOnce(now);
    }
    row = (await rows("SELECT id, state, attempts, last_status, next_attempt_at FROM webhook_deliveries WHERE id = $1", [row.id]))[0] as typeof row;
    expect(row).toMatchObject({ state: "failed", attempts: 15, last_status: 500 });
    api.hooks.calls = [];
    await worker.runOnce(new Date(now.getTime() + 7 * 3600 * 1000));
    expect(api.hooks.calls).toHaveLength(0);
  });

  test.each([
    ["a redirect is a failure (never followed)", 302],
    ["a client error is a failure", 404],
    ["a network error is a failure", "throw" as const],
  ])("%s", async (_n, outcome) => {
    await api.db.owner.query("UPDATE webhook_deliveries SET state = 'delivered' WHERE state = 'pending'");
    await api.grant(api.A, { identifier: `+9198000002${String(String(_n).length)}${String(String(outcome).length)}` });
    api.hooks.script = [outcome];
    const r = await worker.runOnce(new Date());
    expect(r.retried).toBe(1);
    const row = (await rows("SELECT state, last_status, last_error FROM webhook_deliveries WHERE state = 'pending'"))[0] as { state: string; last_status: number | null; last_error: string | null };
    if (outcome === "throw") expect(row.last_error).toMatch(/ECONNREFUSED/);
    else expect(row.last_status).toBe(outcome);
  });

  test("an event whose endpoint was disabled is not sent", async () => {
    await api.db.owner.query("UPDATE webhook_deliveries SET state = 'delivered' WHERE state = 'pending'");
    await api.grant(api.A, { identifier: "+919800000003" });
    await api.db.owner.query("UPDATE webhook_endpoints SET disabled_at = now() WHERE id = $1", [endpointId]);
    api.hooks.calls = [];
    expect((await worker.runOnce(new Date())).delivered).toBe(0);
    expect(api.hooks.calls).toHaveLength(0);
    await api.db.owner.query("UPDATE webhook_endpoints SET disabled_at = NULL WHERE id = $1", [endpointId]);
  });

  test("an endpoint subscribed only to withdrawals gets no grant events", async () => {
    await api.db.owner.query("UPDATE webhook_endpoints SET disabled_at = now() WHERE tenant_id = $1", [api.A.id]);
    const id = uid("a", 95);
    await api.db.owner.query("INSERT INTO webhook_endpoints (id, tenant_id, url, events) VALUES ($1, $2, 'https://w.example.org/x', '{consent.withdrawn}')", [id, api.A.id]);
    await api.grant(api.A, { identifier: "+919800000004" });
    expect((await rows("SELECT count(*)::int AS n FROM webhook_deliveries WHERE endpoint_id = $1", [id]))[0]?.n).toBe(0);
  });
});

describe("rotating with the old secret left working for a while", () => {
  const HOUR = 3_600_000;
  const rotate = (token: string, id: string, body?: unknown) => {
    const r = api.http().post(`/v1/webhook-endpoints/${id}/rotate-secret`).set(bearer(token));
    return body === undefined ? r : r.send(body as object);
  };
  const make = async (name: string) => {
    await api.db.owner.query("UPDATE webhook_endpoints SET disabled_at = now() WHERE tenant_id = $1 AND disabled_at IS NULL", [api.A.id]);
    return (await register(api.A.admin, { url: `https://${name}.example.org/x`, events: ["consent.granted"] })).body as { id: string; secret: string };
  };
  let phone = 0;
  /** Gives one consent, so one delivery is made to the endpoint, and returns what was sent to it. */
  const delivery = async (name: string, when?: Date) => {
    phone += 1;
    await api.grant(api.A, { identifier: `+9198210${String(10000 + phone)}` });
    // Taken after the consent is given, so the delivery it made is already due.
    const at = when ?? new Date();
    // The worker takes a limited batch for each organisation, oldest first, so the backlog of earlier tests may go first.
    let call: { body: string; headers: Record<string, string> } | undefined;
    for (let i = 0; i < 20 && call === undefined; i++) {
      api.hooks.calls = [];
      await worker.runOnce(at);
      call = api.hooks.calls.find((c) => c.url === `https://${name}.example.org/x`);
    }
    if (call === undefined) throw new Error("no delivery was made to the endpoint");
    const header = call.headers["X-Saral-Signature"] as string;
    const secrets = (id: string) => (v: number) => verifyWebhookSignature(endpointSecret(api.keys.webhookKey(), id, v), header, call.body, Math.floor(at.getTime() / 1000));
    return { header, signatures: header.split(",").filter((p) => p.startsWith("v1=")).length, checks: secrets };
  };
  const listed = async (id: string) => (await api.http().get("/v1/webhook-endpoints").set(bearer(api.A.admin))).body.find((e: { id: string }) => e.id === id) as { previousSecretUntil: string | null };

  test("with overlap the new secret is shown, the answer says until when the old one works, and deliveries are signed with both", async () => {
    const e = await make("overlap-on");
    const before = Date.now();
    const res = await rotate(api.A.admin, e.id, { overlap: true });
    expect(res.status).toBe(200);
    expect(res.body.secret).toBe(`whsec_${Buffer.from(endpointSecret(api.keys.webhookKey(), e.id, 2)).toString("base64url")}`);
    const until = Date.parse(res.body.previousSecretValidUntil as string);
    expect(until).toBeGreaterThanOrEqual(before + 24 * HOUR);
    expect(until).toBeLessThanOrEqual(Date.now() + 24 * HOUR);
    expect((await listed(e.id)).previousSecretUntil).toBe(res.body.previousSecretValidUntil);
    const d = await delivery("overlap-on");
    expect(d.signatures).toBe(2);
    expect([d.checks(e.id)(2), d.checks(e.id)(1), d.checks(e.id)(3)]).toEqual([true, true, false]);
    expect(d.header.split(",")[1]).toBe(`v1=${d.header.split("v1=")[1]?.split(",")[0] as string}`);
  });

  test("without overlap (the default) the old secret stops at once, the answer and the list say there is no previous secret, and one signature is sent", async () => {
    const e = await make("overlap-off");
    for (const body of [undefined, {}, { overlap: false }]) {
      const res = await rotate(api.A.admin, e.id, body);
      expect(res.status).toBe(200);
      expect(res.body.previousSecretValidUntil).toBeNull();
    }
    expect((await listed(e.id)).previousSecretUntil).toBeNull();
    const d = await delivery("overlap-off");
    expect(d.signatures).toBe(1);
    expect([d.checks(e.id)(4), d.checks(e.id)(3)]).toEqual([true, false]);
  });

  test("the old secret works for exactly 24 hours after the rotation: one second before, both sign; at 24 hours, only the new one", async () => {
    const e = await make("overlap-edge");
    await rotate(api.A.admin, e.id, { overlap: true });
    const T = Date.parse("2030-01-01T10:00:00Z");
    await api.db.owner.query("UPDATE webhook_endpoints SET rotated_at = $2 WHERE id = $1", [e.id, new Date(T).toISOString()]);
    const inside = await delivery("overlap-edge", new Date(T + 24 * HOUR - 1000));
    expect(inside.signatures).toBe(2);
    expect([inside.checks(e.id)(2), inside.checks(e.id)(1)]).toEqual([true, true]);
    const outside = await delivery("overlap-edge", new Date(T + 24 * HOUR));
    expect(outside.signatures).toBe(1);
    expect([outside.checks(e.id)(2), outside.checks(e.id)(1)]).toEqual([true, false]);
  });

  test("once the 24 hours are over the list no longer shows a previous secret", async () => {
    const e = await make("overlap-over");
    await rotate(api.A.admin, e.id, { overlap: true });
    await api.db.owner.query("UPDATE webhook_endpoints SET rotated_at = now() - interval '25 hours' WHERE id = $1", [e.id]);
    expect((await listed(e.id)).previousSecretUntil).toBeNull();
  });

  test("only the secret just before the current one keeps working: after two rotations the first is gone", async () => {
    const e = await make("overlap-twice");
    await rotate(api.A.admin, e.id, { overlap: true });
    await rotate(api.A.admin, e.id, { overlap: true });
    const d = await delivery("overlap-twice");
    expect(d.signatures).toBe(2);
    expect([d.checks(e.id)(3), d.checks(e.id)(2), d.checks(e.id)(1)]).toEqual([true, true, false]);
  });

  test("rotating again without overlap cuts the old secret off at once, even in the middle of an overlap", async () => {
    const e = await make("overlap-cut");
    await rotate(api.A.admin, e.id, { overlap: true });
    await rotate(api.A.admin, e.id, { overlap: false });
    expect((await listed(e.id)).previousSecretUntil).toBeNull();
    const d = await delivery("overlap-cut");
    expect(d.signatures).toBe(1);
    expect([d.checks(e.id)(3), d.checks(e.id)(2)]).toEqual([true, false]);
  });

  test("an endpoint never rotated has no previous secret and one signature", async () => {
    const e = await make("overlap-never");
    expect((await listed(e.id)).previousSecretUntil).toBeNull();
    expect((await delivery("overlap-never")).signatures).toBe(1);
  });

  test.each([
    ["a text", { overlap: "yes" }, "overlap"],
    ["a number", { overlap: 1 }, "overlap"],
    ["null", { overlap: null }, "overlap"],
    ["a field that is not part of the request", { overlap: true, keepFor: 1 }, "keepFor"],
  ])("%s as the choice is a 400 naming the field, and the secret is not rotated", async (_n, body, field) => {
    const e = await make(`overlap-bad-${field}`);
    const res = await rotate(api.A.admin, e.id, body);
    expect({ status: res.status, field: res.body.field }).toEqual({ status: 400, field });
    expect((await rows("SELECT secret_version FROM webhook_endpoints WHERE id = $1", [e.id]))[0]?.secret_version).toBe(1);
  });

  test("a body that is not an object is a 400", async () => {
    const e = await make("overlap-array");
    expect((await rotate(api.A.admin, e.id, [])).status).toBe(400);
  });

  test("each rotation is an audit event whose hash says whether the old secret was left working", async () => {
    const e = await make("overlap-audit");
    const url = "https://overlap-audit.example.org/x";
    const hash = (version: number, overlap: boolean) => sha256Hex(JSON.stringify(["saral.webhook_endpoint", 1, api.A.id, e.id, url, ["consent.granted"], version, overlap]));
    await rotate(api.A.admin, e.id, { overlap: true });
    await rotate(api.A.admin, e.id);
    const events = await rows("SELECT payload_sha256 FROM consent_audit_log WHERE tenant_id = $1 AND ref_id = $2 AND action = 'webhook.endpoint_rotated' ORDER BY seq_no", [api.A.id, e.id]);
    expect(events.map((x) => x.payload_sha256)).toEqual([hash(2, true), hash(3, false)]);
  });

  test("only the owning tenant's administrator may choose it, and a disabled endpoint cannot be rotated", async () => {
    const e = await make("overlap-scope");
    expect((await rotate(api.B.admin, e.id, { overlap: true })).status).toBe(404);
    for (const token of [api.A.pk, api.A.dpo, api.A.auditor]) expect((await rotate(token, e.id, { overlap: true })).status).toBe(403);
    await api.http().delete(`/v1/webhook-endpoints/${e.id}`).set(bearer(api.A.admin));
    expect((await rotate(api.A.admin, e.id, { overlap: true })).status).toBe(404);
  });
});

describe("switching an endpoint on again", () => {
  const enable = (token: string, id: string) => api.http().post(`/v1/webhook-endpoints/${id}/enable`).set(bearer(token));
  const disableByAdmin = (id: string) => api.http().delete(`/v1/webhook-endpoints/${id}`).set(bearer(api.A.admin));
  const clearA = () => api.db.owner.query("UPDATE webhook_endpoints SET disabled_at = now() WHERE tenant_id = $1 AND disabled_at IS NULL", [api.A.id]);
  const make = async (name: string) => (await register(api.A.admin, { url: `https://${name}.example.org/x`, events: ["consent.granted"] })).body as { id: string };
  let phone = 0;

  test("an endpoint the administrator disabled is on again with the same secret, is listed as enabled, gets later events, and it is audited", async () => {
    await clearA();
    const e = await make("enable-admin");
    await disableByAdmin(e.id);
    const res = await enable(api.A.admin, e.id);
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ id: e.id, url: "https://enable-admin.example.org/x", events: ["consent.granted"], disabledAt: null, disabledReason: null });
    const row = (await api.http().get("/v1/webhook-endpoints").set(bearer(api.A.admin))).body.find((x: { id: string }) => x.id === e.id);
    expect(row).toMatchObject({ disabledAt: null, disabledReason: null });
    phone += 1;
    await api.grant(api.A, { identifier: `+9198220${String(10000 + phone)}` });
    api.hooks.calls = [];
    await worker.runOnce(new Date());
    const call = api.hooks.calls.find((c) => c.url === "https://enable-admin.example.org/x") as { body: string; headers: Record<string, string> };
    expect(call).toBeDefined();
    expect(verifyWebhookSignature(endpointSecret(api.keys.webhookKey(), e.id, 1), call.headers["X-Saral-Signature"] as string, call.body, Math.floor(Date.now() / 1000))).toBe(true);
    const expected = sha256Hex(JSON.stringify(["saral.webhook_endpoint", 1, api.A.id, e.id, "https://enable-admin.example.org/x", ["consent.granted"], 1]));
    const events = await rows("SELECT payload_sha256 FROM consent_audit_log WHERE tenant_id = $1 AND ref_id = $2 AND action = 'webhook.endpoint_enabled'", [api.A.id, e.id]);
    expect(events).toEqual([{ payload_sha256: expected }]);
  });

  test("an endpoint Saral switched off after repeated failures can be switched on again, and then reads as enabled", async () => {
    await clearA();
    const e = await make("enable-failures");
    await api.db.owner.query("UPDATE webhook_endpoints SET disabled_at = now(), disabled_reason = 'failures' WHERE id = $1", [e.id]);
    expect((await enable(api.A.admin, e.id)).status).toBe(200);
    expect((await rows("SELECT disabled_at, disabled_reason FROM webhook_endpoints WHERE id = $1", [e.id]))[0]).toEqual({ disabled_at: null, disabled_reason: null });
  });

  test("an endpoint that is already on is a 409, and it is not audited again", async () => {
    await clearA();
    const e = await make("enable-already");
    const res = await enable(api.A.admin, e.id);
    expect({ status: res.status, error: res.body.error }).toEqual({ status: 409, error: "already_enabled" });
    expect(await rows("SELECT 1 FROM consent_audit_log WHERE tenant_id = $1 AND ref_id = $2 AND action = 'webhook.endpoint_enabled'", [api.A.id, e.id])).toHaveLength(0);
  });

  test("another organisation's endpoint is 404, a bad id is 400, other roles get 403, and no one gets 401", async () => {
    await clearA();
    const e = await make("enable-scope");
    await disableByAdmin(e.id);
    expect((await enable(api.B.admin, e.id)).status).toBe(404);
    expect((await enable(api.A.admin, randomUuid())).status).toBe(404);
    expect((await enable(api.A.admin, "nope")).status).toBe(400);
    for (const token of [api.A.pk, api.A.dpo, api.A.auditor, api.A.server]) expect((await enable(token, e.id)).status).toBe(403);
    expect((await api.http().post(`/v1/webhook-endpoints/${e.id}/enable`)).status).toBe(401);
    expect((await rows("SELECT disabled_at IS NULL AS on FROM webhook_endpoints WHERE id = $1", [e.id]))[0]).toEqual({ on: false });
  });

  test("with ten endpoints already on it is refused with 409, nothing changes, and a free place makes it work", async () => {
    await api.db.owner.query("UPDATE webhook_endpoints SET disabled_at = now() WHERE tenant_id = $1 AND disabled_at IS NULL", [api.B.id]);
    const ids: string[] = [];
    for (let i = 0; i < 10; i++) ids.push(((await register(api.B.admin, { url: `https://cap${String(i)}.example.org/x`, events: ["consent.granted"] })).body as { id: string }).id);
    const extra = ((await api.db.owner.query("INSERT INTO webhook_endpoints (id, tenant_id, url, events, disabled_at) VALUES (gen_random_uuid(), $1, 'https://capx.example.org/x', '{consent.granted}', now()) RETURNING id", [api.B.id])).rows[0] as { id: string }).id;
    const full = await enable(api.B.admin, extra);
    expect({ status: full.status, error: full.body.error }).toEqual({ status: 409, error: "too_many_endpoints" });
    expect((await rows("SELECT disabled_at IS NULL AS on FROM webhook_endpoints WHERE id = $1", [extra]))[0]).toEqual({ on: false });
    await api.http().delete(`/v1/webhook-endpoints/${ids[0] as string}`).set(bearer(api.B.admin));
    expect((await enable(api.B.admin, extra)).status).toBe(200);
  });

  test("several switched on at once cannot go past ten: the count and the change are serialised", async () => {
    await api.db.owner.query("UPDATE webhook_endpoints SET disabled_at = now() WHERE tenant_id = $1 AND disabled_at IS NULL", [api.B.id]);
    for (let i = 0; i < 8; i++) await register(api.B.admin, { url: `https://race${String(i)}.example.org/x`, events: ["consent.granted"] });
    const off: string[] = [];
    for (let i = 0; i < 4; i++) off.push(((await api.db.owner.query("INSERT INTO webhook_endpoints (id, tenant_id, url, events, disabled_at) VALUES (gen_random_uuid(), $1, $2, '{consent.granted}', now()) RETURNING id", [api.B.id, `https://raceoff${String(i)}.example.org/x`])).rows[0] as { id: string }).id);
    const results = await Promise.all(off.map((id) => enable(api.B.admin, id)));
    expect(results.map((r) => r.status).sort()).toEqual([200, 200, 409, 409]);
    expect((await rows("SELECT count(*)::int AS n FROM webhook_endpoints WHERE tenant_id = $1 AND disabled_at IS NULL", [api.B.id]))[0]?.n).toBe(10);
  });

  test("the address is checked again: one that now points at a private address is refused with 422 and stays off", async () => {
    await clearA();
    const id = ((await api.db.owner.query("INSERT INTO webhook_endpoints (id, tenant_id, url, events, disabled_at) VALUES (gen_random_uuid(), $1, 'https://internal.example/x', '{consent.granted}', now()) RETURNING id", [api.A.id])).rows[0] as { id: string }).id;
    const res = await enable(api.A.admin, id);
    expect({ status: res.status, error: res.body.error }).toEqual({ status: 422, error: "invalid_url" });
    expect((await rows("SELECT disabled_at IS NULL AS on FROM webhook_endpoints WHERE id = $1", [id]))[0]).toEqual({ on: false });
  });

  test("an endpoint that is already on is a 409 even when its address would no longer pass, because there is nothing to switch on", async () => {
    await clearA();
    const id = ((await api.db.owner.query("INSERT INTO webhook_endpoints (id, tenant_id, url, events) VALUES (gen_random_uuid(), $1, 'https://internal.example/x', '{consent.granted}') RETURNING id", [api.A.id])).rows[0] as { id: string }).id;
    const res = await enable(api.A.admin, id);
    expect({ status: res.status, error: res.body.error }).toEqual({ status: 409, error: "already_enabled" });
  });

  test("a failed delivery of an endpoint that was off can be sent again once it is on, which was refused while it was off", async () => {
    await clearA();
    const e = await make("enable-redeliver");
    phone += 1;
    await api.grant(api.A, { identifier: `+9198230${String(10000 + phone)}` });
    await api.db.owner.query("UPDATE webhook_deliveries SET state = 'failed', attempts = 15, last_error = 'HTTP 500' WHERE endpoint_id = $1", [e.id]);
    const failed = (await rows("SELECT id FROM webhook_deliveries WHERE endpoint_id = $1 AND state = 'failed'", [e.id]))[0] as { id: string };
    expect(failed).toBeDefined();
    await disableByAdmin(e.id);
    expect((await api.http().post(`/v1/webhook-endpoints/${e.id}/deliveries/${failed.id}/redeliver`).set(bearer(api.A.admin))).status).toBe(409);
    await enable(api.A.admin, e.id);
    expect((await api.http().post(`/v1/webhook-endpoints/${e.id}/deliveries/${failed.id}/redeliver`).set(bearer(api.A.admin))).status).toBe(200);
  });
});
