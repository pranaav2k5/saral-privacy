import { connect, uid } from "../db/helpers.js";
import { PHONE, startApi, type Api } from "./harness.js";
import { WebhookWorker } from "../../src/webhooks/worker.js";
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
    await api.grant(api.A, { identifier: "+919800000002" });
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
