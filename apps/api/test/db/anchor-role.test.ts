import { TENANT_A, TENANT_B, connect, createTestDb, seed, type TestDb } from "./helpers.js";

let db: TestDb;
beforeAll(async () => {
  db = await createTestDb();
  await seed(db.owner);
});
afterAll(async () => {
  await db.drop();
});

/** Runs `fn` as the anchor role (no tenant), then rolls back. */
async function asAnchor<T>(fn: (c: Awaited<ReturnType<typeof connect>>) => Promise<T>): Promise<T> {
  const c = await connect(db);
  try {
    await c.query("BEGIN");
    await c.query("SET LOCAL ROLE saral_anchor");
    return await fn(c);
  } finally {
    await c.query("ROLLBACK").catch(() => undefined);
    await c.end();
  }
}

describe("the anchor role, which lists the organisations the nightly job must anchor", () => {
  test("is not a superuser and does not bypass row-level security", async () => {
    await asAnchor(async (c) => {
      const r = await c.query("SELECT rolsuper, rolbypassrls, rolcanlogin FROM pg_roles WHERE rolname = current_user");
      expect(r.rows[0]).toEqual({ rolsuper: false, rolbypassrls: false, rolcanlogin: false });
    });
  });

  test("sees the id of every organisation, and nothing about them", async () => {
    await asAnchor(async (c) => {
      const r = await c.query("SELECT id FROM tenants ORDER BY id");
      expect(r.rows.map((x: { id: string }) => x.id)).toEqual([TENANT_A, TENANT_B]);
    });
    for (const column of ["name", "slug", "profile", "created_at"]) {
      await expect(asAnchor((c) => c.query(`SELECT ${column} FROM tenants`))).rejects.toThrow(/permission denied|does not exist/);
    }
    await expect(asAnchor((c) => c.query("SELECT * FROM tenants"))).rejects.toThrow(/permission denied/);
  });

  test.each(["consent_records", "tenant_principals", "consent_receipts", "consent_audit_log", "api_keys", "privacy_notices", "webhook_endpoints", "webhook_deliveries", "staff_users", "dsr_requests"])(
    "cannot read %s",
    async (table) => {
      await expect(asAnchor((c) => c.query(`SELECT * FROM ${table}`))).rejects.toThrow(/permission denied/);
    },
  );

  test("cannot change or add organisations", async () => {
    await expect(asAnchor((c) => c.query("UPDATE tenants SET id = id"))).rejects.toThrow(/permission denied/);
    await expect(asAnchor((c) => c.query("DELETE FROM tenants"))).rejects.toThrow(/permission denied/);
    await expect(asAnchor((c) => c.query("INSERT INTO tenants (id) VALUES (gen_random_uuid())"))).rejects.toThrow(/permission denied/);
  });

  test("the application role still sees only its own organisation", async () => {
    const c = await connect(db);
    try {
      await c.query("BEGIN");
      await c.query("SET LOCAL ROLE saral_app");
      await c.query("SELECT set_config('app.tenant_id', $1, true)", [TENANT_A]);
      expect((await c.query("SELECT id FROM tenants")).rows).toEqual([{ id: TENANT_A }]);
    } finally {
      await c.query("ROLLBACK").catch(() => undefined);
      await c.end();
    }
  });
});
