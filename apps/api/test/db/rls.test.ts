import { TENANT_A, TENANT_B, asApp, connect, createTestDb, seed, uid, HEX, type TestDb } from "./helpers.js";

const TENANT_TABLES = ["tenant_principals", "privacy_notices", "consent_records", "consent_audit_log", "consent_receipts"];

let db: TestDb;

beforeAll(async () => {
  db = await createTestDb();
  await seed(db.owner);
});

afterAll(async () => {
  await db.drop();
});

describe("the application role", () => {
  test("is not a superuser and does not bypass row-level security (the trap that makes RLS tests pass for the wrong reason)", async () => {
    await asApp(db, TENANT_A, async (c) => {
      const who = await c.query("SELECT current_user AS u, session_user AS s");
      expect(who.rows[0].u).toBe("saral_app");
      const role = await c.query("SELECT rolsuper, rolbypassrls, rolcreatedb, rolcreaterole FROM pg_roles WHERE rolname = current_user");
      expect(role.rows[0]).toEqual({ rolsuper: false, rolbypassrls: false, rolcreatedb: false, rolcreaterole: false });
    });
  });

  test("owns no tables", async () => {
    const r = await db.owner.query(
      "SELECT count(*)::int AS n FROM pg_tables WHERE schemaname = 'public' AND tableowner = 'saral_app'",
    );
    expect(r.rows[0].n).toBe(0);
  });
});

describe("tenant isolation", () => {
  test.each(TENANT_TABLES)("%s: tenant A sees only its own rows", async (table) => {
    await asApp(db, TENANT_A, async (c) => {
      const mine = await c.query(`SELECT count(*)::int AS n FROM ${table}`);
      expect(mine.rows[0].n).toBe(1);
      const theirs = await c.query(`SELECT count(*)::int AS n FROM ${table} WHERE tenant_id = $1`, [TENANT_B]);
      expect(theirs.rows[0].n).toBe(0);
    });
  });

  test("tenants: a tenant sees only its own row", async () => {
    await asApp(db, TENANT_B, async (c) => {
      const r = await c.query("SELECT id FROM tenants");
      expect(r.rows.map((x: { id: string }) => x.id)).toEqual([TENANT_B]);
    });
  });

  test.each([undefined, null])("with app.tenant_id %p the role sees no rows and gets no error", async (setting) => {
    await asApp(db, setting, async (c) => {
      for (const table of [...TENANT_TABLES, "tenants"]) {
        const r = await c.query(`SELECT count(*)::int AS n FROM ${table}`);
        expect(r.rows[0].n).toBe(0);
      }
    });
  });

  test("a malformed app.tenant_id fails closed with an error, never with rows", async () => {
    await expect(
      asApp(db, "not-a-uuid", (c) => c.query("SELECT count(*) FROM consent_records")),
    ).rejects.toThrow(/invalid input syntax for type uuid/);
  });

  test("an insert for another tenant is refused by the row-level security policy", async () => {
    await expect(
      asApp(db, TENANT_A, (c) =>
        c.query(
          `INSERT INTO tenant_principals (tenant_id, id, pseudonym_hmac) VALUES ($1, $2, $3)`,
          [TENANT_B, uid("b", 9), HEX("9")],
        ),
      ),
    ).rejects.toThrow(/row-level security/);
  });

  test("an insert for its own tenant works", async () => {
    await asApp(db, TENANT_A, async (c) => {
      const r = await c.query(
        `INSERT INTO tenant_principals (tenant_id, id, pseudonym_hmac) VALUES ($1, $2, $3) RETURNING id`,
        [TENANT_A, uid("a", 9), HEX("9")],
      );
      expect(r.rowCount).toBe(1);
    });
  });

  test("moving a row to another tenant is refused", async () => {
    await expect(
      asApp(db, TENANT_A, (c) => c.query("UPDATE consent_records SET tenant_id = $1", [TENANT_B])),
    ).rejects.toThrow(/permission denied/);
  });

  test("withdrawing updates only the tenant's own consent; another tenant's row is untouched", async () => {
    await asApp(db, TENANT_A, async (c) => {
      const own = await c.query(
        "UPDATE consent_records SET status = 'withdrawn', withdrawn_at = now() WHERE id = $1",
        [uid("a", 3)],
      );
      expect(own.rowCount).toBe(1);
      const other = await c.query(
        "UPDATE consent_records SET status = 'withdrawn', withdrawn_at = now() WHERE id = $1",
        [uid("b", 3)],
      );
      expect(other.rowCount).toBe(0);
    });
    const b = await db.owner.query("SELECT status FROM consent_records WHERE id = $1", [uid("b", 3)]);
    expect(b.rows[0].status).toBe("granted");
  });

  test("every tenant-owned table has row-level security enabled and forced", async () => {
    const r = await db.owner.query(`
      SELECT c.relname, c.relrowsecurity, c.relforcerowsecurity
      FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
      WHERE n.nspname = 'public' AND c.relkind = 'r'
        AND (c.relname = 'tenants' OR EXISTS (
          SELECT 1 FROM pg_attribute a WHERE a.attrelid = c.oid AND a.attname = 'tenant_id' AND NOT a.attisdropped))
      ORDER BY c.relname`);
    const names = r.rows.map((x: { relname: string }) => x.relname);
    expect(names).toEqual(expect.arrayContaining([...TENANT_TABLES, "tenants"]));
    const unprotected = r.rows.filter((x: { relrowsecurity: boolean; relforcerowsecurity: boolean }) => !x.relrowsecurity || !x.relforcerowsecurity);
    expect(unprotected.map((x: { relname: string }) => x.relname)).toEqual([]);
  });

  test("every tenant-owned table has a policy that also checks writes", async () => {
    const r = await db.owner.query(
      "SELECT tablename, with_check IS NOT NULL AS checks_writes FROM pg_policies WHERE schemaname = 'public' AND tablename = ANY($1)",
      [[...TENANT_TABLES, "tenants"]],
    );
    expect(r.rowCount).toBe(TENANT_TABLES.length + 1);
    const noCheck = r.rows.filter((x: { checks_writes: boolean }) => !x.checks_writes).map((x: { tablename: string }) => x.tablename);
    // The tenants table is read-only for the application role, so it needs no WITH CHECK.
    expect(noCheck.filter((t: string) => t !== "tenants")).toEqual([]);
  });
});

