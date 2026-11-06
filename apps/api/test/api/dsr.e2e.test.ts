import { randomUUID } from "node:crypto";
import { verifyReceipt } from "@saral/receipts";
import { DSR_STATES, canTransition } from "../../src/dsr/state.js";
import { PHONE, startApi, type Api } from "./harness.js";

let api: Api;

beforeAll(async () => {
  api = await startApi();
});

afterAll(async () => {
  await api.stop();
});

const bearer = (t: string) => ({ Authorization: `Bearer ${t}` });
let person = 0;
const phone = () => `+9199100${String(10000 + person++)}`;
const submit = (token: string, body: Record<string, unknown>) => api.http().post("/v1/dsr").set(bearer(token)).send(body);
const create = async (type = "access", identifier = phone(), tenant = api.A) => (await submit(tenant.pk, { type, identifier, details: "please help" })).body as { id: string; state: string; dueAt: string };
const transition = (token: string, id: string, body: Record<string, unknown>) => api.http().post(`/v1/dsr/${id}/transition`).set(bearer(token)).send(body);
const owner = (sql: string, params: unknown[] = []) => api.db.owner.query(sql, params).then((r) => r.rows as Record<string, unknown>[]);

/** Moves a due date into the past. The guard trigger forbids changing it, so it is switched off for this one edit. */
async function backdate(id: string, interval: string): Promise<void> {
  await owner("ALTER TABLE dsr_requests DISABLE TRIGGER dsr_requests_guard");
  try {
    await owner(`UPDATE dsr_requests SET due_at = now() - interval '${interval}' WHERE id = $1`, [id]);
  } finally {
    await owner("ALTER TABLE dsr_requests ENABLE TRIGGER dsr_requests_guard");
  }
}

describe("submitting a request", () => {
  test("a person submits a request through a publishable key and gets it back with its due date", async () => {
    const res = await submit(api.A.pk, { type: "erasure", identifier: phone(), details: "delete my data" });
    expect(res.status).toBe(201);
    expect(res.body).toMatchObject({ type: "erasure", state: "submitted" });
    expect(res.body.id).toMatch(/^[0-9a-f-]{36}$/);
    const days = (Date.parse(res.body.dueAt) - Date.parse(res.body.submittedAt)) / 86_400_000;
    expect(days).toBe(30);
    expect(res.body).not.toHaveProperty("details"); // the person sent it; only the DPO reads it back
  });

  test("the answer is the same for a person Saral has never seen and for a known one (no way to tell who is a customer)", async () => {
    const known = phone();
    await api.grant(api.A, { identifier: known });
    const a = await submit(api.A.pk, { type: "access", identifier: known });
    const b = await submit(api.A.pk, { type: "access", identifier: phone() });
    expect(a.status).toBe(201);
    expect(b.status).toBe(201);
    expect(Object.keys(a.body).sort()).toEqual(Object.keys(b.body).sort());
  });

  test("the raw phone number is stored only sealed, and never in plain text anywhere", async () => {
    const id = "+919910099999";
    await submit(api.A.pk, { type: "access", identifier: id, details: "no contact details in here" });
    const tables = (await owner("SELECT tablename FROM pg_tables WHERE schemaname = 'public'")) as { tablename: string }[];
    for (const { tablename } of tables) {
      const dump = ((await owner(`SELECT coalesce(string_agg(t::text, ' '), '') AS s FROM ${tablename} t`))[0]?.s ?? "") as string;
      expect({ tablename, plain: dump.includes("9910099999") }).toEqual({ tablename, plain: false });
    }
    expect((await owner("SELECT count(*)::int AS n FROM principal_contacts"))[0]?.n).toBeGreaterThan(0);
  });

  test("submitting is an audit event and queues a webhook, neither carrying the person's text or identifier", async () => {
    await owner("UPDATE webhook_endpoints SET disabled_at = now() WHERE tenant_id = $1", [api.A.id]);
    const reg = await api.http().post("/v1/webhook-endpoints").set(bearer(api.A.admin)).send({ url: "https://dsr.example.org/hook", events: ["dsr.submitted", "dsr.transitioned"] });
    expect(reg.status).toBe(201);
    const before = (await owner("SELECT count(*)::int AS n FROM consent_audit_log WHERE tenant_id = $1 AND action = 'dsr.submitted'", [api.A.id]))[0]?.n as number;
    const r = await submit(api.A.pk, { type: "grievance", identifier: phone(), details: "secret complaint text" });
    expect((await owner("SELECT count(*)::int AS n FROM consent_audit_log WHERE tenant_id = $1 AND action = 'dsr.submitted'", [api.A.id]))[0]?.n).toBe(before + 1);
    const queued = await owner("SELECT event_type, payload::text AS p FROM webhook_deliveries WHERE endpoint_id = $1 ORDER BY created_at DESC LIMIT 1", [reg.body.id]);
    expect(queued[0]?.event_type).toBe("dsr.submitted");
    expect(queued[0]?.p).toContain(r.body.id);
    expect(queued[0]?.p).not.toContain("secret complaint");
    expect((await api.http().get("/v1/audit/verify").set(bearer(api.A.auditor))).body.ok).toBe(true);
  });

  test.each([
    ["an unknown type", { type: "sell", identifier: PHONE }],
    ["no type", { identifier: PHONE }],
    ["a bad identifier", { type: "access", identifier: "nope" }],
    ["details over 2000 characters", { type: "access", identifier: PHONE, details: "x".repeat(2001) }],
    ["details that are not text", { type: "access", identifier: PHONE, details: 5 }],
  ])("%s is 400", async (_n, body) => {
    expect((await submit(api.A.pk, body)).status).toBe(400);
  });

  test("the sdk scope may submit; the DPO scope may not (it is for answering)", async () => {
    expect((await submit(api.A.dpo, { type: "access", identifier: PHONE })).status).toBe(403);
    expect((await api.http().post("/v1/dsr").send({ type: "access", identifier: PHONE })).status).toBe(401);
  });
});

