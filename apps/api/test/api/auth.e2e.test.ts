import { Controller, Get } from "@nestjs/common";
import { Test } from "@nestjs/testing";
import request from "supertest";
import { AppModule } from "../../src/app.module.js";
import { SETTINGS } from "../../src/settings.js";
import { ORIGIN, startApi, MASTER, type Api } from "./harness.js";
import { issueApiKey } from "../../src/auth/api-keys.js";
import { TENANT_A } from "../db/helpers.js";

let api: Api;

beforeAll(async () => {
  api = await startApi();
});

afterAll(async () => {
  await api.stop();
});

const post = (token: string | undefined, extra: Record<string, string> = {}) => {
  const r = api.http().post("/v1/consents").set(extra);
  return (token ? r.set("Authorization", `Bearer ${token}`) : r).send({
    noticeId: api.A.noticeId,
    identifier: "+919876543210",
    purposes: [{ key: "analytics", granted: true }],
  });
};

describe("authentication", () => {
  test.each([
    ["no header", undefined],
    ["a malformed token", "not-a-key"],
    ["a well-formed token for a key that does not exist", "sk_" + "0".repeat(32) + "_" + "a".repeat(43)],
  ])("%s is 401 with one uniform message", async (_n, token) => {
    const res = await post(token);
    expect(res.status).toBe(401);
    expect(res.body.message).toBe("invalid API key");
  });

  test("a real key id with the wrong secret is the same 401", async () => {
    const parts = api.A.pk.split("_");
    const forged = `${parts[0] ?? ""}_${parts[1] ?? ""}_${"b".repeat(43)}`;
    const res = await post(forged);
    expect(res.status).toBe(401);
    expect(res.body.message).toBe("invalid API key");
  });

  test("a revoked key is 401", async () => {
    const { id, token } = await issueApiKey(api.db.owner, api.keys.apiKeyPepper(), { tenantId: TENANT_A, kind: "publishable", scopes: ["sdk"], name: "temp" });
    expect((await post(token)).status).toBe(201);
    await api.db.owner.query("UPDATE api_keys SET revoked_at = now() WHERE id = $1", [id]);
    expect((await post(token)).status).toBe(401);
  });

  test("a key from another deployment (different pepper) is 401", async () => {
    const { token } = await issueApiKey(api.db.owner, new Uint8Array(32).fill(1), { tenantId: TENANT_A, kind: "publishable", scopes: ["sdk"], name: "foreign" });
    expect((await post(token)).status).toBe(401);
  });
});

describe("authorization", () => {
  test("scopes decide who may call what", async () => {
    const audit = (t: string) => api.http().get("/v1/audit/verify").set("Authorization", `Bearer ${t}`);
    expect((await audit(api.A.pk)).status).toBe(403); // sdk cannot verify the audit log
    expect((await audit(api.A.dpo)).status).toBe(403);
    expect((await audit(api.A.auditor)).status).toBe(200);
    expect((await audit(api.A.admin)).status).toBe(403);
    expect((await post(api.A.auditor)).status).toBe(403); // an auditor cannot record consents
    expect((await post(api.A.admin)).status).toBe(403);
  });

  test("a route with no access rule is refused, so a forgotten decorator fails closed", async () => {
    @Controller("oops")
    class Oops {
      @Get()
      open() {
        return { open: true };
      }
    }
    const moduleRef = await Test.createTestingModule({ imports: [AppModule], controllers: [Oops] })
      .overrideProvider(SETTINGS)
      .useValue({ databaseUrl: api.db.url, nodeEnv: "test", devMasterSecret: MASTER })
      .compile();
    const app = moduleRef.createNestApplication();
    await app.init();
    try {
      const res = await request(app.getHttpServer()).get("/oops");
      expect(res.status).toBe(403);
    } finally {
      await app.close();
    }
  });

  test("a publishable key restricted to an origin only works from that origin", async () => {
    const { token } = await issueApiKey(api.db.owner, api.keys.apiKeyPepper(), { tenantId: TENANT_A, kind: "publishable", scopes: ["sdk"], name: "shop", allowedOrigins: [ORIGIN] });
    expect((await post(token, { Origin: "https://evil.example" })).status).toBe(403);
    expect((await post(token)).status).toBe(403); // no Origin header at all
    expect((await post(token, { Origin: ORIGIN })).status).toBe(201);
  });

  test("an unrestricted publishable key works from any origin, and secret keys ignore Origin", async () => {
    expect((await post(api.A.pk, { Origin: "https://anywhere.example" })).status).toBe(201);
    const verify = await api.http().get("/v1/audit/verify").set("Authorization", `Bearer ${api.A.auditor}`).set("Origin", "https://evil.example");
    expect(verify.status).toBe(200);
  });
});
