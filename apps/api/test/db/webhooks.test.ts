import { TENANT_A, TENANT_B, asApp, connect, createTestDb, seed, uid, type TestDb } from "./helpers.js";

let db: TestDb;

beforeAll(async () => {
  db = await createTestDb();
  await seed(db.owner);
  for (const [tenant, family] of [[TENANT_A, "a"], [TENANT_B, "b"]] as const) {
    await db.owner.query(
      "INSERT INTO webhook_endpoints (id, tenant_id, url, events) VALUES ($1, $2, $3, '{consent.granted}')",
      [uid(family, 70), tenant, `https://hooks.${family}.example/saral`],
    );
    await db.owner.query(
      `INSERT INTO webhook_deliveries (id, tenant_id, endpoint_id, event_type, payload, next_attempt_at)
       VALUES ($1, $2, $3, 'consent.granted', '{"x":1}', now() - interval '1 minute')`,
      [uid(family, 71), tenant, uid(family, 70)],
    );
  }
});

afterAll(async () => {
  await db.drop();
});

/** Runs `fn` as the delivery worker role (no tenant), then rolls back. */
async function asWorker<T>(fn: (c: Awaited<ReturnType<typeof connect>>) => Promise<T>): Promise<T> {
  const c = await connect(db);
  try {
    await c.query("BEGIN");
    await c.query("SET LOCAL ROLE saral_worker");
    return await fn(c);
  } finally {
    await c.query("ROLLBACK").catch(() => undefined);
    await c.end();
  }
}

describe("webhook tables for the application role", () => {
  test.each(["webhook_endpoints", "webhook_deliveries"])("%s: a tenant sees only its own rows", async (table) => {
    await asApp(db, TENANT_A, async (c) => {
      expect((await c.query(`SELECT count(*)::int AS n FROM ${table}`)).rows[0].n).toBe(1);
      expect((await c.query(`SELECT count(*)::int AS n FROM ${table} WHERE tenant_id = $1`, [TENANT_B])).rows[0].n).toBe(0);
    });
    await asApp(db, undefined, async (c) => {
      expect((await c.query(`SELECT count(*)::int AS n FROM ${table}`)).rows[0].n).toBe(0);
    });
  });

  test("an insert for another tenant is refused", async () => {
    await expect(
      asApp(db, TENANT_A, (c) =>
        c.query("INSERT INTO webhook_endpoints (id, tenant_id, url, events) VALUES ($1, $2, 'https://x.example/h', '{consent.granted}')", [uid("b", 80), TENANT_B]),
      ),
    ).rejects.toThrow(/row-level security/);
  });

  test("the application role can queue deliveries but not remove them, and may change one only to send a failed one again", async () => {
    await asApp(db, TENANT_A, async (c) => {
      const r = await c.query(
        "INSERT INTO webhook_deliveries (id, tenant_id, endpoint_id, event_type, payload) VALUES ($1, $2, $3, 'consent.withdrawn', '{}')",
        [uid("a", 81), TENANT_A, uid("a", 70)],
      );
      expect(r.rowCount).toBe(1);
    });
    for (const sql of ["UPDATE webhook_deliveries SET state = 'delivered'", "DELETE FROM webhook_deliveries"]) {
      await expect(asApp(db, TENANT_A, (c) => c.query(sql))).rejects.toThrow(/permission denied/);
    }
  });

  test("a delivery cannot point at another tenant's endpoint", async () => {
    await expect(
      db.owner.query(
        "INSERT INTO webhook_deliveries (id, tenant_id, endpoint_id, event_type, payload) VALUES ($1, $2, $3, 'consent.granted', '{}')",
        [uid("a", 82), TENANT_A, uid("b", 70)],
      ),
    ).rejects.toThrow(/foreign key/);
  });

  test.each([
    ["an http URL", "http://hooks.example/x", "{consent.granted}"],
    ["no events", "https://hooks.example/x", "{}"],
    ["an unknown event", "https://hooks.example/x", "{consent.exploded}"],
  ])("rejects %s", async (_n, url, events) => {
    await expect(
      db.owner.query("INSERT INTO webhook_endpoints (id, tenant_id, url, events) VALUES ($1, $2, $3, $4)", [uid("a", 83), TENANT_A, url, events]),
    ).rejects.toThrow(/check constraint/);
  });

  test("state and attempts are constrained", async () => {
    await expect(db.owner.query("UPDATE webhook_deliveries SET state = 'weird' WHERE id = $1", [uid("a", 71)])).rejects.toThrow(/check constraint/);
    await expect(db.owner.query("UPDATE webhook_deliveries SET attempts = 16 WHERE id = $1", [uid("a", 71)])).rejects.toThrow(/check constraint/);
  });
});