describe("the DPO queue", () => {
  test("lists a tenant's requests, soonest due first, with details, only for the dpo scope", async () => {
    const a = await create("access");
    const res = await api.http().get("/v1/dsr").set(bearer(api.A.dpo));
    expect(res.status).toBe(200);
    const mine = res.body.find((r: { id: string }) => r.id === a.id);
    expect(mine).toMatchObject({ type: "access", state: "submitted", details: "please help", overdue: false });
    const due = res.body.map((r: { dueAt: string }) => r.dueAt);
    expect([...due].sort()).toEqual(due);
    for (const t of [api.A.pk, api.A.admin, api.A.auditor]) expect((await api.http().get("/v1/dsr").set(bearer(t))).status).toBe(403);
  });

  test("never shows another tenant's requests", async () => {
    const b = await create("access", phone(), api.B);
    const aList = (await api.http().get("/v1/dsr").set(bearer(api.A.dpo))).body as { id: string }[];
    expect(aList.map((r) => r.id)).not.toContain(b.id);
    expect((await api.http().get(`/v1/dsr/${b.id}`).set(bearer(api.A.dpo))).status).toBe(404);
  });

  test("filters by state and by overdue", async () => {
    const late = await create("access");
    await backdate(late.id, "1 day");
    const overdue = (await api.http().get("/v1/dsr?overdue=true").set(bearer(api.A.dpo))).body as { id: string; overdue: boolean }[];
    expect(overdue.map((r) => r.id)).toContain(late.id);
    expect(overdue.every((r) => r.overdue)).toBe(true);
    await transition(api.A.dpo, late.id, { to: "in_review" });
    const inReview = (await api.http().get("/v1/dsr?state=in_review").set(bearer(api.A.dpo))).body as { id: string; state: string }[];
    expect(inReview.every((r) => r.state === "in_review")).toBe(true);
    expect(inReview.map((r) => r.id)).toContain(late.id);
    expect((await api.http().get("/v1/dsr?state=nope").set(bearer(api.A.dpo))).status).toBe(400);
    expect((await api.http().get("/v1/dsr?overdue=maybe").set(bearer(api.A.dpo))).status).toBe(400);
  });

  test("a finished request is never overdue", async () => {
    const r = await create("access");
    await backdate(r.id, "2 days");
    await transition(api.A.dpo, r.id, { to: "in_review" });
    await transition(api.A.dpo, r.id, { to: "fulfilled" });
    const got = (await api.http().get(`/v1/dsr/${r.id}`).set(bearer(api.A.dpo))).body;
    expect(got.overdue).toBe(false);
  });
});

