import { randomUUID } from "node:crypto";
import { verifyReceipt } from "@saral/receipts";
import { connect, sha256, NOTICE_TEXT } from "../db/helpers.js";
import { PHONE, PUBLIC_BASE_URL, startApi, type Api } from "./harness.js";

let api: Api;

beforeAll(async () => {
  api = await startApi();
});

afterAll(async () => {
  await api.stop();
});

const bearer = (token: string) => ({ Authorization: `Bearer ${token}` });

describe("POST /v1/consents", () => {
  test("returns a signed receipt that verifies against the published JWKS", async () => {
    const res = await api.grant(api.A);
    expect(res.status).toBe(201);
    expect(res.body).toMatchObject({ status: "granted" });
    expect(res.body.consentId).toMatch(/^[0-9a-f-]{36}$/);

    const jwks = (await api.http().get("/.well-known/jwks.json")).body;
    const claims = await verifyReceipt(res.body.receipt, jwks);
    expect(claims.consentReceiptID).toBe(res.body.receiptId);
    expect(claims.version).toBe("KI-CR-v1.1.0");
    // Only granted purposes are on the receipt; details and retention come from the notice, not the caller.
    expect(claims.services[0]?.purposes.map((p) => p.purposeCategory[0])).toEqual(["analytics"]);
    expect(claims.piiControllers[0]?.piiController).toBe("Example Controller Pvt Ltd");
    // The receipt points to the published notice, which never changes, not to a page the tenant can edit later.
    expect(claims.policyUrl).toBe(`${PUBLIC_BASE_URL}/v1/notices/${api.A.noticeId}`);
  });

  test("the receipt names the consent and the exact notice text, so a person holding only the receipt can tell what it covers", async () => {
    const res = await api.grant(api.A, { identifier: "+919830000001" });
    const claims = await verifyReceipt(res.body.receipt, api.keys.jwks());
    expect(claims.saralConsentId).toBe(res.body.consentId);
    expect(claims.saralNoticeId).toBe(api.A.noticeId);
    expect(claims.saralNoticeSha256).toBe(sha256(NOTICE_TEXT));
  });

  test("the same person gets the same principal each time, and a different one in another tenant", async () => {
    const a1 = await verifyReceipt((await api.grant(api.A)).body.receipt, api.keys.jwks());
    const a2 = await verifyReceipt((await api.grant(api.A)).body.receipt, api.keys.jwks());
    const b1 = await verifyReceipt((await api.grant(api.B)).body.receipt, api.keys.jwks());
    expect(a1.piiPrincipalId).toBe(a2.piiPrincipalId);
    expect(b1.piiPrincipalId).not.toBe(a1.piiPrincipalId);
  });

  test("a phone written differently is the same person", async () => {
    const a = await verifyReceipt((await api.grant(api.A, { identifier: "+91 98765-43210" })).body.receipt, api.keys.jwks());
    const b = await verifyReceipt((await api.grant(api.A, { identifier: PHONE })).body.receipt, api.keys.jwks());
    expect(a.piiPrincipalId).toBe(b.piiPrincipalId);
  });

  test("the raw identifier is never stored anywhere in the database", async () => {
    await api.grant(api.A, { identifier: "+919000011122" });
    await api.grant(api.A, { identifier: "Distinct.Person@Example.org" });
    const tables = (await api.db.owner.query("SELECT tablename FROM pg_tables WHERE schemaname = 'public'")).rows as { tablename: string }[];
    for (const { tablename } of tables) {
      const dump = (await api.db.owner.query(`SELECT coalesce(string_agg(t::text, ' '), '') AS s FROM ${tablename} t`)).rows[0].s as string;
      for (const needle of ["9000011122", "distinct.person", "Distinct.Person"]) {
        expect({ tablename, found: dump.includes(needle) }).toEqual({ tablename, found: false });
      }
    }
  });

  test("retention comes from the notice's definitions, whatever the caller sends", async () => {
    const res = await api.grant(api.A, {
      identifier: "+919555555555",
      purposes: [
        { key: "analytics", granted: true, retentionDays: 1 },
        { key: "marketing", granted: false, retentionDays: 99999 },
      ],
    });
    expect(res.status).toBe(201);
    const row = (await api.db.owner.query("SELECT purposes FROM consent_records WHERE id = $1", [res.body.consentId])).rows[0];
    expect(row.purposes).toEqual([
      { key: "analytics", granted: true, retentionDays: 365 },
      { key: "marketing", granted: false, retentionDays: 180 },
    ]);
  });

  test("the consent is bound to the notice by hash, and the audit entry to the consent's content", async () => {
    const res = await api.grant(api.A, { identifier: "+919666666666" });
    const row = (await api.db.owner.query(
      `SELECT r.notice_sha256, n.canonical_sha256, a.payload_sha256, a.actor_type, a.ref_table FROM consent_records r
       JOIN privacy_notices n ON n.id = r.notice_id JOIN consent_audit_log a ON a.ref_id = r.id WHERE r.id = $1`, [res.body.consentId])).rows[0];
    expect(row.notice_sha256).toBe(row.canonical_sha256);
    expect(row.payload_sha256).toMatch(/^[0-9a-f]{64}$/);
    expect(row).toMatchObject({ actor_type: "principal", ref_table: "consent_records" });
  });

  test("a purpose that the notice does not define is 422", async () => {
    const res = await api.grant(api.A, { purposes: [{ key: "telepathy", granted: true }] });
    expect(res.status).toBe(422);
    expect(res.body.message).toMatch(/telepathy/);
  });

  test("a consent with no granted purpose is 422", async () => {
    const res = await api.grant(api.A, { purposes: [{ key: "analytics", granted: false }] });
    expect(res.status).toBe(422);
  });

  test("another tenant's notice is 404", async () => {
    const res = await api.grant(api.A, { noticeId: api.B.noticeId });
    expect(res.status).toBe(404);
  });

  test.each([
    ["no body", undefined],
    ["a bad notice id", { noticeId: "nope" }],
    ["a bad identifier", { identifier: "not-an-id" }],
    ["purposes that are not an array", { purposes: "analytics" }],
    ["an empty purposes array", { purposes: [] }],
    ["a purpose granted as a string", { purposes: [{ key: "analytics", granted: "yes" }] }],
    ["a duplicate purpose", { purposes: [{ key: "analytics", granted: true }, { key: "analytics", granted: false }] }],
    ["more than 50 purposes", { purposes: Array.from({ length: 51 }, (_, i) => ({ key: `p${String(i)}`, granted: true })) }],
  ])("%s is 400", async (_n, body) => {
    const res = await api.http().post("/v1/consents").set(bearer(api.A.pk)).send(body === undefined ? undefined : { noticeId: api.A.noticeId, identifier: PHONE, purposes: [{ key: "analytics", granted: true }], ...body });
    expect(res.status).toBe(400);
    expect(res.body.error).toBe("invalid_request");
  });
});

