import { DSR_STATES, canTransition, type DsrState } from "../../src/dsr/state.js";
import { TENANT_A, TENANT_B, asApp, createTestDb, seed, uid, type TestDb } from "./helpers.js";

let db: TestDb;
let n = 300;

beforeAll(async () => {
  db = await createTestDb();
  await seed(db.owner);
});

afterAll(async () => {
  await db.drop();
});

const DUE = "2026-12-06T09:30:00.000Z";

async function request(tenant: string, family: string, state: DsrState = "submitted", type = "access"): Promise<string> {
  const id = uid(family, ++n);
  await db.owner.query(
    `INSERT INTO dsr_requests (id, tenant_id, principal_id, type, state, due_at) VALUES ($1, $2, $3, $4, $5, $6)`,
    [id, tenant, uid(family, 1), type, state, DUE],
  );
  return id;
}

describe("dsr_requests: tenant isolation", () => {
  test("a tenant sees only its own requests; with no tenant set, none; another tenant's insert is refused", async () => {
    await request(TENANT_A, "a");
    await request(TENANT_B, "b");
    await asApp(db, TENANT_A, async (c) => {
      expect((await c.query("SELECT count(*)::int AS n FROM dsr_requests WHERE tenant_id = $1", [TENANT_B])).rows[0].n).toBe(0);
      expect((await c.query("SELECT count(*)::int AS n FROM dsr_requests")).rows[0].n).toBeGreaterThan(0);
    });
    await asApp(db, undefined, async (c) => {
      expect((await c.query("SELECT count(*)::int AS n FROM dsr_requests")).rows[0].n).toBe(0);
    });
    await expect(
      asApp(db, TENANT_A, (c) => c.query("INSERT INTO dsr_requests (id, tenant_id, principal_id, type, due_at) VALUES ($1, $2, $3, 'access', $4)", [uid("b", 999), TENANT_B, uid("b", 1), DUE])),
    ).rejects.toThrow(/row-level security/);
  });

  test("a request cannot point at another tenant's person (composite foreign key, even for the owner)", async () => {
    await expect(
      db.owner.query("INSERT INTO dsr_requests (id, tenant_id, principal_id, type, due_at) VALUES ($1, $2, $3, 'access', $4)", [uid("a", 998), TENANT_A, uid("b", 1), DUE]),
    ).rejects.toThrow(/foreign key/);
  });
});

describe("dsr_requests: the state machine is enforced by the database", () => {
  test("every one of the 36 state pairs agrees with the TypeScript state machine", async () => {
    for (const from of DSR_STATES) {
      for (const to of DSR_STATES) {
        const id = await request(TENANT_A, "a", from);
        const set = to === "rejected" ? ", decided_reason = 'no basis'" : "";
        const close = to === "closed" ? ", closed_at = now()" : "";
        let ok = true;
        try {
          await db.owner.query(`UPDATE dsr_requests SET state = $2${set}${close} WHERE id = $1`, [id, to]);
        } catch {
          ok = false;
        }
        expect({ from, to, ok }).toEqual({ from, to, ok: canTransition(from, to) });
      }
    }
  }, 60000);

  test("rejecting needs a reason", async () => {
    const id = await request(TENANT_A, "a", "in_review");
    await expect(db.owner.query("UPDATE dsr_requests SET state = 'rejected' WHERE id = $1", [id])).rejects.toThrow(/reason/);
    await expect(db.owner.query("UPDATE dsr_requests SET state = 'rejected', decided_reason = '   ' WHERE id = $1", [id])).rejects.toThrow(/reason/);
  });

  test("nothing but state, reason and closing time can change, even for the owner", async () => {
    const id = await request(TENANT_A, "a", "submitted");
    for (const sql of [
      "UPDATE dsr_requests SET type = 'erasure', state = 'in_review' WHERE id = $1",
      "UPDATE dsr_requests SET due_at = now(), state = 'in_review' WHERE id = $1",
      "UPDATE dsr_requests SET details = 'changed', state = 'in_review' WHERE id = $1",
      "UPDATE dsr_requests SET submitted_at = now(), state = 'in_review' WHERE id = $1",
    ]) {
      await expect(db.owner.query(sql, [id])).rejects.toThrow(/only state/);
    }
  });

  test("the application role may update only state, reason and closing time, and may not delete", async () => {
    const id = await request(TENANT_A, "a", "submitted");
    await expect(asApp(db, TENANT_A, (c) => c.query("UPDATE dsr_requests SET type = 'erasure' WHERE id = $1", [id]))).rejects.toThrow(/permission denied/);
    await expect(asApp(db, TENANT_A, (c) => c.query("DELETE FROM dsr_requests"))).rejects.toThrow(/permission denied/);
    await asApp(db, TENANT_A, async (c) => {
      expect((await c.query("UPDATE dsr_requests SET state = 'in_review' WHERE id = $1", [id])).rowCount).toBe(1);
    });
  });

  test.each([
    ["an unknown type", "INSERT INTO dsr_requests (id, tenant_id, principal_id, type, due_at) VALUES ($1, $2, $3, 'sell', $4)"],
    ["no due date", "INSERT INTO dsr_requests (id, tenant_id, principal_id, type) VALUES ($1, $2, $3, 'access')"],
  ])("rejects %s", async (_n, sql) => {
    const params = sql.includes("$4") ? [uid("a", 990), TENANT_A, uid("a", 1), DUE] : [uid("a", 990), TENANT_A, uid("a", 1)];
    await expect(db.owner.query(sql, params)).rejects.toThrow(/check constraint|null value/);
  });

  test("details are limited to 2000 characters", async () => {
    await expect(
      db.owner.query("INSERT INTO dsr_requests (id, tenant_id, principal_id, type, details, due_at) VALUES ($1, $2, $3, 'grievance', $4, $5)", [uid("a", 991), TENANT_A, uid("a", 1), "x".repeat(2001), DUE]),
    ).rejects.toThrow(/check constraint/);
  });
});

