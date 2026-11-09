import { createHash } from "node:crypto";
import { TENANT_A, TENANT_B, asApp, createTestDb, seed, uid, type TestDb } from "./helpers.js";

let db: TestDb;
let n = 700;
beforeAll(async () => {
  db = await createTestDb();
  await seed(db.owner);
});
afterAll(async () => {
  await db.drop();
});

const sha = (t: string) => createHash("sha256").update(t, "utf8").digest("hex");
const DOC = JSON.stringify({ schema: "saral.ropa/1", activities: [] });
const insert = (tenant: string, version: number, json = DOC, hash = sha(json), note: string | null = null) => ["INSERT INTO ropa_versions (id, tenant_id, version, document_json, document_sha256, note, created_by) VALUES ($1, $2, $3, $4, $5, $6, 'staff:x')", [uid(tenant === TENANT_A ? "a" : "b", ++n), tenant, version, json, hash, note]] as [string, unknown[]];

describe("ropa_versions", () => {
  test("a tenant sees only its own versions; with no tenant set, none; another tenant's insert is refused", async () => {
    await db.owner.query(...insert(TENANT_A, 1));
    await db.owner.query(...insert(TENANT_B, 1));
    await asApp(db, TENANT_A, async (c) => {
      expect((await c.query("SELECT count(*)::int AS n FROM ropa_versions WHERE tenant_id = $1", [TENANT_B])).rows[0].n).toBe(0);
      expect((await c.query("SELECT count(*)::int AS n FROM ropa_versions")).rows[0].n).toBe(1);
    });
    await asApp(db, undefined, async (c) => expect((await c.query("SELECT count(*)::int AS n FROM ropa_versions")).rows[0].n).toBe(0));
    await expect(asApp(db, TENANT_A, (c) => c.query(...insert(TENANT_B, 2)))).rejects.toThrow(/row-level security/);
  });

  test("the application role can add and read a version, but never change or delete one", async () => {
    await asApp(db, TENANT_A, async (c) => expect((await c.query(...insert(TENANT_A, 2))).rowCount).toBe(1));
    for (const sql of ["UPDATE ropa_versions SET note = 'x'", "UPDATE ropa_versions SET document_json = '{}'", "DELETE FROM ropa_versions"]) {
      await expect(asApp(db, TENANT_A, (c) => c.query(sql))).rejects.toThrow(/permission denied/);
    }
  });

  test("a version number is used once per organisation, and the same number in another organisation is fine", async () => {
    await db.owner.query(...insert(TENANT_A, 2));
    await expect(db.owner.query(...insert(TENANT_A, 2))).rejects.toThrow(/unique|duplicate/);
    await db.owner.query(...insert(TENANT_B, 2));
  });

  test("the stored hash must be the hash of the stored text, so a version can be shown to be what was saved", async () => {
    await expect(db.owner.query(...insert(TENANT_A, 3, DOC, sha("something else")))).rejects.toThrow(/check constraint/);
    await expect(db.owner.query(...insert(TENANT_A, 3, DOC, "not-a-hash"))).rejects.toThrow(/check constraint/);
    await db.owner.query(...insert(TENANT_A, 3));
  });

  test.each([
    ["text that is not JSON", "not json"],
    ["JSON that is not an object", "[]"],
    ["a JSON string", '"x"'],
    ["a document over 256 KiB", JSON.stringify({ x: "y".repeat(262_200) })],
  ])("refuses %s", async (_n, text) => {
    await expect(db.owner.query(...insert(TENANT_A, 9, text))).rejects.toThrow(/check constraint|invalid input syntax/);
  });

  test("a version number below 1 and a note that is empty or over 500 characters are refused", async () => {
    await expect(db.owner.query(...insert(TENANT_A, 0))).rejects.toThrow(/check constraint/);
    await expect(db.owner.query(...insert(TENANT_A, 10, DOC, sha(DOC), " "))).rejects.toThrow(/check constraint/);
    await expect(db.owner.query(...insert(TENANT_A, 10, DOC, sha(DOC), "x".repeat(501)))).rejects.toThrow(/check constraint/);
    await db.owner.query(...insert(TENANT_A, 10, DOC, sha(DOC), "x".repeat(500)));
  });
});
