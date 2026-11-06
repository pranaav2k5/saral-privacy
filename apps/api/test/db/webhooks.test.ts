import { TENANT_A, TENANT_B, asApp, connect, createTestDb, seed, uid, type TestDb } from "./helpers.js";

let db: TestDb;

beforeAll(async () => {
  db = await createTestDb();
  await seed(db.owner);
  for (const [tenant, family] of [[TENANT_A, "a"], [TENANT_B, "b"]] as const) {
    await db.owner.query(
      "INSERT INTO webhook_endpoints (id, tenant_id, url, events) VALUES ($1, $2, $3, '{consent.granted}')",
      [uid(family, 70), tenant, `https://hooks.${family}.example/saral`],
    );
    await db.owner.query(
      `INSERT INTO webhook_deliveries (id, tenant_id, endpoint_id, event_type, payload, next_attempt_at)
       VALUES ($1, $2, $3, 'consent.granted', '{"x":1}', now() - interval '1 minute')`,
      [uid(family, 71), tenant, uid(family, 70)],
    );
  }
});

afterAll(async () => {
  await db.drop();
});

/** Runs `fn` as the delivery worker role (no tenant), then rolls back. */
async function asWorker<T>(fn: (c: Awaited<ReturnType<typeof connect>>) => Promise<T>): Promise<T> {
  const c = await connect(db);
  try {
    await c.query("BEGIN");
    await c.query("SET LOCAL ROLE saral_worker");
    return await fn(c);
  } finally {
    await c.query("ROLLBACK").catch(() => undefined);
    await c.end();
  }
}

describe("webhook tables for the application role", () => {
  test.each(["webhook_endpoints", "webhook_deliveries"])("%s: a tenant sees only its own rows", async (table) => {
    await asApp(db, TENANT_A, async (c) => {
      expect((await c.query(`SELECT count(*)::int AS n FROM ${table}`)).rows[0].n).toBe(1);
      expect((await c.query(`SELECT count(*)::int AS n FROM ${table} WHERE tenant_id = $1`, [TENANT_B])).rows[0].n).toBe(0);
    });
    await asApp(db, undefined, async (c) => {
      expect((await c.query(`SELECT count(*)::int AS n FROM ${table}`)).rows[0].n).toBe(0);
    });
  });

  test("an insert for another tenant is refused", async () => {
    await expect(
      asApp(db, TENANT_A, (c) =>
        c.query("INSERT INTO webhook_endpoints (id, tenant_id, url, events) VALUES ($1, $2, 'https://x.example/h', '{consent.granted}')", [uid("b", 80), TENANT_B]),
      ),
    ).rejects.toThrow(/row-level security/);
  });

  test("the application role can queue deliveries but not change or remove them", async () => {
    await asApp(db, TENANT_A, async (c) => {
      const r = await c.query(
        "INSERT INTO webhook_deliveries (id, tenant_id, endpoint_id, event_type, payload) VALUES ($1, $2, $3, 'consent.withdrawn', '{}')",
        [uid("a", 81), TENANT_A, uid("a", 70)],
      );
      expect(r.rowCount).toBe(1);
    });
    for (const sql of ["UPDATE webhook_deliveries SET state = 'delivered'", "DELETE FROM webhook_deliveries"]) {
      await expect(asApp(db, TENANT_A, (c) => c.query(sql))).rejects.toThrow(/permission denied/);
    }
  });

  test("a delivery cannot point at another tenant's endpoint", async () => {
    await expect(
      db.owner.query(
        "INSERT INTO webhook_deliveries (id, tenant_id, endpoint_id, event_type, payload) VALUES ($1, $2, $3, 'consent.granted', '{}')",
        [uid("a", 82), TENANT_A, uid("b", 70)],
      ),
    ).rejects.toThrow(/foreign key/);
  });

  test.each([
    ["an http URL", "http://hooks.example/x", "{consent.granted}"],
    ["no events", "https://hooks.example/x", "{}"],
    ["an unknown event", "https://hooks.example/x", "{consent.exploded}"],
  ])("rejects %s", async (_n, url, events) => {
    await expect(
      db.owner.query("INSERT INTO webhook_endpoints (id, tenant_id, url, events) VALUES ($1, $2, $3, $4)", [uid("a", 83), TENANT_A, url, events]),
    ).rejects.toThrow(/check constraint/);
  });

  test("state and attempts are constrained", async () => {
    await expect(db.owner.query("UPDATE webhook_deliveries SET state = 'weird' WHERE id = $1", [uid("a", 71)])).rejects.toThrow(/check constraint/);
    await expect(db.owner.query("UPDATE webhook_deliveries SET attempts = 16 WHERE id = $1", [uid("a", 71)])).rejects.toThrow(/check constraint/);
  });
});

describe("the delivery worker role", () => {
  test("is not a superuser and does not bypass row-level security", async () => {
    await asWorker(async (c) => {
      const r = await c.query("SELECT rolsuper, rolbypassrls FROM pg_roles WHERE rolname = current_user");
      expect(r.rows[0]).toEqual({ rolsuper: false, rolbypassrls: false });
    });
  });

  test("sees due deliveries of every tenant, with their endpoints, and nothing else", async () => {
    await asWorker(async (c) => {
      const r = await c.query("SELECT d.tenant_id FROM webhook_deliveries d JOIN webhook_endpoints e ON e.id = d.endpoint_id ORDER BY 1");
      expect(r.rows.map((x: { tenant_id: string }) => x.tenant_id)).toEqual([TENANT_A, TENANT_B]);
    });
  });

  test.each(["consent_records", "tenant_principals", "consent_receipts", "consent_audit_log", "api_keys", "privacy_notices", "tenants"])(
    "cannot read %s",
    async (table) => {
      await expect(asWorker((c) => c.query(`SELECT * FROM ${table}`))).rejects.toThrow(/permission denied/);
    },
  );

  test("can record the outcome of an attempt, but cannot change what is delivered or where", async () => {
    await asWorker(async (c) => {
      const r = await c.query("UPDATE webhook_deliveries SET state = 'delivered', attempts = 1, last_status = 200, delivered_at = now() WHERE id = $1", [uid("a", 71)]);
      expect(r.rowCount).toBe(1);
    });
    for (const sql of ["UPDATE webhook_deliveries SET payload = '{}'", "UPDATE webhook_deliveries SET endpoint_id = endpoint_id", "UPDATE webhook_deliveries SET tenant_id = tenant_id", "UPDATE webhook_endpoints SET url = url"]) {
      await expect(asWorker((c) => c.query(sql))).rejects.toThrow(/permission denied/);
    }
  });

  test("cannot insert or delete deliveries", async () => {
    await expect(asWorker((c) => c.query("DELETE FROM webhook_deliveries"))).rejects.toThrow(/permission denied/);
    await expect(
      asWorker((c) => c.query("INSERT INTO webhook_deliveries (id, tenant_id, endpoint_id, event_type, payload) VALUES ($1, $2, $3, 'consent.granted', '{}')", [uid("a", 90), TENANT_A, uid("a", 70)])),
    ).rejects.toThrow(/permission denied/);
  });
});
