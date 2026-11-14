import { BREACH_STATES, canTransition, type BreachState } from "../../src/breaches/state.js";
import { TENANT_A, TENANT_B, asApp, createTestDb, seed, uid, type TestDb } from "./helpers.js";

let db: TestDb;
let n = 500;
beforeAll(async () => {
  db = await createTestDb();
  await seed(db.owner);
});
afterAll(async () => {
  await db.drop();
});

const H = (c: string) => c.repeat(64);
const FIELDS = `id, tenant_id, title, description, discovered_at, occurred_at, nature, data_categories, approx_principals, likely_consequences, measures_taken, reported_by`;

async function reported(tenant = TENANT_A, family = "a"): Promise<string> {
  const id = uid(family, ++n);
  await db.owner.query(
    `INSERT INTO breach_incidents (${FIELDS}) VALUES ($1, $2, 'Laptop lost', 'A laptop with a customer list was lost.', '2026-11-06T09:00:00Z', '2026-11-05T20:00:00Z', '{confidentiality}', '{phone numbers}', 120, 'Calls from strangers', 'The laptop was wiped remotely.', 'staff:x')`,
    [id, tenant],
  );
  return id;
}
const SIGN = "state = 'signed_off', signed_off_at = now(), signed_off_by = 'staff:dpo', signed_off_board_sha256 = $2, signed_off_principal_sha256 = $3";
const BOARD = "state = 'board_notified', board_notified_at = now(), board_reference = 'DPB-123'";
const TOLD = "principals_notified_at = now(), principals_how = 'Email to each person', principals_count = 120";
const CLOSE = "state = 'closed', closed_at = now(), closing_note = 'Done.'";
const sign = (id: string) => db.owner.query(`UPDATE breach_incidents SET ${SIGN} WHERE id = $1`, [id, H("a"), H("b")]);

/** An incident that has been moved, legally, to `state`; with the affected people told when `told`. */
async function at(state: BreachState, told = false): Promise<string> {
  const id = await reported();
  if (state === "reported") return id;
  await sign(id);
  if (told) await db.owner.query(`UPDATE breach_incidents SET ${TOLD} WHERE id = $1`, [id]);
  if (state === "signed_off") return id;
  await db.owner.query(`UPDATE breach_incidents SET ${BOARD} WHERE id = $1`, [id]);
  if (state === "board_notified") return id;
  if (!told) await db.owner.query(`UPDATE breach_incidents SET ${TOLD} WHERE id = $1`, [id]);
  await db.owner.query(`UPDATE breach_incidents SET ${CLOSE} WHERE id = $1`, [id]);
  return id;
}
const fails = async (sql: string, params: unknown[], words: RegExp) => expect(db.owner.query(sql, params)).rejects.toThrow(words);

describe("tenant isolation and the application role", () => {
  test("a tenant sees only its own incidents; with no tenant set, none; another tenant's insert is refused", async () => {
    await reported(TENANT_A, "a");
    await reported(TENANT_B, "b");
    await asApp(db, TENANT_A, async (c) => {
      expect((await c.query("SELECT count(*)::int AS n FROM breach_incidents WHERE tenant_id = $1", [TENANT_B])).rows[0].n).toBe(0);
      expect((await c.query("SELECT count(*)::int AS n FROM breach_incidents")).rows[0].n).toBeGreaterThan(0);
    });
    await asApp(db, undefined, async (c) => expect((await c.query("SELECT count(*)::int AS n FROM breach_incidents")).rows[0].n).toBe(0));
    await expect(
      asApp(db, TENANT_A, (c) =>
        c.query(`INSERT INTO breach_incidents (${FIELDS}) VALUES ($1, $2, 't', 'd', now(), NULL, '{integrity}', '{x}', NULL, 'c', 'm', 'staff:x')`, [uid("b", 998), TENANT_B]),
      ),
    ).rejects.toThrow(/row-level security/);
  });

  test("the application role can report and read, but never delete an incident", async () => {
    await asApp(db, TENANT_A, async (c) => {
      const r = await c.query(`INSERT INTO breach_incidents (${FIELDS}) VALUES ($1, $2, 't', 'd', now(), NULL, '{integrity}', '{x}', NULL, 'c', 'm', 'staff:x')`, [uid("a", 997), TENANT_A]);
      expect(r.rowCount).toBe(1);
    });
    await expect(asApp(db, TENANT_A, (c) => c.query("DELETE FROM breach_incidents"))).rejects.toThrow(/permission denied/);
  });

  test.each(["id = id", "tenant_id = tenant_id", "reported_at = now()", "reported_by = 'staff:y'"])("and %s is not the application role's to change", async (set) => {
    const id = await reported();
    await expect(asApp(db, TENANT_A, (c) => c.query(`UPDATE breach_incidents SET ${set} WHERE id = $1`, [id]))).rejects.toThrow(/permission denied/);
  });

  test("it may write the columns of the workflow", async () => {
    const id = await reported();
    const r = await asApp(db, TENANT_A, (c) => c.query("UPDATE breach_incidents SET title = 'A new title' WHERE id = $1", [id]));
    expect(r.rowCount).toBe(1);
  });
});

