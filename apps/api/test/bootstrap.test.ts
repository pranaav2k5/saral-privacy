import { createApp } from "../src/bootstrap.js";

test("createApp registers SIGTERM and SIGINT handlers so containers stop gracefully", async () => {
  const sigterm = process.listenerCount("SIGTERM");
  const sigint = process.listenerCount("SIGINT");

  const app = await createApp();

  try {
    expect(process.listenerCount("SIGTERM")).toBeGreaterThan(sigterm);
    expect(process.listenerCount("SIGINT")).toBeGreaterThan(sigint);
  } finally {
    await app.close();
  }
});

test("createApp answers a browser preflight, so the SDK works against the real entry point and not only the test harness", async () => {
  const { default: request } = await import("supertest");
  const app = await createApp();
  try {
    await app.init();
    const res = await request(app.getHttpServer())
      .options("/v1/consents")
      .set("Origin", "https://shop.example.org")
      .set("Access-Control-Request-Method", "POST")
      .set("Access-Control-Request-Headers", "authorization,content-type");
    expect(res.status).toBe(204);
    expect(res.headers["access-control-allow-origin"]).toBe("https://shop.example.org");
    expect(res.headers["access-control-allow-credentials"]).toBeUndefined();
  } finally {
    await app.close();
  }
});
