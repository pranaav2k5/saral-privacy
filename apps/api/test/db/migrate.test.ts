import { spawnSync } from "node:child_process";
import { copyFile, mkdtemp, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { join } from "node:path";
import { MIGRATIONS_DIR, migrate } from "../../src/db/migrate.js";
import { createTestDb, type TestDb } from "./helpers.js";

let db: TestDb;
let dir: string;

beforeEach(async () => {
  db = await createTestDb({ migrate: false });
  dir = await mkdtemp(join(tmpdir(), "saral-migrations-"));
});

afterEach(async () => {
  await db.drop();
  await rm(dir, { recursive: true, force: true });
});

describe("migrate", () => {
  test("applies every migration once and does nothing the second time", async () => {
    const first = await migrate(db.owner);
    expect(first).toEqual(["0001_core.sql", "0002_audit_log.sql", "0003_api_keys.sql", "0004_webhooks.sql", "0005_idempotency.sql", "0006_dsr.sql", "0007_staff.sql", "0008_staff_password.sql", "0009_staff_must_change_password.sql", "0010_webhook_redelivery.sql", "0011_anchor_role.sql", "0012_breach_incidents.sql", "0013_ropa_versions.sql", "0014_webhook_rotation_overlap.sql", "0015_reminders.sql"]);
    expect(await migrate(db.owner)).toEqual([]);
    const rows = await db.owner.query("SELECT name, sha256 FROM schema_migrations ORDER BY name");
    expect(rows.rows.map((r: { name: string }) => r.name)).toEqual(first);
    for (const r of rows.rows as { sha256: string }[]) expect(r.sha256).toMatch(/^[0-9a-f]{64}$/);
  });

  test("the migrations directory holds only numbered .sql files", async () => {
    const files = await readdir(MIGRATIONS_DIR);
    expect(files.every((f) => /^\d{4}_[a-z0-9_]+\.sql$/.test(f))).toBe(true);
  });

  test("an applied migration that has since been edited is an error", async () => {
    await writeFile(join(dir, "0001_a.sql"), "CREATE TABLE a (id int);");
    await migrate(db.owner, dir);
    await writeFile(join(dir, "0001_a.sql"), "CREATE TABLE a (id int, extra int);");
    await expect(migrate(db.owner, dir)).rejects.toThrow(/0001_a.sql was applied and has since been changed/);
  });

  test("a failing migration is rolled back completely and not recorded", async () => {
    await writeFile(join(dir, "0001_ok.sql"), "CREATE TABLE ok (id int);");
    await writeFile(join(dir, "0002_bad.sql"), "CREATE TABLE half (id int); SELECT 1/0;");
    await expect(migrate(db.owner, dir)).rejects.toThrow(/migration 0002_bad.sql failed: division by zero/);
    expect((await db.owner.query("SELECT to_regclass('half') AS t")).rows[0].t).toBeNull();
    expect((await db.owner.query("SELECT to_regclass('ok') AS t")).rows[0].t).toBe("ok");
    const names = (await db.owner.query("SELECT name FROM schema_migrations")).rows.map((r: { name: string }) => r.name);
    expect(names).toEqual(["0001_ok.sql"]);
  });

  test("files that do not match the naming rule are ignored", async () => {
    await writeFile(join(dir, "0001_a.sql"), "CREATE TABLE a (id int);");
    await writeFile(join(dir, "notes.sql"), "DROP TABLE a;");
    await writeFile(join(dir, "0002_B.sql"), "DROP TABLE a;");
    await writeFile(join(dir, "README.md"), "x");
    expect(await migrate(db.owner, dir)).toEqual(["0001_a.sql"]);
  });

  test("two migrators at the same time apply each migration once", async () => {
    await copyFile(join(MIGRATIONS_DIR, "0001_core.sql"), join(dir, "0001_core.sql"));
    const other = await (await import("./helpers.js")).connect(db);
    try {
      const [a, b] = await Promise.all([migrate(db.owner, dir), migrate(other, dir)]);
      expect([...a, ...b]).toEqual(["0001_core.sql"]);
    } finally {
      await other.end();
    }
  });
});

describe("migrate command", () => {
  const cli = fileURLToPath(new URL("../../dist/db/migrate-cli.js", import.meta.url));
  const run = (env: Record<string, string | undefined>) =>
    spawnSync(process.execPath, [cli], { env: { PATH: process.env.PATH, ...env }, encoding: "utf8" });

  test("applies the migrations, then reports that the database is up to date", () => {
    const first = run({ DATABASE_URL: db.url });
    expect(first.status).toBe(0);
    expect(first.stdout).toContain("applied: 0001_core.sql, 0002_audit_log.sql, 0003_api_keys.sql, 0004_webhooks.sql, 0005_idempotency.sql, 0006_dsr.sql, 0007_staff.sql, 0008_staff_password.sql, 0009_staff_must_change_password.sql, 0010_webhook_redelivery.sql, 0011_anchor_role.sql, 0012_breach_incidents.sql, 0013_ropa_versions.sql, 0014_webhook_rotation_overlap.sql, 0015_reminders.sql");
    const second = run({ DATABASE_URL: db.url });
    expect(second.status).toBe(0);
    expect(second.stdout).toContain("database is up to date");
  });

  test("exits 1 with a message when DATABASE_URL is missing", () => {
    const r = run({});
    expect(r.status).toBe(1);
    expect(r.stderr).toContain("DATABASE_URL is required");
  });

  test("exits 1 and names the problem when the database cannot be reached", () => {
    const r = run({ DATABASE_URL: "postgres://saral:wrong@127.0.0.1:1/none" });
    expect(r.status).toBe(1);
    expect(r.stderr.length).toBeGreaterThan(0);
  });
});