describe("what a record must hold", () => {
  const insert = (set: string) =>
    db.owner.query(`INSERT INTO breach_incidents (${FIELDS}) SELECT $1, $2, title, description, discovered_at, occurred_at, nature, data_categories, approx_principals, likely_consequences, measures_taken, reported_by FROM breach_incidents WHERE FALSE`, [uid("a", 1), TENANT_A]).then(() => set);
  void insert;
  test.each([
    ["an empty title", "title = ' '"],
    ["a title over 120 characters", `title = '${"x".repeat(121)}'`],
    ["an empty description", "description = ''"],
    ["a description over 4000 characters", `description = '${"x".repeat(4001)}'`],
    ["no nature", "nature = '{}'"],
    ["an unknown nature", "nature = '{theft}'"],
    ["no data categories", "data_categories = '{}'"],
    ["more than 20 data categories", `data_categories = '{${Array.from({ length: 21 }, (_, i) => `c${String(i)}`).join(",")}}'`],
    ["a negative number of people", "approx_principals = -1"],
    ["an empty consequences text", "likely_consequences = ' '"],
    ["an empty measures text", "measures_taken = ''"],
    ["an occurrence after the discovery", "occurred_at = discovered_at + interval '1 minute'"],
  ])("refuses %s", async (_n, set) => {
    const id = await reported();
    await fails(`UPDATE breach_incidents SET ${set} WHERE id = $1`, [id], /check constraint/);
  });

  test("accepts no number of people and no occurrence time", async () => {
    const id = await reported();
    await db.owner.query("UPDATE breach_incidents SET approx_principals = NULL, occurred_at = NULL WHERE id = $1", [id]);
  });

  test("the facts of a step cannot exist before the incident reaches it", async () => {
    const id = await reported();
    await fails("UPDATE breach_incidents SET board_notified_at = now(), board_reference = 'x' WHERE id = $1", [id], /check constraint|written once/);
    await fails("UPDATE breach_incidents SET signed_off_at = now(), signed_off_by = 'x' WHERE id = $1", [id], /check constraint|written once/);
    await fails(`UPDATE breach_incidents SET ${TOLD} WHERE id = $1`, [id], /check constraint|written once/);
    await fails(`UPDATE breach_incidents SET ${CLOSE} WHERE id = $1`, [id], /check constraint|illegal/);
  });

  test("an incident that is not reported cannot be inserted", async () => {
    await fails(
      `INSERT INTO breach_incidents (${FIELDS}, state, signed_off_at, signed_off_by, signed_off_board_sha256, signed_off_principal_sha256)
       VALUES ($1, $2, 't', 'd', now(), NULL, '{integrity}', '{x}', NULL, 'c', 'm', 'staff:x', 'signed_off', now(), 'x', $3, $4)`,
      [uid("a", 996), TENANT_A, H("a"), H("b")],
      /starts as reported/,
    );
  });
});