describe("principal_contacts", () => {
  const sealed = Buffer.alloc(40, 7);

  test("a tenant sees and changes only its own, can delete its own, and a size limit applies", async () => {
    await db.owner.query("INSERT INTO principal_contacts (tenant_id, principal_id, sealed) VALUES ($1, $2, $3), ($4, $5, $3)", [TENANT_A, uid("a", 1), sealed, TENANT_B, uid("b", 1)]);
    await asApp(db, TENANT_A, async (c) => {
      expect((await c.query("SELECT count(*)::int AS n FROM principal_contacts")).rows[0].n).toBe(1);
      expect((await c.query("UPDATE principal_contacts SET sealed = $1", [Buffer.alloc(41, 8)])).rowCount).toBe(1);
      expect((await c.query("DELETE FROM principal_contacts")).rowCount).toBe(1);
    });
    expect((await db.owner.query("SELECT count(*)::int AS n FROM principal_contacts WHERE tenant_id = $1", [TENANT_B])).rows[0].n).toBe(1);
    await expect(db.owner.query("INSERT INTO principal_contacts (tenant_id, principal_id, sealed) VALUES ($1, $2, $3)", [TENANT_A, uid("a", 1), Buffer.alloc(5)])).rejects.toThrow(/check constraint/);
  });
});

describe("pseudonym unlinking for erasure", () => {
  test("the application role may replace a person's pseudonym (that is how erasure unlinks an identifier), and nothing else about a person", async () => {
    await asApp(db, TENANT_A, async (c) => {
      expect((await c.query("UPDATE tenant_principals SET pseudonym_hmac = $1 WHERE id = $2", ["9".repeat(64), uid("a", 1)])).rowCount).toBe(1);
    });
    await expect(asApp(db, TENANT_A, (c) => c.query("UPDATE tenant_principals SET created_at = now()"))).rejects.toThrow(/permission denied/);
  });
});

describe("webhook events for rights requests", () => {
  test("endpoints and deliveries accept dsr.submitted and dsr.transitioned", async () => {
    await db.owner.query("INSERT INTO webhook_endpoints (id, tenant_id, url, events) VALUES ($1, $2, 'https://h.example.org/x', '{dsr.submitted,dsr.transitioned}')", [uid("a", 970), TENANT_A]);
    await db.owner.query("INSERT INTO webhook_deliveries (id, tenant_id, endpoint_id, event_type, payload) VALUES ($1, $2, $3, 'dsr.transitioned', '{}')", [uid("a", 971), TENANT_A, uid("a", 970)]);
    await expect(db.owner.query("INSERT INTO webhook_endpoints (id, tenant_id, url, events) VALUES ($1, $2, 'https://h.example.org/y', '{dsr.exploded}')", [uid("a", 972), TENANT_A])).rejects.toThrow(/check constraint/);
  });
});
