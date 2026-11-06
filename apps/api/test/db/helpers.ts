import { createHash, randomBytes } from "node:crypto";
import pg from "pg";
import { migrate } from "../../src/db/migrate.js";

export const TENANT_A = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
export const TENANT_B = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
export const GENESIS = "0".repeat(64);
export const HEX = (c: string): string => c.repeat(64);
export const sha256 = (text: string): string => createHash("sha256").update(text, "utf8").digest("hex");
export const NOTICE_TEXT = "notice text";

/** Deterministic UUID for tests: `uid("c", 7)` is the 7th id in the "c" family. */
export const uid = (family: string, n: number): string =>
  `${family.repeat(8)}-${family.repeat(4)}-4${family.repeat(3)}-8${family.repeat(3)}-${n.toString(16).padStart(12, "0")}`;

export function adminUrl(): string {
  const url = process.env.DATABASE_URL;
  if (!url) {
    throw new Error(
      "DATABASE_URL is required for the database tests. Run `pnpm db:up` and export DATABASE_URL from .env.example.",
    );
  }
  return url;
}

export interface TestDb {
  url: string;
  /** Connection as the database owner (a superuser on the dev and CI databases). */
  owner: pg.Client;
  drop(): Promise<void>;
}

/** Creates a throwaway database, migrates it, and returns an owner connection. */
export async function createTestDb(opts: { migrate?: boolean } = {}): Promise<TestDb> {
  const admin = new pg.Client({ connectionString: adminUrl() });
  await admin.connect();
  const name = `saral_test_${randomBytes(6).toString("hex")}`; // generated here, never user input
  // CREATE DATABASE copies template1 and fails if another session is copying it at the same moment, which
  // happens when Jest starts several test files together. A shared advisory lock serialises the copies.
  await admin.query("SELECT pg_advisory_lock(hashtextextended('saral.test.create-database', 0))");
  try {
    await admin.query(`CREATE DATABASE ${name}`);
  } finally {
    await admin.query("SELECT pg_advisory_unlock(hashtextextended('saral.test.create-database', 0))");
  }
  const url = new URL(adminUrl());
  url.pathname = `/${name}`;
  const owner = new pg.Client({ connectionString: url.toString() });
  await owner.connect();
  if (opts.migrate !== false) await migrate(owner);
  return {
    url: url.toString(),
    owner,
    async drop() {
      await owner.end();
      await admin.query(`DROP DATABASE ${name} WITH (FORCE)`);
      await admin.end();
    },
  };
}

export async function connect(db: TestDb): Promise<pg.Client> {
  const c = new pg.Client({ connectionString: db.url });
  await c.connect();
  return c;
}

/**
 * Runs `fn` in a transaction as the application role with the tenant set (the way the API will), then rolls back.
 * `tenantId` undefined leaves the setting unset; null sets it to the empty string.
 */
export async function asApp<T>(
  db: TestDb,
  tenantId: string | null | undefined,
  fn: (c: pg.Client) => Promise<T>,
): Promise<T> {
  const c = await connect(db);
  try {
    await c.query("BEGIN");
    await c.query("SET LOCAL ROLE saral_app");
    if (tenantId !== undefined) await c.query("SELECT set_config('app.tenant_id', $1, true)", [tenantId ?? ""]);
    return await fn(c);
  } finally {
    await c.query("ROLLBACK").catch(() => undefined);
    await c.end();
  }
}

/** Seeds two tenants with one of everything, as the owner (superusers skip row-level security). */
export async function seed(owner: pg.Client): Promise<void> {
  for (const [tenant, family, slug] of [
    [TENANT_A, "a", "tenant-a"],
    [TENANT_B, "b", "tenant-b"],
  ] as const) {
    await owner.query("INSERT INTO tenants (id, name, slug) VALUES ($1, $2, $3)", [tenant, `Tenant ${slug}`, slug]);
    await owner.query(
      "INSERT INTO tenant_principals (tenant_id, id, pseudonym_hmac) VALUES ($1, $2, $3)",
      [tenant, uid(family, 1), HEX(family === "a" ? "1" : "2")],
    );
    await owner.query(
      `INSERT INTO privacy_notices (id, tenant_id, version, language, canonical_text, canonical_sha256)
       VALUES ($1, $2, 1, 'en', $3, $4)`,
      [uid(family, 2), tenant, NOTICE_TEXT, sha256(NOTICE_TEXT)],
    );
    await owner.query(
      `INSERT INTO consent_records (id, tenant_id, principal_id, notice_id, notice_sha256, purposes, status, granted_at, collection_method)
       VALUES ($1, $2, $3, $4, $5, '[{"key":"analytics","granted":true,"retention_days":365}]', 'granted', now(), 'web_sdk')`,
      [uid(family, 3), tenant, uid(family, 1), uid(family, 2), sha256(NOTICE_TEXT)],
    );
    await owner.query(
      "INSERT INTO consent_receipts (id, tenant_id, consent_id, jwt, jwks_kid) VALUES ($1, $2, $3, 'a.b.c', 'kid-1')",
      [uid(family, 4), tenant, uid(family, 3)],
    );
    await owner.query(
      `INSERT INTO consent_audit_log (tenant_id, seq_no, ts, actor_type, actor_id, action, ref_table, ref_id, payload_sha256, prev_hash, entry_hash)
       VALUES ($1, 1, '2026-11-06T09:30:00.000Z', 'system', NULL, 'consent.granted', 'consent_records', $2, $3, $4, $5)`,
      [tenant, uid(family, 3), HEX("5"), GENESIS, HEX(family === "a" ? "6" : "7")],
    );
  }
}