describe("retrying a consent request safely (Idempotency-Key)", () => {
  const body = { identifier: "+919840000001", purposes: [{ key: "analytics", granted: true }, { key: "marketing", granted: false }] };
  const KEY = "retry-key-abcdef-0001";

  test("the same key with the same request returns the first consent unchanged (200) and records nothing again", async () => {
    const first = await api.grant(api.A, body, { "Idempotency-Key": KEY });
    expect(first.status).toBe(201);
    const auditBefore = (await api.db.owner.query("SELECT count(*)::int AS n FROM consent_audit_log WHERE tenant_id = $1", [api.A.id])).rows[0].n as number;
    const second = await api.grant(api.A, { ...body, purposes: [...body.purposes].reverse() }, { "Idempotency-Key": KEY });
    expect(second.status).toBe(200);
    expect(second.body).toEqual(first.body);
    expect((await api.db.owner.query("SELECT count(*)::int AS n FROM consent_audit_log WHERE tenant_id = $1", [api.A.id])).rows[0].n).toBe(auditBefore);
  });

  test("the same key with a different request is refused (409) instead of silently returning something else", async () => {
    await api.grant(api.A, body, { "Idempotency-Key": "retry-key-abcdef-0002" });
    const other = await api.grant(api.A, { ...body, purposes: [{ key: "analytics", granted: true }] }, { "Idempotency-Key": "retry-key-abcdef-0002" });
    expect(other.status).toBe(409);
    expect(other.body.error).toBe("idempotency_key_reused");
    const otherPerson = await api.grant(api.A, { ...body, identifier: "+919840000099" }, { "Idempotency-Key": "retry-key-abcdef-0002" });
    expect(otherPerson.status).toBe(409);
  });

  test("a key whose consent has since been withdrawn is not replayed as if it were current", async () => {
    const id = "+919840000055";
    const k = "retry-key-abcdef-0055";
    const first = await api.grant(api.A, { identifier: id, purposes: [{ key: "analytics", granted: true }] }, { "Idempotency-Key": k });
    expect(first.status).toBe(201);
    await api.http().post(`/v1/consents/${first.body.consentId}/withdraw`).set(bearer(api.A.pk)).send({ identifier: id });
    const again = await api.grant(api.A, { identifier: id, purposes: [{ key: "analytics", granted: true }] }, { "Idempotency-Key": k });
    expect(again.status).toBe(409);
    expect(again.body.error).toBe("idempotency_key_reused");
    const fresh = await api.grant(api.A, { identifier: id, purposes: [{ key: "analytics", granted: true }] }, { "Idempotency-Key": "retry-key-abcdef-0056" });
    expect(fresh.status).toBe(201);
    expect(fresh.body.consentId).not.toBe(first.body.consentId);
  });

  test("a key from another tenant means nothing here", async () => {
    await api.grant(api.B, body, { "Idempotency-Key": "retry-key-abcdef-0003" });
    const mine = await api.grant(api.A, body, { "Idempotency-Key": "retry-key-abcdef-0003" });
    expect(mine.status).toBe(201);
  });

  test("without a key, nothing is recognised: the same request twice is two consents, and no answer reveals an earlier one", async () => {
    const one = await api.grant(api.A, { identifier: "+919840000002", purposes: [{ key: "analytics", granted: true }] });
    const two = await api.grant(api.A, { identifier: "+919840000002", purposes: [{ key: "analytics", granted: true }] });
    expect(one.status).toBe(201);
    expect(two.status).toBe(201); // always 201: a stranger who knows an identifier learns nothing, and gets no receipt back
    expect(two.body.consentId).not.toBe(one.body.consentId);
    expect(two.body.receipt).not.toBe(one.body.receipt);
  });

  test.each(["short", "has a space in it", "bad/char/here", "x".repeat(129)])("a malformed key %p is 400", async (key) => {
    expect((await api.grant(api.A, body, { "Idempotency-Key": key })).status).toBe(400);
  });

  test("simultaneous retries with one key record one consent", async () => {
    await api.grant(api.A, { identifier: "+919840000077", purposes: [{ key: "analytics", granted: true }, { key: "marketing", granted: true }] }); // the person exists
    const same = { identifier: "+919840000077", purposes: [{ key: "analytics", granted: true }] };
    // Hold the tenant's lock so that all eight requests are in flight, past validation, at the same moment; then let them go.
    const holder = await connect(api.db);
    await holder.query("BEGIN");
    await holder.query("SELECT audit_append_lock($1)", [api.A.id]);
    const pending = Array.from({ length: 8 }, () => api.grant(api.A, same, { "Idempotency-Key": "retry-key-abcdef-0077" }).then((r) => r));
    await new Promise((r) => setTimeout(r, 500));
    await holder.query("COMMIT");
    await holder.end();
    const results = await Promise.all(pending);
    expect(results.filter((r) => r.status === 201)).toHaveLength(1);
    expect(results.filter((r) => r.status === 200)).toHaveLength(7);
    expect(new Set(results.map((r) => r.body.consentId)).size).toBe(1);
  });
});

