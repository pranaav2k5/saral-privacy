import { TENANT_A, TENANT_B, asApp, createTestDb, seed, uid, HEX, type TestDb } from "./helpers.js";

let db: TestDb;

beforeAll(async () => {
  db = await createTestDb();
  await seed(db.owner);
  for (const [tenant, family] of [[TENANT_A, "a"], [TENANT_B, "b"]] as const) {
    await db.owner.query(
      `INSERT INTO api_keys (id, tenant_id, kind, scopes, secret_hmac, name) VALUES ($1, $2, 'secret', '{tenant_admin,auditor}', $3, 'test key')`,
      [uid(family, 50), tenant, HEX("e")],
    );
  }
});

afterAll(async () => {
  await db.drop();
});

describe("api key lookup", () => {
  test("the role sees no keys unless it names one, and then only that key", async () => {
    await asApp(db, undefined, async (c) => {
      expect((await c.query("SELECT count(*)::int AS n FROM api_keys")).rows[0].n).toBe(0);
      await c.query("SELECT set_config('app.api_key_id', $1, true)", [uid("a", 50)]);
      const r = await c.query("SELECT id, tenant_id, scopes FROM api_keys");
      expect(r.rows).toEqual([{ id: uid("a", 50), tenant_id: TENANT_A, scopes: ["tenant_admin", "auditor"] }]);
    });
  });

  test("naming a key does not reveal the other tenant's keys", async () => {
    await asApp(db, TENANT_A, async (c) => {
      await c.query("SELECT set_config('app.api_key_id', $1, true)", [uid("a", 50)]);
      expect((await c.query("SELECT count(*)::int AS n FROM api_keys WHERE tenant_id = $1", [TENANT_B])).rows[0].n).toBe(0);
    });
  });

  test("the role cannot write keys", async () => {
    await expect(
      asApp(db, TENANT_A, (c) =>
        c.query(`INSERT INTO api_keys (id, tenant_id, kind, scopes, secret_hmac, name) VALUES ($1, $2, 'secret', '{auditor}', $3, 'x')`, [uid("a", 51), TENANT_A, HEX("e")]),
      ),
    ).rejects.toThrow(/permission denied/);
  });

  test("scopes are limited to the known set, and a publishable key can only have the sdk scope", async () => {
    const insert = (kind: string, scopes: string) =>
      db.owner.query(`INSERT INTO api_keys (id, tenant_id, kind, scopes, secret_hmac, name) VALUES ($1, $2, $3, $4, $5, 'x')`, [uid("a", 60), TENANT_A, kind, scopes, HEX("e")]);
    await expect(insert("secret", "{root}")).rejects.toThrow(/check constraint/);
    await expect(insert("secret", "{}")).rejects.toThrow(/check constraint/);
    await expect(insert("publishable", "{tenant_admin}")).rejects.toThrow(/check constraint/);
    await expect(insert("publishable", "{sdk}")).resolves.toBeDefined();
  });
});

describe("public notices", () => {
  test("a notice can be read by naming its id without a tenant, and only that notice", async () => {
    await asApp(db, undefined, async (c) => {
      expect((await c.query("SELECT count(*)::int AS n FROM privacy_notices")).rows[0].n).toBe(0);
      await c.query("SELECT set_config('app.public_notice_id', $1, true)", [uid("b", 2)]);
      const r = await c.query("SELECT id, tenant_id FROM privacy_notices");
      expect(r.rows).toEqual([{ id: uid("b", 2), tenant_id: TENANT_B }]);
    });
  });
});

describe("tenant profile and purpose definitions", () => {
  test("default to empty and are read-only for the application role", async () => {
    await asApp(db, TENANT_A, async (c) => {
      expect((await c.query("SELECT profile FROM tenants")).rows[0].profile).toEqual({});
      expect((await c.query("SELECT purpose_definitions FROM privacy_notices")).rows[0].purpose_definitions).toEqual([]);
    });
    await expect(asApp(db, TENANT_A, (c) => c.query("UPDATE tenants SET profile = '{}'"))).rejects.toThrow(/permission denied/);
  });
});
