import { WebhookRunner } from "./runner.js";
import type { WebhookWorker } from "./worker.js";

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

function fakeWorker(run: () => Promise<unknown>) {
  const calls: number[] = [];
  return { worker: { runOnce: async () => (calls.push(Date.now()), run()) } as unknown as WebhookWorker, calls };
}

describe("WebhookRunner", () => {
  test("does nothing unless it is switched on", async () => {
    const { worker, calls } = fakeWorker(async () => undefined);
    const runner = new WebhookRunner(worker);
    runner.enabled = false;
    runner.intervalMs = 5;
    runner.onApplicationBootstrap();
    await sleep(40);
    runner.onModuleDestroy();
    expect(calls).toHaveLength(0);
  });

  test("polls on its interval when on, and stops when destroyed", async () => {
    const { worker, calls } = fakeWorker(async () => undefined);
    const runner = new WebhookRunner(worker);
    runner.enabled = true;
    runner.intervalMs = 10;
    runner.onApplicationBootstrap();
    await sleep(80);
    runner.onModuleDestroy();
    const n = calls.length;
    expect(n).toBeGreaterThanOrEqual(3);
    await sleep(40);
    expect(calls).toHaveLength(n);
  });

  test("a slow poll is never overlapped by the next one", async () => {
    let active = 0;
    let maxActive = 0;
    const { worker } = fakeWorker(async () => {
      active++;
      maxActive = Math.max(maxActive, active);
      await sleep(40);
      active--;
    });
    const runner = new WebhookRunner(worker);
    runner.enabled = true;
    runner.intervalMs = 5;
    runner.onApplicationBootstrap();
    await sleep(120);
    runner.onModuleDestroy();
    await sleep(60);
    expect(maxActive).toBe(1);
  });

  test("an error in a poll is logged and does not stop later polls", async () => {
    const logged: unknown[][] = [];
    const original = console.error;
    console.error = (...args: unknown[]) => void logged.push(args);
    let n = 0;
    const { worker, calls } = fakeWorker(async () => {
      if (++n === 1) throw new Error("database is down");
    });
    const runner = new WebhookRunner(worker);
    await runner.tick();
    await runner.tick();
    expect(calls).toHaveLength(2);
    console.error = original;
    expect(logged).toEqual([["webhook worker:", "database is down"]]);
  });
});