describe("sending a failed delivery again, as the application role", () => {
  const FAILED = uid("a", 72);
  const DELIVERED = uid("a", 73);
  const PENDING = uid("a", 74);
  const OTHER_TENANT_FAILED = uid("b", 72);

  beforeAll(async () => {
    const add = (id: string, tenant: string, endpoint: string, state: string, attempts: number) =>
      db.owner.query(
        `INSERT INTO webhook_deliveries (id, tenant_id, endpoint_id, event_type, payload, state, attempts, last_status, last_error)
         VALUES ($1, $2, $3, 'consent.granted', '{"x":1}', $4, $5, 500, 'HTTP 500')`,
        [id, tenant, endpoint, state, attempts],
      );
    await add(FAILED, TENANT_A, uid("a", 70), "failed", 15);
    await add(DELIVERED, TENANT_A, uid("a", 70), "delivered", 1);
    await add(PENDING, TENANT_A, uid("a", 70), "pending", 3);
    await add(OTHER_TENANT_FAILED, TENANT_B, uid("b", 70), "failed", 15);
  });

  // The other tests in this file count every delivery, so these are removed again.
  afterAll(async () => {
    await db.owner.query("DELETE FROM webhook_deliveries WHERE id = ANY($1)", [[FAILED, DELIVERED, PENDING, OTHER_TENANT_FAILED]]);
  });

  const again = (id: string) => ["UPDATE webhook_deliveries SET state = 'pending', attempts = 0, next_attempt_at = now() WHERE id = $1", [id]] as [string, string[]];
  const row = async (id: string) => (await db.owner.query("SELECT state, attempts, last_status, last_error, payload FROM webhook_deliveries WHERE id = $1", [id])).rows[0];

  test("a failed delivery goes back to pending with no attempts used, and what happened before stays on record", async () => {
    // asApp rolls back, so the row is read inside the same transaction.
    const seen = await asApp(db, TENANT_A, async (c) => {
      const r = await c.query(...again(FAILED));
      const after = (await c.query("SELECT state, attempts, last_status, last_error, payload FROM webhook_deliveries WHERE id = $1", [FAILED])).rows[0];
      return { updated: r.rowCount, after };
    });
    expect(seen).toEqual({ updated: 1, after: { state: "pending", attempts: 0, last_status: 500, last_error: "HTTP 500", payload: { x: 1 } } });
  });

  test.each([
    ["a delivered one", () => DELIVERED],
    ["a pending one", () => PENDING],
  ])("%s cannot be sent again", async (_n, id) => {
    await expect(asApp(db, TENANT_A, (c) => c.query(...again(id())))).rejects.toThrow(/permission denied/);
  });

  test.each([
    ["marking it delivered", "state = 'delivered', attempts = 0, next_attempt_at = now()"],
    ["leaving attempts used up", "state = 'pending', attempts = 5, next_attempt_at = now()"],
    ["scheduling it for tomorrow", "state = 'pending', attempts = 0, next_attempt_at = now() + interval '1 day'"],
    ["keeping it failed with fewer attempts", "state = 'failed', attempts = 0, next_attempt_at = now()"],
  ])("a failed one cannot be changed by %s", async (_n, set) => {
    await expect(asApp(db, TENANT_A, (c) => c.query(`UPDATE webhook_deliveries SET ${set} WHERE id = $1`, [FAILED]))).rejects.toThrow(/permission denied/);
    expect((await row(FAILED)).state).toBe("failed");
  });

  test.each(["payload = '{}'", "endpoint_id = endpoint_id", "tenant_id = tenant_id", "last_status = 200", "last_error = NULL", "delivered_at = now()", "created_at = now()", "id = id"])(
    "and %s is not the application role's to change",
    async (set) => {
      await expect(asApp(db, TENANT_A, (c) => c.query(`UPDATE webhook_deliveries SET ${set} WHERE id = $1`, [FAILED]))).rejects.toThrow(/permission denied/);
    },
  );

  test("another tenant's failed delivery is out of reach", async () => {
    const r = await asApp(db, TENANT_A, (c) => c.query(...again(OTHER_TENANT_FAILED)));
    expect(r.rowCount).toBe(0);
    expect((await row(OTHER_TENANT_FAILED)).state).toBe("failed");
  });

  test("the delivery worker is not held to that rule: it records outcomes as before", async () => {
    await asWorker(async (c) => {
      const r = await c.query("UPDATE webhook_deliveries SET state = 'delivered', delivered_at = now(), last_status = 200 WHERE id = $1", [PENDING]);
      expect(r.rowCount).toBe(1);
    });
  });
});

describe("why an endpoint was disabled", () => {
  test("is a column the application role may write alongside the time, and only with a known reason", async () => {
    await asApp(db, TENANT_A, async (c) => {
      await c.query("UPDATE webhook_endpoints SET disabled_at = now(), disabled_reason = 'failures' WHERE id = $1", [uid("a", 70)]);
      expect((await c.query("SELECT disabled_reason FROM webhook_endpoints WHERE id = $1", [uid("a", 70)])).rows[0]).toEqual({ disabled_reason: "failures" });
    });
    await expect(asApp(db, TENANT_A, (c) => c.query("UPDATE webhook_endpoints SET disabled_reason = 'because' WHERE id = $1", [uid("a", 70)]))).rejects.toThrow(/check constraint/);
    await db.owner.query("UPDATE webhook_endpoints SET disabled_at = NULL, disabled_reason = NULL WHERE id = $1", [uid("a", 70)]);
  });

  test("is empty for an endpoint that is not disabled, and endpoints disabled before it existed read as the administrator's doing", async () => {
    expect((await db.owner.query("SELECT disabled_reason FROM webhook_endpoints WHERE id = $1", [uid("b", 70)])).rows[0]).toEqual({ disabled_reason: null });
  });
});

