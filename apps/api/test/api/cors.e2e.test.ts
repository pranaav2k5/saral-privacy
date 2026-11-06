import { startApi, ORIGIN, type Api } from "./harness.js";

let api: Api;

beforeAll(async () => {
  api = await startApi();
});

afterAll(async () => {
  await api.stop();
});

describe("CORS for the browser SDK", () => {
  test("a preflight (which carries no credentials) is answered without a key", async () => {
    const res = await api
      .http()
      .options("/v1/consents")
      .set("Origin", ORIGIN)
      .set("Access-Control-Request-Method", "POST")
      .set("Access-Control-Request-Headers", "authorization,content-type,idempotency-key");
    expect(res.status).toBe(204);
    expect(res.headers["access-control-allow-origin"]).toBe(ORIGIN);
    expect(res.headers["access-control-allow-methods"]).toMatch(/POST/);
    expect(res.headers["access-control-allow-headers"]?.toLowerCase()).toMatch(/authorization/);
    expect(res.headers["access-control-allow-headers"]?.toLowerCase()).toMatch(/idempotency-key/);
    expect(res.headers["access-control-max-age"]).toBeDefined();
  });

  test("a preflight for DELETE is allowed, because the dashboard disables webhook endpoints that way", async () => {
    const res = await api
      .http()
      .options("/v1/webhook-endpoints/00000000-0000-4000-8000-000000000000")
      .set("Origin", ORIGIN)
      .set("Access-Control-Request-Method", "DELETE")
      .set("Access-Control-Request-Headers", "authorization");
    expect(res.status).toBe(204);
    expect(res.headers["access-control-allow-methods"]).toMatch(/DELETE/);
  });

  test("cookies are never allowed: authentication is by key only", async () => {
    const res = await api.http().options("/v1/consents").set("Origin", ORIGIN).set("Access-Control-Request-Method", "POST");
    expect(res.headers["access-control-allow-credentials"]).toBeUndefined();
  });

  test("a real request from a page gets the allow-origin header on success and on failure", async () => {
    const ok = await api.grant(api.A, {}, { Origin: ORIGIN });
    expect(ok.status).toBe(201);
    expect(ok.headers["access-control-allow-origin"]).toBe(ORIGIN);
    const denied = await api.http().post("/v1/consents").set("Origin", ORIGIN).send({});
    expect(denied.status).toBe(401);
    expect(denied.headers["access-control-allow-origin"]).toBe(ORIGIN); // so the page can read the error
  });

  test("the key's origin list is still enforced on the real request (CORS is not authorisation)", async () => {
    const { issueApiKey } = await import("../../src/auth/api-keys.js");
    const { token } = await issueApiKey(api.db.owner, api.keys.apiKeyPepper(), { tenantId: api.A.id, kind: "publishable", scopes: ["sdk"], name: "locked", allowedOrigins: [ORIGIN] });
    const res = await api.http().post("/v1/consents").set("Origin", "https://evil.example").set("Authorization", `Bearer ${token}`)
      .send({ noticeId: api.A.noticeId, identifier: "+919876543210", purposes: [{ key: "analytics", granted: true }] });
    expect(res.status).toBe(403);
  });
});
