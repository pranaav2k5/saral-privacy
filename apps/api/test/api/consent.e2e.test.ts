import { randomUUID } from "node:crypto";
import { verifyReceipt } from "@saral/receipts";
import { PHONE, startApi, type Api } from "./harness.js";

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
    expect(claims.policyUrl).toBe("https://example.org/privacy");
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
