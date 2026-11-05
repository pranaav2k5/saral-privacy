import { createHash } from "node:crypto";
import { readdir, readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import type pg from "pg";

/** Directory of the SQL migrations. The same relative path works from `src/db` and from `dist/db`. */
export const MIGRATIONS_DIR = fileURLToPath(new URL("../../db/migrations/", import.meta.url));

const LOCK_KEY = "saral.migrations";

/**
 * Applies the SQL files in `dir`, in name order, each in its own transaction, and records the name and SHA-256 of
 * every file in `schema_migrations`. A file that was applied and has since changed is an error: migrations are
 * append-only. Returns the names applied by this call. Safe to run concurrently (an advisory lock serialises it).
 */
export async function migrate(client: pg.Client, dir: string = MIGRATIONS_DIR): Promise<string[]> {
  await client.query("SELECT pg_advisory_lock(hashtextextended($1, 0))", [LOCK_KEY]);
  try {
    await client.query(`CREATE TABLE IF NOT EXISTS schema_migrations (
      name text PRIMARY KEY,
      sha256 char(64) NOT NULL,
      applied_at timestamptz NOT NULL DEFAULT now())`);
    await client.query("REVOKE ALL ON schema_migrations FROM PUBLIC");
    const files = (await readdir(dir)).filter((f) => /^\d{4}_[a-z0-9_]+\.sql$/.test(f)).sort();
    const applied = await client.query<{ name: string; sha256: string }>("SELECT name, sha256 FROM schema_migrations");
    const known = new Map(applied.rows.map((r) => [r.name, r.sha256]));
    const done: string[] = [];
    for (const name of files) {
      const sql = await readFile(`${dir}/${name}`, "utf8");
      const sha = createHash("sha256").update(sql).digest("hex");
      const before = known.get(name);
      if (before !== undefined) {
        if (before !== sha) throw new Error(`migration ${name} was applied and has since been changed`);
        continue;
      }
      try {
        await client.query("BEGIN");
        await client.query(sql);
        await client.query("INSERT INTO schema_migrations (name, sha256) VALUES ($1, $2)", [name, sha]);
        await client.query("COMMIT");
      } catch (e) {
        await client.query("ROLLBACK");
        throw new Error(`migration ${name} failed: ${e instanceof Error ? e.message : String(e)}`, { cause: e });
      }
      done.push(name);
    }
    return done;
  } finally {
    await client.query("SELECT pg_advisory_unlock(hashtextextended($1, 0))", [LOCK_KEY]);
  }
}