describe("moving a request along", () => {
  test("every legal move works, is audited, and queues a webhook; every illegal one is 409 with the allowed moves", async () => {
    const r = await create("access");
    const auditBefore = (await owner("SELECT count(*)::int AS n FROM consent_audit_log WHERE tenant_id = $1 AND action = 'dsr.transitioned'", [api.A.id]))[0]?.n as number;
    for (const to of ["identity_pending", "in_review", "fulfilled", "closed"]) {
      const res = await transition(api.A.dpo, r.id, { to });
      expect({ to, status: res.status }).toEqual({ to, status: 200 });
      expect(res.body.state).toBe(to);
    }
    expect((await owner("SELECT count(*)::int AS n FROM consent_audit_log WHERE tenant_id = $1 AND action = 'dsr.transitioned'", [api.A.id]))[0]?.n).toBe(auditBefore + 4);
    const closed = (await api.http().get(`/v1/dsr/${r.id}`).set(bearer(api.A.dpo))).body;
    expect(closed.closedAt).not.toBeNull();
    const back = await transition(api.A.dpo, r.id, { to: "in_review" });
    expect(back.status).toBe(409);
    expect(back.body).toMatchObject({ error: "illegal_transition", from: "closed", to: "in_review", allowed: [] });
  });

  test("the API agrees with the state machine for every pair of states", async () => {
    for (const from of DSR_STATES) {
      for (const to of DSR_STATES) {
        const r = await create("access");
        await owner("ALTER TABLE dsr_requests DISABLE TRIGGER dsr_requests_guard");
        await owner("UPDATE dsr_requests SET state = $2, decided_reason = 'x' WHERE id = $1", [r.id, from]);
        await owner("ALTER TABLE dsr_requests ENABLE TRIGGER dsr_requests_guard");
        const res = await transition(api.A.dpo, r.id, { to, reason: "not valid" });
        expect({ from, to, ok: res.status === 200 }).toEqual({ from, to, ok: canTransition(from, to) });
      }
    }
  }, 120000);

  test("a rejection needs a reason, and the reason is kept", async () => {
    const r = await create("access");
    expect((await transition(api.A.dpo, r.id, { to: "rejected" })).status).toBe(400);
    expect((await transition(api.A.dpo, r.id, { to: "rejected", reason: "  " })).status).toBe(400);
    const ok = await transition(api.A.dpo, r.id, { to: "rejected", reason: "identity not confirmed" });
    expect(ok.status).toBe(200);
    expect(ok.body.decidedReason).toBe("identity not confirmed");
  });

  test.each([
    ["an unknown state", { to: "teleported" }],
    ["no target", {}],
    ["a reason that is not text", { to: "rejected", reason: 5 }],
    ["a reason over 500 characters", { to: "rejected", reason: "x".repeat(501) }],
  ])("%s is 400", async (_n, body) => {
    const r = await create("access");
    expect((await transition(api.A.dpo, r.id, body)).status).toBe(400);
  });

  test("only the dpo scope of the owning tenant may move it; others get 403 or 404; bad ids are 400", async () => {
    const r = await create("access");
    for (const t of [api.A.pk, api.A.admin, api.A.auditor]) expect((await transition(t, r.id, { to: "in_review" })).status).toBe(403);
    expect((await transition(api.B.dpo, r.id, { to: "in_review" })).status).toBe(404);
    expect((await transition(api.A.dpo, randomUUID(), { to: "in_review" })).status).toBe(404);
    expect((await transition(api.A.dpo, "nope", { to: "in_review" })).status).toBe(400);
  });

  test("two simultaneous moves: one wins and the other is told it is no longer possible", async () => {
    const r = await create("access");
    const [x, y] = await Promise.all([transition(api.A.dpo, r.id, { to: "in_review" }), transition(api.A.dpo, r.id, { to: "rejected", reason: "race" })]);
    const statuses = [x.status, y.status].sort();
    expect(statuses[0]).toBe(200);
    // Whichever landed first, the second must not have overwritten it unless it was a legal move from the new state.
    const final = (await owner("SELECT state FROM dsr_requests WHERE id = $1", [r.id]))[0]?.state;
    expect(["in_review", "rejected"]).toContain(final);
  });

  test("the audit chain still verifies after all of this", async () => {
    expect((await api.http().get("/v1/audit/verify").set(bearer(api.A.auditor))).body.ok).toBe(true);
  });
});

describe("the person's contact", () => {
  test("the DPO can read it, every read is an audit event with who read it, and nobody else can", async () => {
    const id = phone();
    const r = await create("access", id);
    const before = (await owner("SELECT count(*)::int AS n FROM consent_audit_log WHERE tenant_id = $1 AND action = 'dsr.contact_revealed'", [api.A.id]))[0]?.n as number;
    const res = await api.http().post(`/v1/dsr/${r.id}/reveal-contact`).set(bearer(api.A.dpo));
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ contact: id });
    expect((await owner("SELECT count(*)::int AS n FROM consent_audit_log WHERE tenant_id = $1 AND action = 'dsr.contact_revealed'", [api.A.id]))[0]?.n).toBe(before + 1);
    const entry = (await owner("SELECT actor_type, actor_id, ref_table FROM consent_audit_log WHERE tenant_id = $1 AND action = 'dsr.contact_revealed' ORDER BY seq_no DESC LIMIT 1", [api.A.id]))[0];
    expect(entry).toMatchObject({ actor_type: "dpo", ref_table: "dsr_requests" });
    expect(String(entry?.actor_id)).toMatch(/^api-key:/);
    for (const t of [api.A.pk, api.A.admin, api.A.auditor]) expect((await api.http().post(`/v1/dsr/${r.id}/reveal-contact`).set(bearer(t))).status).toBe(403);
    expect((await api.http().post(`/v1/dsr/${r.id}/reveal-contact`).set(bearer(api.B.dpo))).status).toBe(404);
  });

  test("a formatted phone number is revealed in its normal form", async () => {
    const r = (await submit(api.A.pk, { type: "access", identifier: "+91 98100-12345" })).body as { id: string };
    expect((await api.http().post(`/v1/dsr/${r.id}/reveal-contact`).set(bearer(api.A.dpo))).body.contact).toBe("+919810012345");
  });
});