describe("withdrawing every consent of a person by identifier (for a tenant's server)", () => {
  const withdrawAll = (token: string, body: Record<string, unknown>) => api.http().post("/v1/consents/withdraw").set(bearer(token)).send(body);

  test("a browser (publishable) key is refused: knowing someone's email must not be enough to withdraw their consents", async () => {
    const id = "+919850000010";
    const g = (await api.grant(api.A, { identifier: id })).body;
    const res = await withdrawAll(api.A.pk, { identifier: id });
    expect(res.status).toBe(403);
    expect(res.body.message).toMatch(/secret key/);
    expect((await api.db.owner.query("SELECT status FROM consent_records WHERE id = $1", [g.consentId])).rows[0].status).toBe("granted");
  });

  test("a secret key withdraws every consent the person has, found by identifier alone; each is audited", async () => {
    const id = "+919850000001";
    const a = (await api.grant(api.A, { identifier: id, purposes: [{ key: "analytics", granted: true }, { key: "marketing", granted: true }] })).body;
    const b = (await api.grant(api.A, { identifier: id, purposes: [{ key: "analytics", granted: true }] })).body;
    const before = (await api.db.owner.query("SELECT count(*)::int AS n FROM consent_audit_log WHERE tenant_id = $1 AND action = 'consent.withdrawn'", [api.A.id])).rows[0].n as number;
    const res = await withdrawAll(api.A.server, { identifier: id, noticeId: api.A.noticeId });
    expect(res.status).toBe(200);
    expect(res.body.status).toBe("withdrawn");
    expect([...res.body.consentIds].sort()).toEqual([a.consentId, b.consentId].sort());
    const states = (await api.db.owner.query("SELECT status FROM consent_records WHERE id = ANY($1)", [[a.consentId, b.consentId]])).rows.map((r: { status: string }) => r.status);
    expect(states).toEqual(["withdrawn", "withdrawn"]);
    expect((await api.db.owner.query("SELECT count(*)::int AS n FROM consent_audit_log WHERE tenant_id = $1 AND action = 'consent.withdrawn'", [api.A.id])).rows[0].n).toBe(before + 2);
    expect((await api.http().get("/v1/audit/verify").set(bearer(api.A.auditor))).body.ok).toBe(true);
    expect((await withdrawAll(api.A.server, { identifier: id })).status).toBe(404); // nothing left to withdraw
  });

  test("a wrong identifier, another tenant, or another notice finds nothing and changes nothing", async () => {
    const id = "+919850000002";
    const g = (await api.grant(api.A, { identifier: id })).body;
    expect((await withdrawAll(api.A.server, { identifier: "+919850000009" })).status).toBe(404);
    expect((await withdrawAll(api.B.server, { identifier: id })).status).toBe(404);
    expect((await withdrawAll(api.A.server, { identifier: id, noticeId: api.B.noticeId })).status).toBe(404);
    expect((await api.db.owner.query("SELECT status FROM consent_records WHERE id = $1", [g.consentId])).rows[0].status).toBe("granted");
  });

  test("needs the sdk scope and a valid body", async () => {
    expect((await withdrawAll(api.A.admin, { identifier: PHONE })).status).toBe(403);
    expect((await withdrawAll(api.A.server, { identifier: "nope" })).status).toBe(400);
    expect((await withdrawAll(api.A.server, { identifier: PHONE, noticeId: "nope" })).status).toBe(400);
    expect((await api.http().post("/v1/consents/withdraw").send({ identifier: PHONE })).status).toBe(401);
  });

  test("queues a withdrawal event for each consent", async () => {
    await api.db.owner.query("UPDATE webhook_endpoints SET disabled_at = now() WHERE tenant_id = $1", [api.A.id]);
    const ep = "ffffffff-ffff-4fff-8fff-ffffffffff01";
    await api.db.owner.query("INSERT INTO webhook_endpoints (id, tenant_id, url, events) VALUES ($1, $2, 'https://w.example.org/x', '{consent.withdrawn}')", [ep, api.A.id]);
    await api.grant(api.A, { identifier: "+919850000003" });
    await withdrawAll(api.A.server, { identifier: "+919850000003" });
    expect((await api.db.owner.query("SELECT count(*)::int AS n FROM webhook_deliveries WHERE endpoint_id = $1", [ep])).rows[0].n).toBe(1);
  });
});

