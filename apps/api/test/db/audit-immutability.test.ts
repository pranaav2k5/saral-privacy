import { GENESIS_HASH, sealEntry, sha256Hex, verifyChain, type ChainEntry } from "@saral/audit-chain";
import type pg from "pg";
import { HEX, connect, createTestDb, uid, type TestDb } from "./helpers.js";

const KEY = new Uint8Array(32).fill(7);
const resolveKey = (v: number): Uint8Array | undefined => (v === 1 ? KEY : undefined);
const T_FRESH = "cccccccc-cccc-4ccc-8ccc-cccccccccccc";
const T_RULES = "dddddddd-dddd-4ddd-8ddd-dddddddddddd";
const T_LOAD = "eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee";

let db: TestDb;

beforeAll(async () => {
  db = await createTestDb();
  for (const [id, slug] of [[T_FRESH, "fresh"], [T_RULES, "rules"], [T_LOAD, "load"]] as const) {
    await db.owner.query("INSERT INTO tenants (id, name, slug) VALUES ($1, $2, $3)", [id, slug, slug]);
  }
});

afterAll(async () => {
  await db.drop();
});

type Row = {
  tenant_id: string; seq_no: string; ts: Date; actor_type: "principal" | "dpo" | "system"; actor_id: string | null;
  action: string; ref_table: string; ref_id: string; payload_sha256: string; prev_hash: string; entry_hash: string;
  canonical_schema_version: number; hmac_schema_version: number;
};

const toEntry = (r: Row): ChainEntry => ({
  tenantId: r.tenant_id, seqNo: r.seq_no, ts: r.ts.toISOString(), actorType: r.actor_type, actorId: r.actor_id,
  action: r.action, refTable: r.ref_table, refId: r.ref_id, payloadSha256: r.payload_sha256, prevHash: r.prev_hash,
  entryHash: r.entry_hash, canonicalSchemaVersion: r.canonical_schema_version, hmacSchemaVersion: r.hmac_schema_version,
});

const INSERT = `INSERT INTO consent_audit_log (tenant_id, seq_no, ts, actor_type, actor_id, action, ref_table, ref_id, payload_sha256, prev_hash, entry_hash)
                VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)`;

async function begin(c: pg.Client, tenant: string): Promise<void> {
  await c.query("BEGIN");
  await c.query("SET LOCAL ROLE saral_app");
  await c.query("SELECT set_config('app.tenant_id', $1, true)", [tenant]);
}

async function readAll(tenant: string): Promise<ChainEntry[]> {
  const c = await connect(db);
  try {
    await begin(c, tenant);
    const r = await c.query<Row>("SELECT * FROM consent_audit_log ORDER BY seq_no");
    return r.rows.map(toEntry);
  } finally {
    await c.query("ROLLBACK").catch(() => undefined);
    await c.end();
  }
}

/** Appends one entry the way the API will: lock, read the head, seal, insert, commit. */
async function append(tenant: string, n: number, opts: { lock: boolean } = { lock: true }): Promise<ChainEntry> {
  const c = await connect(db);
  try {
    await begin(c, tenant);
    if (opts.lock) await c.query("SELECT audit_append_lock($1)", [tenant]);
    const head = await c.query<{ seq_no: string; entry_hash: string }>(
      "SELECT seq_no, entry_hash FROM consent_audit_log ORDER BY seq_no DESC LIMIT 1",
    );
    const prev = head.rows[0];
    const entry = sealEntry(
      {
        tenantId: tenant,
        seqNo: String(BigInt(prev?.seq_no ?? "0") + 1n),
        ts: new Date(Date.UTC(2026, 10, 6, 9, 0, 0, n)).toISOString(),
        actorType: "system",
        actorId: null,
        action: "consent.granted",
        refTable: "consent_records",
        refId: uid("f", n),
        payloadSha256: sha256Hex(`payload-${String(n)}`),
      },
      prev?.entry_hash ?? GENESIS_HASH,
      KEY,
    );
    await c.query(INSERT, [tenant, entry.seqNo, entry.ts, entry.actorType, entry.actorId, entry.action, entry.refTable, entry.refId, entry.payloadSha256, entry.prevHash, entry.entryHash]);
    await c.query("COMMIT");
    return entry;
  } catch (e) {
    await c.query("ROLLBACK").catch(() => undefined);
    throw e;
  } finally {
    await c.end();
  }
}

const insertRaw = async (tenant: string, params: unknown[]): Promise<void> => {
  const c = await connect(db);
  try {
    await begin(c, tenant);
    await c.query(INSERT, params);
  } finally {
    await c.query("ROLLBACK").catch(() => undefined);
    await c.end();
  }
};

const row = (tenant: string, seq: number, prev: string, over: Partial<Record<number, unknown>> = {}): unknown[] => {
  const base: unknown[] = [tenant, seq, "2026-11-06T09:30:00.000Z", "system", null, "consent.granted", "consent_records", uid("f", seq), HEX("5"), prev, HEX("6")];
  Object.entries(over).forEach(([i, v]) => (base[Number(i)] = v));
  return base;
};