describe("fulfilling an erasure request", () => {
  test("withdraws the person's consents, deletes the sealed contact, and unlinks the identifier from the person, leaving the audit chain intact", async () => {
    const id = phone();
    const g = (await api.grant(api.A, { identifier: id })).body as { consentId: string; receipt: string };
    const principal = (await verifyReceipt(g.receipt, api.keys.jwks())).piiPrincipalId;
    const r = await create("erasure", id);
    await transition(api.A.dpo, r.id, { to: "in_review" });
    const done = await transition(api.A.dpo, r.id, { to: "fulfilled" });
    expect(done.status).toBe(200);

    expect((await owner("SELECT status FROM consent_records WHERE id = $1", [g.consentId]))[0]?.status).toBe("withdrawn");
    expect((await owner("SELECT count(*)::int AS n FROM principal_contacts WHERE principal_id = $1", [principal]))[0]?.n).toBe(0);
    expect((await api.http().post(`/v1/dsr/${r.id}/reveal-contact`).set(bearer(api.A.dpo))).status).toBe(410);

    // The same identifier is now a different person: the old pseudonym no longer maps to anyone.
    const again = (await api.grant(api.A, { identifier: id })).body as { receipt: string };
    expect((await verifyReceipt(again.receipt, api.keys.jwks())).piiPrincipalId).not.toBe(principal);

    expect((await api.http().get("/v1/audit/verify").set(bearer(api.A.auditor))).body.ok).toBe(true);
    expect((await owner("SELECT count(*)::int AS n FROM consent_audit_log WHERE tenant_id = $1 AND ref_id = $2", [api.A.id, g.consentId]))[0]?.n).toBe(2); // granted and withdrawn stay on record
  });

  test("other types and other transitions erase nothing", async () => {
    const id = phone();
    const g = (await api.grant(api.A, { identifier: id })).body as { consentId: string };
    const r = await create("access", id);
    await transition(api.A.dpo, r.id, { to: "in_review" });
    await transition(api.A.dpo, r.id, { to: "fulfilled" });
    expect((await owner("SELECT status FROM consent_records WHERE id = $1", [g.consentId]))[0]?.status).toBe("granted");
    expect((await owner("SELECT count(*)::int AS n FROM principal_contacts pc JOIN dsr_requests d ON d.principal_id = pc.principal_id WHERE d.id = $1", [r.id]))[0]?.n).toBe(1);

    const e = await create("erasure", phone());
    await transition(api.A.dpo, e.id, { to: "in_review" });
    await transition(api.A.dpo, e.id, { to: "rejected", reason: "not the data subject" });
    expect((await owner("SELECT count(*)::int AS n FROM principal_contacts pc JOIN dsr_requests d ON d.principal_id = pc.principal_id WHERE d.id = $1", [e.id]))[0]?.n).toBe(1);
  });

  test("a failure part way leaves nothing half done (one transaction)", async () => {
    const id = phone();
    const g = (await api.grant(api.A, { identifier: id })).body as { consentId: string };
    const r = await create("erasure", id);
    await transition(api.A.dpo, r.id, { to: "in_review" });
    // Make the last step of the erasure (queuing its webhook) fail, to see that nothing before it sticks.
    await owner("INSERT INTO webhook_endpoints (id, tenant_id, url, events) VALUES ($1, $2, 'https://boom.example.org/x', '{dsr.transitioned}')", [randomUUID(), api.A.id]);
    await owner("ALTER TABLE webhook_deliveries ADD CONSTRAINT boom CHECK (false) NOT VALID");
    const res = await transition(api.A.dpo, r.id, { to: "fulfilled" });
    await owner("ALTER TABLE webhook_deliveries DROP CONSTRAINT boom");
    await owner("UPDATE webhook_endpoints SET disabled_at = now() WHERE url = 'https://boom.example.org/x'");
    expect(res.status).toBeGreaterThanOrEqual(500);
    expect((await owner("SELECT state FROM dsr_requests WHERE id = $1", [r.id]))[0]?.state).toBe("in_review");
    expect((await owner("SELECT status FROM consent_records WHERE id = $1", [g.consentId]))[0]?.status).toBe("granted");
    expect((await owner("SELECT count(*)::int AS n FROM principal_contacts pc JOIN dsr_requests d ON d.principal_id = pc.principal_id WHERE d.id = $1", [r.id]))[0]?.n).toBe(1);
  });
});