describe("withdrawal", () => {
  test("withdrawing appends an audit entry, and the person can only withdraw their own consent", async () => {
    const granted = (await api.grant(api.A, { identifier: "+919111111111" })).body;
    const wrong = await api.http().post(`/v1/consents/${granted.consentId}/withdraw`).set(bearer(api.A.pk)).send({ identifier: "+919222222222" });
    expect(wrong.status).toBe(404);
    const ok = await api.http().post(`/v1/consents/${granted.consentId}/withdraw`).set(bearer(api.A.pk)).send({ identifier: "+919111111111" });
    expect(ok.status).toBe(200);
    expect(ok.body).toMatchObject({ consentId: granted.consentId, status: "withdrawn" });
    const again = await api.http().post(`/v1/consents/${granted.consentId}/withdraw`).set(bearer(api.A.pk)).send({ identifier: "+919111111111" });
    expect(again.status).toBe(409);
    const row = (await api.db.owner.query("SELECT status, withdrawn_at FROM consent_records WHERE id = $1", [granted.consentId])).rows[0];
    expect(row.status).toBe("withdrawn");
    expect(row.withdrawn_at).not.toBeNull();
  });

  test("another tenant's key cannot withdraw it, and cannot even see that it exists", async () => {
    const granted = (await api.grant(api.A, { identifier: "+919333333333" })).body;
    const res = await api.http().post(`/v1/consents/${granted.consentId}/withdraw`).set(bearer(api.B.pk)).send({ identifier: "+919333333333" });
    expect(res.status).toBe(404);
  });

  test("an unknown consent id is 404 and a malformed one is 400", async () => {
    const unknown = await api.http().post(`/v1/consents/${randomUUID()}/withdraw`).set(bearer(api.A.pk)).send({ identifier: PHONE });
    expect(unknown.status).toBe(404);
    const malformed = await api.http().post("/v1/consents/nope/withdraw").set(bearer(api.A.pk)).send({ identifier: PHONE });
    expect(malformed.status).toBe(400);
  });
});

