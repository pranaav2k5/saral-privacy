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
