import { Database } from "../../src/db/database.js";
import { DEFAULT_LIMITS } from "../../src/ratelimit/policies.js";
import { startApi, type Api } from "./harness.js";

/** Tight limits so a test can reach them: 5 requests from one address, 3 sign-in attempts, 4 requests with one key, each per minute. */
const TIGHT = { ip: { limit: 5, windowMs: 60_000 }, auth: { limit: 3, windowMs: 60_000 }, principal: { limit: 4, windowMs: 60_000 } };

let api: Api;
let now = 1_000_000;
beforeAll(async () => {
  api = await startApi({ limits: TIGHT, trustProxy: 1, clock: () => now });
});
afterAll(async () => {
  await api.stop();
});

let n = 0;
/** A fresh client address per test, so the tests do not share a bucket. */
const from = () => `198.51.100.${String(++n)}`;
const login = (ip: string) => api.http().post("/v1/auth/login").set("X-Forwarded-For", ip).send({ tenant: "nobody", email: "a@example.org", password: "not-a-real-password" });
const notice = (ip: string) => api.http().get(`/v1/notices/${api.A.noticeId}`).set("X-Forwarded-For", ip);

describe("the limits", () => {
  test("are the ones the design says (loosening them is a decision, not an accident)", () => {
    expect(DEFAULT_LIMITS).toEqual({
      ip: { limit: 600, windowMs: 60_000 },
      auth: { limit: 10, windowMs: 60_000 },
      principal: { limit: 1200, windowMs: 60_000 },
    });
  });
});

describe("sign-in routes", () => {
  test("allow a few attempts from one address, then answer 429 with how long to wait, in words and in a header", async () => {
    const ip = from();
    for (let i = 0; i < 3; i++) expect((await login(ip)).status).toBe(401);
    const res = await login(ip);
    expect(res.status).toBe(429);
    expect(res.headers["retry-after"]).toBe("60");
    expect(res.body).toEqual({ error: "rate_limited", message: "Too many requests. Try again in 60 seconds." });
  });

  test("do not slow down anyone else", async () => {
    const busy = from();
    for (let i = 0; i < 4; i++) await login(busy);
    expect((await login(busy)).status).toBe(429);
    expect((await login(from())).status).toBe(401);
  });

  test("count sign-in, authenticator set-up and code check together, so each cannot be tried three times separately", async () => {
    const ip = from();
    const h = (path: string) => api.http().post(path).set("X-Forwarded-For", ip).send({ challenge: "x", code: "000000" });
    expect((await login(ip)).status).toBe(401);
    expect((await h("/v1/auth/mfa/enroll")).status).toBeLessThan(429);
    expect((await h("/v1/auth/mfa/verify")).status).toBeLessThan(429);
    expect((await h("/v1/auth/mfa/verify")).status).toBe(429);
    expect((await h("/v1/auth/mfa/enroll")).status).toBe(429);
    expect((await login(ip)).status).toBe(429);
  });

  test("can be tried again once the minute is over", async () => {
    const ip = from();
    for (let i = 0; i < 4; i++) await login(ip);
    expect((await login(ip)).status).toBe(429);
    now += 59_000;
    const still = await login(ip);
    expect(still.status).toBe(429);
    expect(still.headers["retry-after"]).toBe("1");
    expect(still.body.message).toBe("Too many requests. Try again in 1 second.");
    now += 1000;
    expect((await login(ip)).status).toBe(401);
  });
});

describe("every route", () => {
  test("is limited per address, including the public ones", async () => {
    const ip = from();
    for (let i = 0; i < 5; i++) expect((await notice(ip)).status).toBe(200);
    expect((await notice(ip)).status).toBe(429);
    expect((await notice(from())).status).toBe(200);
  });

  test("is limited before the key is looked up, so a flood of made-up keys never reaches the database", async () => {
    const ip = from();
    // Count the calls the app makes to the database, by wrapping the method on this one instance.
    const db = api.app.get(Database) as unknown as { inScope: (...args: unknown[]) => unknown };
    const original = db.inScope.bind(db);
    let lookups = 0;
    db.inScope = (...args) => {
      lookups++;
      return original(...args);
    };
    try {
      const bogus = () => api.http().get("/v1/notices").set("X-Forwarded-For", ip).set("Authorization", "Bearer sk_00000000000000000000000000000000_AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA");
      for (let i = 0; i < 5; i++) expect((await bogus()).status).toBe(401);
      const before = lookups;
      expect(before).toBeGreaterThanOrEqual(5);
      expect((await bogus()).status).toBe(429);
      expect(lookups).toBe(before);
    } finally {
      delete (db as { inScope?: unknown }).inScope;
    }
  });

  test("the health check is never limited, so a load balancer cannot take the instance out of service", async () => {
    const ip = from();
    for (let i = 0; i < 20; i++) expect((await api.http().get("/healthz").set("X-Forwarded-For", ip)).status).toBe(200);
  });

  test("a refusal can be read by a browser page: Retry-After is exposed to scripts", async () => {
    const ip = from();
    for (let i = 0; i < 5; i++) await notice(ip);
    const res = await api.http().get(`/v1/notices/${api.A.noticeId}`).set("X-Forwarded-For", ip).set("Origin", "https://shop.example.org");
    expect(res.status).toBe(429);
    expect(res.headers["access-control-expose-headers"]).toMatch(/Retry-After/i);
  });
});

describe("a key", () => {
  test("is limited however many addresses it is used from, and other keys are not affected", async () => {
    const use = (key: string) => api.http().post("/v1/consents").set("X-Forwarded-For", from()).set("Authorization", `Bearer ${key}`).send({});
    for (let i = 0; i < 4; i++) expect((await use(api.A.pk)).status).toBe(400);
    const res = await use(api.A.pk);
    expect(res.status).toBe(429);
    expect(res.body.error).toBe("rate_limited");
    expect((await use(api.B.pk)).status).toBe(400);
    expect((await use(api.A.server)).status).toBe(400);
  });

  test("starts again when the minute is over", async () => {
    const use = () => api.http().post("/v1/consents").set("X-Forwarded-For", from()).set("Authorization", `Bearer ${api.B.server}`).send({});
    for (let i = 0; i < 4; i++) await use();
    expect((await use()).status).toBe(429);
    now += 60_000;
    expect((await use()).status).toBe(400);
  });

  test("is not counted for a request that was refused because the key was wrong", async () => {
    const wrong = (ip: string) => api.http().post("/v1/consents").set("X-Forwarded-For", ip).set("Authorization", "Bearer sk_00000000000000000000000000000000_AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA").send({});
    for (let i = 0; i < 6; i++) expect((await wrong(from())).status).toBe(401);
  });
});

describe("with no proxy in front", () => {
  let direct: Api;
  beforeAll(async () => {
    direct = await startApi({ limits: TIGHT });
  });
  afterAll(async () => {
    await direct.stop();
  });

  test("a caller cannot get around the limit by claiming to be another address", async () => {
    const hit = (claimed: string) => direct.http().get(`/v1/notices/${direct.A.noticeId}`).set("X-Forwarded-For", claimed);
    for (let i = 0; i < 5; i++) expect((await hit(`203.0.113.${String(i)}`)).status).toBe(200);
    expect((await hit("203.0.113.99")).status).toBe(429);
  });
});