describe("when a secret was rotated with the old one left working", () => {
  test("is a column the application role may write with the new version, and the delivery worker may read", async () => {
    await asApp(db, TENANT_A, async (c) => {
      await c.query("UPDATE webhook_endpoints SET secret_version = 2, rotated_at = now() WHERE id = $1", [uid("a", 70)]);
      expect((await c.query("SELECT secret_version, rotated_at IS NOT NULL AS has FROM webhook_endpoints WHERE id = $1", [uid("a", 70)])).rows[0]).toEqual({ secret_version: 2, has: true });
    });
    await db.owner.query("UPDATE webhook_endpoints SET secret_version = 2, rotated_at = now() WHERE id = $1", [uid("a", 70)]);
    expect(await asWorker(async (c) => (await c.query("SELECT rotated_at IS NOT NULL AS has FROM webhook_endpoints WHERE id = $1", [uid("a", 70)])).rows[0])).toEqual({ has: true });
    await db.owner.query("UPDATE webhook_endpoints SET secret_version = 1, rotated_at = NULL WHERE id = $1", [uid("a", 70)]);
  });

  test("cannot be set on a secret that has never been rotated", async () => {
    await expect(asApp(db, TENANT_A, (c) => c.query("UPDATE webhook_endpoints SET rotated_at = now() WHERE id = $1", [uid("a", 70)]))).rejects.toThrow(/check constraint/);
  });

  test("is empty for an endpoint that was never rotated, and the application role still cannot change its address or events", async () => {
    expect((await db.owner.query("SELECT rotated_at FROM webhook_endpoints WHERE id = $1", [uid("b", 70)])).rows[0]).toEqual({ rotated_at: null });
    await expect(asApp(db, TENANT_A, (c) => c.query("UPDATE webhook_endpoints SET url = 'https://elsewhere.example/x' WHERE id = $1", [uid("a", 70)]))).rejects.toThrow(/permission denied/);
  });
});

describe("the delivery worker role", () => {
  test("is not a superuser and does not bypass row-level security", async () => {
    await asWorker(async (c) => {
      const r = await c.query("SELECT rolsuper, rolbypassrls FROM pg_roles WHERE rolname = current_user");
      expect(r.rows[0]).toEqual({ rolsuper: false, rolbypassrls: false });
    });
  });

  test("sees due deliveries of every tenant, with their endpoints, and nothing else", async () => {
    await asWorker(async (c) => {
      const r = await c.query("SELECT d.tenant_id FROM webhook_deliveries d JOIN webhook_endpoints e ON e.id = d.endpoint_id ORDER BY 1");
      expect(r.rows.map((x: { tenant_id: string }) => x.tenant_id)).toEqual([TENANT_A, TENANT_B]);
    });
  });

  test.each(["consent_records", "tenant_principals", "consent_receipts", "consent_audit_log", "api_keys", "privacy_notices", "tenants"])(
    "cannot read %s",
    async (table) => {
      await expect(asWorker((c) => c.query(`SELECT * FROM ${table}`))).rejects.toThrow(/permission denied/);
    },
  );

  test("can record the outcome of an attempt, but cannot change what is delivered or where", async () => {
    await asWorker(async (c) => {
      const r = await c.query("UPDATE webhook_deliveries SET state = 'delivered', attempts = 1, last_status = 200, delivered_at = now() WHERE id = $1", [uid("a", 71)]);
      expect(r.rowCount).toBe(1);
    });
    for (const sql of ["UPDATE webhook_deliveries SET payload = '{}'", "UPDATE webhook_deliveries SET endpoint_id = endpoint_id", "UPDATE webhook_deliveries SET tenant_id = tenant_id", "UPDATE webhook_endpoints SET url = url"]) {
      await expect(asWorker((c) => c.query(sql))).rejects.toThrow(/permission denied/);
    }
  });

  test("cannot insert or delete deliveries", async () => {
    await expect(asWorker((c) => c.query("DELETE FROM webhook_deliveries"))).rejects.toThrow(/permission denied/);
    await expect(
      asWorker((c) => c.query("INSERT INTO webhook_deliveries (id, tenant_id, endpoint_id, event_type, payload) VALUES ($1, $2, $3, 'consent.granted', '{}')", [uid("a", 90), TENANT_A, uid("a", 70)])),
    ).rejects.toThrow(/permission denied/);
  });
});