describe("the chain links are enforced in the database", () => {
  test("the first entry of a tenant must be seq 1 with the genesis hash", async () => {
    await expect(insertRaw(T_RULES, row(T_RULES, 2, GENESIS_HASH))).rejects.toThrow(/first audit entry/);
    await expect(insertRaw(T_RULES, row(T_RULES, 1, HEX("a")))).rejects.toThrow(/first audit entry/);
  });

  test("a later entry must have the next seq and the previous entry's hash", async () => {
    const first = await append(T_RULES, 1);
    await expect(insertRaw(T_RULES, row(T_RULES, 3, first.entryHash))).rejects.toThrow(/does not follow/);
    await expect(insertRaw(T_RULES, row(T_RULES, 2, HEX("a")))).rejects.toThrow(/does not follow/);
    await expect(insertRaw(T_RULES, row(T_RULES, 1, GENESIS_HASH))).rejects.toThrow(/does not follow/);
  });

  test("timestamps must have millisecond precision, the precision the canonical string hashes", async () => {
    const head = (await readAll(T_RULES)).at(-1) as ChainEntry;
    await expect(
      insertRaw(T_RULES, row(T_RULES, 2, head.entryHash, { 2: "2026-11-06T09:30:00.123456Z" })),
    ).rejects.toThrow(/check constraint/);
  });

  test.each([
    ["entry_hash is not hex", 10, "z".repeat(64)],
    ["payload_sha256 is uppercase", 8, "A".repeat(64)],
    ["actor_type is unknown", 3, "admin"],
    ["action is malformed", 5, "Granted"],
    ["actor_id is empty", 4, ""],
  ])("rejects a row where %s", async (_name, index, value) => {
    const head = (await readAll(T_RULES)).at(-1) as ChainEntry;
    await expect(insertRaw(T_RULES, row(T_RULES, 2, head.entryHash, { [index]: value }))).rejects.toThrow(/check constraint/);
  });

  test("an append that read a stale head fails when another append committed first (why the advisory lock exists)", async () => {
    const a = await connect(db);
    const b = await connect(db);
    try {
      await begin(a, T_FRESH);
      await begin(b, T_FRESH);
      const head = async (c: pg.Client) => (await c.query("SELECT count(*)::int AS n FROM consent_audit_log")).rows[0].n as number;
      expect(await head(a)).toBe(0);
      expect(await head(b)).toBe(0);
      await a.query(INSERT, row(T_FRESH, 1, GENESIS_HASH));
      await a.query("COMMIT");
      await expect(b.query(INSERT, row(T_FRESH, 1, GENESIS_HASH, { 7: uid("f", 99) }))).rejects.toThrow();
    } finally {
      await a.query("ROLLBACK").catch(() => undefined);
      await b.query("ROLLBACK").catch(() => undefined);
      await a.end();
      await b.end();
    }
  });
});

describe("the log is append-only", () => {
  test("the application role cannot update, delete or truncate", async () => {
    const c = await connect(db);
    try {
      await begin(c, T_RULES);
      for (const sql of ["UPDATE consent_audit_log SET action = 'consent.withdrawn'", "DELETE FROM consent_audit_log", "TRUNCATE consent_audit_log"]) {
        await c.query("SAVEPOINT s");
        await expect(c.query(sql)).rejects.toThrow(/permission denied/);
        await c.query("ROLLBACK TO s");
      }
    } finally {
      await c.query("ROLLBACK").catch(() => undefined);
      await c.end();
    }
  });

  test("even the owner is stopped by the triggers: update, delete and truncate raise", async () => {
    await expect(db.owner.query("UPDATE consent_audit_log SET action = 'consent.withdrawn'")).rejects.toThrow(/append-only/);
    await expect(db.owner.query("DELETE FROM consent_audit_log")).rejects.toThrow(/append-only/);
    await expect(db.owner.query("TRUNCATE consent_audit_log")).rejects.toThrow(/append-only/);
    expect((await db.owner.query("SELECT count(*)::int AS n FROM consent_audit_log WHERE tenant_id = $1", [T_RULES])).rows[0].n).toBe(1);
  });
});

describe("a real chain stored in the database", () => {
  test("20 concurrent appends under the advisory lock give contiguous seq numbers and a chain that verifies", async () => {
    const results = await Promise.all(Array.from({ length: 20 }, (_, i) => append(T_LOAD, i + 1)));
    expect(results).toHaveLength(20);
    const entries = await readAll(T_LOAD);
    expect(entries.map((e) => e.seqNo)).toEqual(Array.from({ length: 20 }, (_, i) => String(i + 1)));
    expect(verifyChain(entries, resolveKey)).toMatchObject({ ok: true, count: 20 });
  });

  test("an owner who deliberately disables the trigger and edits a row is caught by verifyChain", async () => {
    await db.owner.query("ALTER TABLE consent_audit_log DISABLE TRIGGER audit_no_update_delete");
    try {
      await db.owner.query("UPDATE consent_audit_log SET action = 'consent.withdrawn' WHERE tenant_id = $1 AND seq_no = 7", [T_LOAD]);
    } finally {
      await db.owner.query("ALTER TABLE consent_audit_log ENABLE TRIGGER audit_no_update_delete");
    }
    expect(verifyChain(await readAll(T_LOAD), resolveKey)).toEqual({ ok: false, failure: "hash_mismatch", seqNo: "7" });
  });
});
