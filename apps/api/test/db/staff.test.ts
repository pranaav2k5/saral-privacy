import { TENANT_A, TENANT_B, asApp, createTestDb, seed, uid, HEX, type TestDb } from "./helpers.js";

let db: TestDb;
const HASH = `scrypt$32768$8$1$${"a".repeat(22)}$${"b".repeat(86)}`;
const SEALED = Buffer.alloc(40, 3);

beforeAll(async () => {
  db = await createTestDb();
  await seed(db.owner);
  for (const [tenant, family] of [[TENANT_A, "a"], [TENANT_B, "b"]] as const) {
    await db.owner.query(
      "INSERT INTO staff_users (id, tenant_id, email_blind, email_sealed, role, password_hash) VALUES ($1, $2, $3, $4, 'dpo', $5)",
      [uid(family, 400), tenant, HEX("c"), SEALED, HASH],
    );
  }
});

afterAll(async () => {
  await db.drop();
});

describe("staff_users", () => {
  test("a tenant sees only its own staff; with no tenant set, none", async () => {
    await asApp(db, TENANT_A, async (c) => {
      const r = await c.query("SELECT id FROM staff_users");
      expect(r.rows.map((x: { id: string }) => x.id)).toEqual([uid("a", 400)]);
    });
    await asApp(db, undefined, async (c) => {
      expect((await c.query("SELECT count(*)::int AS n FROM staff_users")).rows[0].n).toBe(0);
    });
  });

  test("the application role cannot create, delete or change who a person is, their role, or their password", async () => {
    await expect(asApp(db, TENANT_A, (c) => c.query("INSERT INTO staff_users (id, tenant_id, email_blind, email_sealed, role, password_hash) VALUES ($1, $2, $3, $4, 'dpo', $5)", [uid("a", 401), TENANT_A, HEX("d"), SEALED, HASH]))).rejects.toThrow(/permission denied/);
    await expect(asApp(db, TENANT_A, (c) => c.query("DELETE FROM staff_users"))).rejects.toThrow(/permission denied/);
    for (const col of ["role = 'tenant_admin'", `password_hash = '${HASH}'`, "session_version = 9", "disabled_at = now()", `email_blind = '${HEX("e")}'`]) {
      await expect(asApp(db, TENANT_A, (c) => c.query(`UPDATE staff_users SET ${col}`))).rejects.toThrow(/permission denied/);
    }
  });

  test("it may record sign-in progress: the code secret, its confirmation, the last accepted step, failures and a lock", async () => {
    await asApp(db, TENANT_A, async (c) => {
      const r = await c.query("UPDATE staff_users SET totp_secret_sealed = $1, totp_confirmed_at = now(), last_totp_step = 5, failed_attempts = 2, locked_until = now() + interval '15 minutes'", [Buffer.alloc(60, 4)]);
      expect(r.rowCount).toBe(1);
    });
    expect((await db.owner.query("SELECT failed_attempts FROM staff_users WHERE id = $1", [uid("b", 400)])).rows[0].failed_attempts).toBe(0); // the other tenant is untouched
  });

  test.each([
    ["an unknown role", "role", "'owner'"],
    ["a password hash that is not scrypt with the pinned parameters", "password_hash", "'scrypt$1024$8$1$aaaaaaaaaaaaaaaaaaaaaa$bbbb'"],
    ["a malformed email index", "email_blind", "'xyz'"],
    ["a negative failure count", "failed_attempts", "-1"],
    ["a session version below 1", "session_version", "0"],
  ])("rejects %s", async (_n, col, val) => {
    await expect(db.owner.query(`UPDATE staff_users SET ${col} = ${val} WHERE id = $1`, [uid("b", 400)])).rejects.toThrow(/check constraint/);
  });

  test("a confirmed code needs a secret", async () => {
    await expect(db.owner.query("UPDATE staff_users SET totp_confirmed_at = now(), totp_secret_sealed = NULL WHERE id = $1", [uid("b", 400)])).rejects.toThrow(/check constraint/);
  });

  test("an email is unique within a tenant but may exist in another", async () => {
    await expect(db.owner.query("INSERT INTO staff_users (id, tenant_id, email_blind, email_sealed, role, password_hash) VALUES ($1, $2, $3, $4, 'dpo', $5)", [uid("a", 402), TENANT_A, HEX("c"), SEALED, HASH])).rejects.toThrow(/unique|duplicate/);
    await expect(db.owner.query("INSERT INTO staff_users (id, tenant_id, email_blind, email_sealed, role, password_hash) VALUES ($1, $2, $3, $4, 'dpo', $5)", [uid("b", 402), TENANT_B, HEX("f"), SEALED, HASH])).resolves.toBeDefined();
  });
});

describe("finding a tenant by its slug at sign-in", () => {
  test("naming a slug shows that one tenant and nothing else, before any tenant is set", async () => {
    await asApp(db, undefined, async (c) => {
      expect((await c.query("SELECT count(*)::int AS n FROM tenants")).rows[0].n).toBe(0);
      await c.query("SELECT set_config('app.tenant_slug', 'tenant-b', true)");
      const r = await c.query("SELECT id, slug FROM tenants");
      expect(r.rows).toEqual([{ id: TENANT_B, slug: "tenant-b" }]);
    });
  });
});

describe("staff_recovery_codes", () => {
  test("isolated by tenant; one-time use is recorded by setting used_at; nothing else may change; codes are unique per person", async () => {
    await db.owner.query("INSERT INTO staff_recovery_codes (tenant_id, staff_id, code_hash) VALUES ($1, $2, $3), ($4, $5, $3)", [TENANT_A, uid("a", 400), HEX("1"), TENANT_B, uid("b", 400)]);
    await asApp(db, TENANT_A, async (c) => {
      expect((await c.query("SELECT count(*)::int AS n FROM staff_recovery_codes")).rows[0].n).toBe(1);
      expect((await c.query("UPDATE staff_recovery_codes SET used_at = now()")).rowCount).toBe(1);
    });
    await expect(asApp(db, TENANT_A, (c) => c.query("UPDATE staff_recovery_codes SET code_hash = $1", [HEX("2")]))).rejects.toThrow(/permission denied/);
    await expect(db.owner.query("INSERT INTO staff_recovery_codes (tenant_id, staff_id, code_hash) VALUES ($1, $2, $3)", [TENANT_A, uid("a", 400), HEX("1")])).rejects.toThrow(/unique|duplicate/);
    await expect(db.owner.query("INSERT INTO staff_recovery_codes (tenant_id, staff_id, code_hash) VALUES ($1, $2, $3)", [TENANT_A, uid("b", 400), HEX("3")])).rejects.toThrow(/foreign key/);
  });
});
