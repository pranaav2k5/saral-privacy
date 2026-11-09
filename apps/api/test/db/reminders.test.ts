import { randomUUID } from "node:crypto";
import { TENANT_A, TENANT_B, asApp, createTestDb, seed, uid, type TestDb } from "./helpers.js";

let db: TestDb;
beforeAll(async () => {
  db = await createTestDb();
  await seed(db.owner);
});
afterAll(async () => {
  await db.drop();
});

const row = (tenant: string, kind: string, stage: string, ref = randomUUID()) =>
  ["INSERT INTO reminders_sent (tenant_id, kind, ref_id, stage) VALUES ($1, $2, $3, $4)", [tenant, kind, ref, stage]] as [string, unknown[]];

describe("reminders_sent", () => {
  test("a tenant sees only its own rows; with no tenant set, none; another tenant's insert is refused", async () => {
    await db.owner.query(...row(TENANT_A, "breach", "soon"));
    await db.owner.query(...row(TENANT_B, "breach", "soon"));
    await asApp(db, TENANT_A, async (c) => {
      expect((await c.query("SELECT count(*)::int AS n FROM reminders_sent")).rows[0].n).toBe(1);
      expect((await c.query("SELECT count(*)::int AS n FROM reminders_sent WHERE tenant_id = $1", [TENANT_B])).rows[0].n).toBe(0);
    });
    await asApp(db, undefined, async (c) => expect((await c.query("SELECT count(*)::int AS n FROM reminders_sent")).rows[0].n).toBe(0));
    await expect(asApp(db, TENANT_A, (c) => c.query(...row(TENANT_B, "breach", "passed")))).rejects.toThrow(/row-level security/);
  });

  test("the application role can add and read a row, but never change or delete one", async () => {
    await asApp(db, TENANT_A, async (c) => expect((await c.query(...row(TENANT_A, "ropa", "overdue"))).rowCount).toBe(1));
    for (const sql of ["UPDATE reminders_sent SET stage = 'soon'", "UPDATE reminders_sent SET sent_at = now()", "DELETE FROM reminders_sent", "TRUNCATE reminders_sent"]) {
      await expect(asApp(db, TENANT_A, (c) => c.query(sql))).rejects.toThrow(/permission denied/);
    }
  });

  test("a reminder is recorded once for a thing and a stage, whoever asks twice, and each stage and thing is separate", async () => {
    const ref = randomUUID();
    await db.owner.query(...row(TENANT_A, "breach", "soon", ref));
    await expect(db.owner.query(...row(TENANT_A, "breach", "soon", ref))).rejects.toThrow(/unique|duplicate/);
    await db.owner.query(...row(TENANT_A, "breach", "passed", ref));
    await db.owner.query(...row(TENANT_A, "breach", "soon", randomUUID()));
    await db.owner.query(...row(TENANT_B, "breach", "soon", ref));
  });

  test.each([
    ["an unknown kind", "invoice", "soon"],
    ["a stage that a breach does not have", "breach", "overdue"],
    ["a stage that a record does not have", "ropa", "passed"],
    ["an unknown stage", "breach", "later"],
  ])("refuses %s", async (_n, kind, stage) => {
    await expect(db.owner.query(...row(TENANT_A, kind, stage))).rejects.toThrow(/check constraint/);
  });

  test("has a time it was sent, which the database sets", async () => {
    await asApp(db, TENANT_A, async (c) => {
      const r = await c.query("INSERT INTO reminders_sent (tenant_id, kind, ref_id, stage) VALUES ($1, 'ropa', $2, 'soon') RETURNING sent_at", [TENANT_A, randomUUID()]);
      expect(Math.abs(Date.now() - (r.rows[0].sent_at as Date).getTime())).toBeLessThan(60_000);
    });
  });
});

describe("the events a webhook endpoint may ask for", () => {
  const endpoint = (tenant: string, n: number, events: string[]) => db.owner.query("INSERT INTO webhook_endpoints (id, tenant_id, url, events) VALUES ($1, $2, $3, $4)", [uid("e", n), tenant, `https://hooks.example/${String(n)}`, events]);

  test("include the four reminders", async () => {
    await endpoint(TENANT_A, 1, ["breach.deadline_soon", "breach.deadline_passed", "ropa.review_soon", "ropa.review_overdue"]);
  });

  test("still refuse an event that does not exist, and an empty list", async () => {
    await expect(endpoint(TENANT_A, 2, ["breach.exploded"])).rejects.toThrow(/check constraint/);
    await expect(endpoint(TENANT_A, 3, ["consent.granted", "ropa.review_never"])).rejects.toThrow(/check constraint/);
    await expect(endpoint(TENANT_A, 4, [])).rejects.toThrow(/check constraint/);
  });

  test("the queue accepts a delivery of each reminder and refuses an unknown one", async () => {
    await endpoint(TENANT_A, 5, ["consent.granted"]);
    const queue = (type: string) => db.owner.query("INSERT INTO webhook_deliveries (id, tenant_id, endpoint_id, event_type, payload) VALUES ($1, $2, $3, $4, '{}')", [randomUUID(), TENANT_A, uid("e", 5), type]);
    for (const t of ["breach.deadline_soon", "breach.deadline_passed", "ropa.review_soon", "ropa.review_overdue"]) await queue(t);
    await expect(queue("breach.exploded")).rejects.toThrow(/check constraint/);
  });
});
