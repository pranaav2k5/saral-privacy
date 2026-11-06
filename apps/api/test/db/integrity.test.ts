import { TENANT_A, TENANT_B, NOTICE_TEXT, asApp, createTestDb, seed, sha256, uid, HEX, type TestDb } from "./helpers.js";

let db: TestDb;

beforeAll(async () => {
  db = await createTestDb();
  await seed(db.owner);
});

afterAll(async () => {
  await db.drop();
});

let counter = 100;

/** A fresh granted consent (inserted by the owner), so no test depends on another's changes. */
async function freshConsent(family: "a" | "b"): Promise<string> {
  const id = uid(family, ++counter);
  await db.owner.query(
    `INSERT INTO consent_records (id, tenant_id, principal_id, notice_id, notice_sha256, purposes, status, granted_at, collection_method)
     VALUES ($1, $2, $3, $4, $5, '[]', 'granted', now(), 'web_sdk')`,
    [id, family === "a" ? TENANT_A : TENANT_B, uid(family, 1), uid(family, 2), sha256(NOTICE_TEXT)],
  );
  return id;
}

describe("a consent can only finish, never come back", () => {
  const asA = (sql: string, id: string) => asApp(db, TENANT_A, (c) => c.query(sql, [id]));

  test("granted can become withdrawn, with a withdrawal time", async () => {
    const r = await asA("UPDATE consent_records SET status = 'withdrawn', withdrawn_at = now() WHERE id = $1", await freshConsent("a"));
    expect(r.rowCount).toBe(1);
  });

  test("granted can become expired", async () => {
    const r = await asA("UPDATE consent_records SET status = 'expired' WHERE id = $1", await freshConsent("a"));
    expect(r.rowCount).toBe(1);
  });

  test("granted cannot be updated to granted again", async () => {
    await expect(asA("UPDATE consent_records SET status = 'granted' WHERE id = $1", await freshConsent("a"))).rejects.toThrow(
      /only move from granted/,
    );
  });

  test("a withdrawn consent cannot be granted again, expired, or have its withdrawal time cleared or moved", async () => {
    const id = await freshConsent("b");
    await db.owner.query("UPDATE consent_records SET status = 'withdrawn', withdrawn_at = '2026-11-06T10:00:00Z' WHERE id = $1", [id]);
    const run = (sql: string) => asApp(db, TENANT_B, (c) => c.query(sql, [id]));
    await expect(run("UPDATE consent_records SET status = 'granted', withdrawn_at = NULL WHERE id = $1")).rejects.toThrow(/cannot change/);
    await expect(run("UPDATE consent_records SET status = 'expired', withdrawn_at = NULL WHERE id = $1")).rejects.toThrow(/cannot change/);
    await expect(run("UPDATE consent_records SET withdrawn_at = now() WHERE id = $1")).rejects.toThrow(/cannot change/);
  });

  test("the owner is held to the same rule", async () => {
    const id = await freshConsent("b");
    await db.owner.query("UPDATE consent_records SET status = 'withdrawn', withdrawn_at = now() WHERE id = $1", [id]);
    await expect(
      db.owner.query("UPDATE consent_records SET status = 'granted', withdrawn_at = NULL WHERE id = $1", [id]),
    ).rejects.toThrow(/cannot change/);
  });

  test("no other column changes while a consent finishes", async () => {
    const id = await freshConsent("a");
    await expect(
      db.owner.query("UPDATE consent_records SET status = 'withdrawn', withdrawn_at = now(), purposes = '[{}]' WHERE id = $1", [id]),
    ).rejects.toThrow(/only status and withdrawn_at/);
  });
});

describe("a consent is bound to the exact notice text", () => {
  test("a notice's hash must be the SHA-256 of its stored text", async () => {
    await expect(
      db.owner.query(
        "INSERT INTO privacy_notices (id, tenant_id, version, language, canonical_text, canonical_sha256) VALUES ($1, $2, 2, 'en', 'other text', $3)",
        [uid("a", 30), TENANT_A, sha256(NOTICE_TEXT)],
      ),
    ).rejects.toThrow(/check constraint/);
    await expect(
      db.owner.query(
        "INSERT INTO privacy_notices (id, tenant_id, version, language, canonical_text, canonical_sha256) VALUES ($1, $2, 2, 'en', 'other text', $3)",
        [uid("a", 30), TENANT_A, sha256("other text")],
      ),
    ).resolves.toBeDefined();
  });

  test("a consent whose notice_sha256 differs from the notice's hash is refused, even for the owner", async () => {
    await expect(
      db.owner.query(
        `INSERT INTO consent_records (id, tenant_id, principal_id, notice_id, notice_sha256, purposes, status, granted_at, collection_method)
         VALUES ($1, $2, $3, $4, $5, '[]', 'granted', now(), 'web_sdk')`,
        [uid("a", 31), TENANT_A, uid("a", 1), uid("a", 2), HEX("9")],
      ),
    ).rejects.toThrow(/foreign key/);
  });

  test("a consent with the notice's real hash is accepted", async () => {
    await expect(
      asApp(db, TENANT_A, (c) =>
        c.query(
          `INSERT INTO consent_records (id, tenant_id, principal_id, notice_id, notice_sha256, purposes, status, granted_at, collection_method)
           VALUES ($1, $2, $3, $4, $5, '[]', 'granted', now(), 'web_sdk')`,
          [uid("a", 32), TENANT_A, uid("a", 1), uid("a", 2), sha256(NOTICE_TEXT)],
        ),
      ),
    ).resolves.toBeDefined();
  });
});

describe("functions cannot be hijacked through the search path", () => {
  test("every function in the public schema pins its search_path with pg_temp last", async () => {
    const r = await db.owner.query(`
      SELECT p.proname, p.proconfig FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
      WHERE n.nspname = 'public' AND p.prokind = 'f' ORDER BY p.proname`);
    expect(r.rows.map((x: { proname: string }) => x.proname)).toEqual(
      expect.arrayContaining(["audit_append_lock", "audit_append_only", "audit_chain_link", "consent_records_guard", "current_tenant_id"]),
    );
    for (const f of r.rows as { proname: string; proconfig: string[] | null }[]) {
      expect({ fn: f.proname, config: f.proconfig }).toEqual({ fn: f.proname, config: ["search_path=pg_catalog, public, pg_temp"] });
    }
  });

  test("the application role cannot create temporary tables to shadow the audit table", async () => {
    await expect(
      asApp(db, TENANT_A, (c) => c.query("CREATE TEMP TABLE consent_audit_log (tenant_id uuid, seq_no bigint, entry_hash text)")),
    ).rejects.toThrow(/permission denied to create temporary tables/);
  });
});