describe("references cannot cross tenants", () => {
  test("a consent in tenant A cannot reference tenant B's notice, even for the owner (who bypasses RLS)", async () => {
    await expect(
      db.owner.query(
        `INSERT INTO consent_records (id, tenant_id, principal_id, notice_id, notice_sha256, purposes, status, granted_at, collection_method)
         VALUES ($1, $2, $3, $4, $5, '[]', 'granted', now(), 'web_sdk')`,
        [uid("a", 20), TENANT_A, uid("a", 1), uid("b", 2), HEX("3")],
      ),
    ).rejects.toThrow(/foreign key/);
  });

  test("a receipt in tenant A cannot reference tenant B's consent", async () => {
    await expect(
      db.owner.query(
        "INSERT INTO consent_receipts (id, tenant_id, consent_id, jwt, jwks_kid) VALUES ($1, $2, $3, 'a.b.c', 'k')",
        [uid("a", 21), TENANT_A, uid("b", 3)],
      ),
    ).rejects.toThrow(/foreign key/);
  });
});

describe("least privilege", () => {
  const denied: [string, string][] = [
    ["privacy_notices", "UPDATE"],
    ["privacy_notices", "DELETE"],
    ["consent_receipts", "UPDATE"],
    ["consent_receipts", "DELETE"],
    ["consent_records", "DELETE"],
    ["consent_audit_log", "UPDATE"],
    ["consent_audit_log", "DELETE"],
    ["consent_audit_log", "TRUNCATE"],
    ["tenants", "INSERT"],
    ["tenants", "UPDATE"],
    ["tenants", "DELETE"],
    ["schema_migrations", "SELECT"],
  ];
  test.each(denied)("%s: saral_app has no %s privilege", async (table, privilege) => {
    const r = await db.owner.query("SELECT has_table_privilege('saral_app', $1, $2) AS ok", [table, privilege]);
    expect(r.rows[0].ok).toBe(false);
  });

  test("saral_app has no privilege on the owner's migration bookkeeping", async () => {
    await expect(asApp(db, TENANT_A, (c) => c.query("SELECT * FROM schema_migrations"))).rejects.toThrow(/permission denied/);
  });

  test("a second connection sees committed data only through the policy too", async () => {
    const c = await connect(db);
    try {
      await c.query("SET ROLE saral_app");
      const r = await c.query("SELECT count(*)::int AS n FROM consent_records");
      expect(r.rows[0].n).toBe(0); // no tenant set on this session
    } finally {
      await c.end();
    }
  });
});