describe("GET /v1/consents/:id/receipt", () => {
  test("an admin key gets the receipt; another tenant's admin gets 404; the sdk key is refused", async () => {
    const granted = (await api.grant(api.A, { identifier: "+919444444444" })).body;
    const ok = await api.http().get(`/v1/consents/${granted.consentId}/receipt`).set(bearer(api.A.admin));
    expect(ok.status).toBe(200);
    expect(ok.body.receipt).toBe(granted.receipt);
    expect((await api.http().get(`/v1/consents/${granted.consentId}/receipt`).set(bearer(api.B.admin))).status).toBe(404);
    expect((await api.http().get(`/v1/consents/${granted.consentId}/receipt`).set(bearer(api.A.pk))).status).toBe(403);
  });
});

describe("public endpoints", () => {
  test("the JWKS has public members only and may be cached", async () => {
    const res = await api.http().get("/.well-known/jwks.json");
    expect(res.status).toBe(200);
    expect(res.headers["cache-control"]).toMatch(/max-age=\d+/);
    expect(JSON.stringify(res.body)).not.toMatch(/"(d|p|q|dp|dq|qi)":/);
    expect(res.body.keys[0]).toMatchObject({ kty: "RSA", alg: "RS256", use: "sig" });
  });

  test("a notice is public by its id", async () => {
    const res = await api.http().get(`/v1/notices/${api.A.noticeId}`);
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ id: api.A.noticeId, version: 1, language: "en", canonicalText: "notice text", reviewStatus: "pending-human-review" });
    expect(res.body.canonicalSha256).toMatch(/^[0-9a-f]{64}$/);
    expect(res.body).not.toHaveProperty("tenantId");
    expect((await api.http().get(`/v1/notices/${randomUUID()}`)).status).toBe(404);
    expect((await api.http().get("/v1/notices/nope")).status).toBe(400);
  });

  test("health stays open", async () => {
    expect((await api.http().get("/healthz")).status).toBe(200);
  });
});
