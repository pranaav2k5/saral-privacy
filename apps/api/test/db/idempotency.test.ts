import { TENANT_A, TENANT_B, NOTICE_TEXT, createTestDb, seed, sha256, uid, type TestDb } from "./helpers.js";

let db: TestDb;

beforeAll(async () => {
  db = await createTestDb();
  await seed(db.owner);
});

afterAll(async () => {
  await db.drop();
});

const insert = (tenant: string, family: string, id: number, key: string | null) =>
  db.owner.query(
    `INSERT INTO consent_records (id, tenant_id, principal_id, notice_id, notice_sha256, purposes, status, granted_at, collection_method, idempotency_key)
     VALUES ($1, $2, $3, $4, $5, '[]', 'granted', now(), 'web_sdk', $6)`,
    [uid(family, id), tenant, uid(family, 1), uid(family, 2), sha256(NOTICE_TEXT), key],
  );

describe("consent idempotency keys", () => {
  test("a key is unique within a tenant, but the same key may be used by another tenant, and many consents may have none", async () => {
    await insert(TENANT_A, "a", 200, "retry-key-0001");
    await expect(insert(TENANT_A, "a", 201, "retry-key-0001")).rejects.toThrow(/unique|duplicate/);
    await expect(insert(TENANT_B, "b", 200, "retry-key-0001")).resolves.toBeDefined();
    await expect(insert(TENANT_A, "a", 202, null)).resolves.toBeDefined();
    await expect(insert(TENANT_A, "a", 203, null)).resolves.toBeDefined();
  });

  test.each(["short", "has space in it", "bad/char/here", "x".repeat(129), ""])("rejects the key %p", async (key) => {
    await expect(insert(TENANT_A, "a", 210, key)).rejects.toThrow(/check constraint/);
  });
});