describe("the one-way workflow, enforced by the database", () => {
  test("every state pair agrees with the TypeScript state machine", async () => {
    for (const from of BREACH_STATES) {
      for (const to of BREACH_STATES) {
        if (from === to) continue;
        const id = await at(from, from === "board_notified");
        const set = to === "signed_off" ? SIGN : to === "board_notified" ? BOARD : to === "closed" ? CLOSE : "state = 'reported'";
        let ok = true;
        try {
          await db.owner.query(`UPDATE breach_incidents SET ${set} WHERE id = $1`, to === "signed_off" ? [id, H("c"), H("d")] : [id]);
        } catch {
          ok = false;
        }
        expect({ from, to, ok }).toEqual({ from, to, ok: canTransition(from, to) });
      }
    }
  });

  test("closing needs the affected people to have been told", async () => {
    const id = await at("board_notified", false);
    await fails(`UPDATE breach_incidents SET ${CLOSE} WHERE id = $1`, [id], /check constraint/);
    await db.owner.query(`UPDATE breach_incidents SET ${TOLD} WHERE id = $1`, [id]);
    await db.owner.query(`UPDATE breach_incidents SET ${CLOSE} WHERE id = $1`, [id]);
  });

  test("what was reported can be corrected only until sign-off", async () => {
    const before = await at("reported");
    await db.owner.query("UPDATE breach_incidents SET description = 'Corrected', nature = '{confidentiality,integrity}' WHERE id = $1", [before]);
    for (const state of ["signed_off", "board_notified", "closed"] as const) {
      const id = await at(state);
      for (const set of ["title = 'x'", "description = 'x'", "discovered_at = now()", "occurred_at = NULL", "nature = '{integrity}'", "data_categories = '{y}'", "approx_principals = 1", "likely_consequences = 'x'", "measures_taken = 'x'"]) {
        await fails(`UPDATE breach_incidents SET ${set} WHERE id = $1`, [id], /cannot change once it has been signed off/);
      }
    }
  });

  test("a step's facts are written once: not before, not again, not by another move", async () => {
    const signed = await at("signed_off");
    await fails("UPDATE breach_incidents SET signed_off_by = 'someone else' WHERE id = $1", [signed], /written once/);
    await fails("UPDATE breach_incidents SET signed_off_board_sha256 = $2 WHERE id = $1", [signed, H("f")], /written once/);
    await fails("UPDATE breach_incidents SET board_reference = 'x' WHERE id = $1", [signed], /written once|check constraint/);
    const board = await at("board_notified");
    await fails("UPDATE breach_incidents SET board_reference = 'DPB-999' WHERE id = $1", [board], /written once/);
    await fails("UPDATE breach_incidents SET board_notified_at = now() - interval '1 day' WHERE id = $1", [board], /written once/);
    const closed = await at("closed");
    await fails("UPDATE breach_incidents SET closing_note = 'Changed my mind' WHERE id = $1", [closed], /written once/);
    await fails("UPDATE breach_incidents SET closed_at = now() WHERE id = $1", [closed], /written once/);
  });

  test("the affected people are told once, after sign-off and before the incident is closed", async () => {
    await fails(`UPDATE breach_incidents SET ${TOLD} WHERE id = $1`, [await at("reported")], /check constraint|written once/);
    const signed = await at("signed_off");
    await db.owner.query(`UPDATE breach_incidents SET ${TOLD} WHERE id = $1`, [signed]);
    await fails("UPDATE breach_incidents SET principals_count = 5 WHERE id = $1", [signed], /written once/);
    const board = await at("board_notified");
    await db.owner.query(`UPDATE breach_incidents SET ${TOLD} WHERE id = $1`, [board]);
    await fails(`UPDATE breach_incidents SET principals_how = 'again' WHERE id = $1`, [board], /written once/);
    const closed = await at("closed");
    await fails("UPDATE breach_incidents SET principals_count = 1 WHERE id = $1", [closed], /written once/);
  });

  test("the notice to the affected people cannot be written together with a move, and is all or nothing", async () => {
    const signed = await at("signed_off");
    await fails(`UPDATE breach_incidents SET ${BOARD}, ${TOLD} WHERE id = $1`, [signed], /written once/);
    await fails("UPDATE breach_incidents SET principals_notified_at = now() WHERE id = $1", [signed], /check constraint/);
  });

  test("who reported an incident, and when, never changes, not even for the owner", async () => {
    const id = await reported();
    await fails("UPDATE breach_incidents SET reported_by = 'staff:y' WHERE id = $1", [id], /cannot change/);
    await fails("UPDATE breach_incidents SET reported_at = now() - interval '1 day' WHERE id = $1", [id], /cannot change/);
  });

  test("the hashes recorded at sign-off must be hashes", async () => {
    const id = await reported();
    await fails(`UPDATE breach_incidents SET ${SIGN} WHERE id = $1`, [id, "not-a-hash", H("b")], /check constraint/);
  });
});
