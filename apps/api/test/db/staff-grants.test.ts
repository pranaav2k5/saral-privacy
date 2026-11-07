import { TENANT_A, asApp, createTestDb, seed, type TestDb } from "./helpers.js";

let db: TestDb;
const STAFF = "cccccccc-cccc-4ccc-8ccc-cccccccccccc";
// A hash with the pinned shape. Nothing here checks a password, only what the application role may write.
const HASH = (c: string) => `scrypt$32768$8$1$${"a".repeat(22)}$${c.repeat(86)}`;

beforeAll(async () => {
  db = await createTestDb();
  await seed(db.owner);
  await db.owner.query(
    `INSERT INTO staff_users (id, tenant_id, email_blind, email_sealed, role, password_hash) VALUES ($1, $2, $3, $4, 'dpo', $5)`,
    [STAFF, TENANT_A, "e".repeat(64), Buffer.alloc(40, 1), HASH("b")],
  );
});

afterAll(async () => {
  await db.drop();
});

describe("what the application role may change about a staff account", () => {
  test("the password hash and the session version, so a person can change their own password and sign out everywhere else", async () => {
    const r = await asApp(db, TENANT_A, async (c) => {
      await c.query("UPDATE staff_users SET password_hash = $2, session_version = session_version + 1 WHERE id = $1", [STAFF, HASH("c")]);
      return (await c.query("SELECT password_hash, session_version FROM staff_users WHERE id = $1", [STAFF])).rows[0];
    });
    expect(r).toEqual({ password_hash: HASH("c"), session_version: 2 });
  });

  test("and the flag that says the password must be changed, because changing the password clears it", async () => {
    await db.owner.query("UPDATE staff_users SET must_change_password = true WHERE id = $1", [STAFF]);
    const r = await asApp(db, TENANT_A, async (c) => {
      await c.query("UPDATE staff_users SET must_change_password = false WHERE id = $1", [STAFF]);
      return (await c.query("SELECT must_change_password FROM staff_users WHERE id = $1", [STAFF])).rows[0];
    });
    expect(r).toEqual({ must_change_password: false });
  });

  test("an account starts without the flag unless the operator sets it", async () => {
    const r = await db.owner.query("SELECT column_default, is_nullable FROM information_schema.columns WHERE table_name = 'staff_users' AND column_name = 'must_change_password'");
    expect(r.rows[0]).toEqual({ column_default: "false", is_nullable: "NO" });
  });

  test.each([
    ["role", "role = 'tenant_admin'"],
    ["email_blind", `email_blind = '${"f".repeat(64)}'`],
    ["email_sealed", "email_sealed = '\\x00'::bytea"],
    ["disabled_at", "disabled_at = NULL"],
    ["tenant_id", "tenant_id = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb'"],
    ["id", "id = 'dddddddd-dddd-4ddd-8ddd-dddddddddddd'"],
  ])("but not %s, so a person cannot make themselves an administrator, change who they are, or re-enable themselves", async (_n, set) => {
    await expect(asApp(db, TENANT_A, (c) => c.query(`UPDATE staff_users SET ${set} WHERE id = $1`, [STAFF]))).rejects.toThrow(/permission denied/);
  });

  test("and a password hash that is not in the pinned shape is still refused by the database", async () => {
    await expect(asApp(db, TENANT_A, (c) => c.query("UPDATE staff_users SET password_hash = 'plaintext' WHERE id = $1", [STAFF]))).rejects.toThrow(/violates check constraint/);
  });
});
