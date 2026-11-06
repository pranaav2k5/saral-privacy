import { Database } from "./database.js";
import { createTestDb, type TestDb } from "../../test/db/helpers.js";

let db: TestDb;

beforeAll(async () => {
  db = await createTestDb();
});

afterAll(async () => {
  await db.drop();
});

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

describe("Database", () => {
  test("a connection that the server drops while idle does not crash the process, and the next request works", async () => {
    const database = new Database({ databaseUrl: db.url, nodeEnv: "test", devMasterSecret: undefined });
    const logged: unknown[][] = [];
    const original = console.error;
    console.error = (...args: unknown[]) => void logged.push(args);
    try {
      await database.inScope({}, (c) => c.query("SELECT 1"));
      // An RDS failover, a proxy idle timeout or an operator kills the idle pooled connection.
      await db.owner.query("SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname = current_database() AND pid <> pg_backend_pid()");
      await sleep(300);
      const r = await database.inScope({}, (c) => c.query("SELECT 2 AS n"));
      expect(r.rows[0].n).toBe(2);
    } finally {
      console.error = original;
      await database.onModuleDestroy();
    }
    expect(logged.some((l) => String(l[0]).includes("database pool"))).toBe(true);
  });

  test("a request waits at most a few seconds for a free connection instead of forever", async () => {
    const database = new Database({ databaseUrl: db.url, nodeEnv: "test", devMasterSecret: undefined });
    try {
      const pool = (database as unknown as { getPool(): { options: { connectionTimeoutMillis?: number; statement_timeout?: number } } }).getPool();
      expect(pool.options.connectionTimeoutMillis).toBeGreaterThan(0);
      expect(pool.options.connectionTimeoutMillis).toBeLessThanOrEqual(10_000);
      expect(pool.options.statement_timeout).toBeGreaterThan(0);
    } finally {
      await database.onModuleDestroy();
    }
  });
});
