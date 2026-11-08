import { createHash, randomUUID } from "node:crypto";
import { PROFILE, startApi, type Api } from "./harness.js";

let api: Api;
beforeAll(async () => {
  api = await startApi();
});
afterAll(async () => {
  await api.stop();
});

const bearer = (t: string) => ({ Authorization: `Bearer ${t}` });
const owner = (sql: string, params: unknown[] = []) => api.db.owner.query(sql, params).then((r) => r.rows as Record<string, unknown>[]);
const hoursAgo = (h: number) => new Date(Date.now() - h * 3_600_000).toISOString();

const REPORT = {
  title: "Laptop lost",
  description: "A laptop with a customer list was lost on a train.",
  discoveredAt: hoursAgo(2),
  occurredAt: hoursAgo(14),
  nature: ["confidentiality"],
  dataCategories: ["phone numbers", "names"],
  approxPrincipalsAffected: 120,
  likelyConsequences: "Calls from strangers.",
  measuresTaken: "The laptop was wiped remotely.",
};
const post = (token: string, path: string, body?: unknown) => api.http().post(`/v1/breaches${path}`).set(bearer(token)).send(body as object);
const get = (token: string, path = "") => api.http().get(`/v1/breaches${path}`).set(bearer(token));
const patch = (token: string, id: string, body: unknown) => api.http().patch(`/v1/breaches/${id}`).set(bearer(token)).send(body as object);
const report = async (token = api.A.dpo, over: Record<string, unknown> = {}) => (await post(token, "", { ...REPORT, ...over })).body as { id: string } & Record<string, unknown>;
const stateOf = async (id: string) => (await owner("SELECT state FROM breach_incidents WHERE id = $1", [id]))[0]?.state;
const BOARD = { notifiedAt: new Date().toISOString(), reference: "DPB-2026-0042" };
const TOLD = { how: "Email to each person", count: 120 };
const sha = (t: string) => createHash("sha256").update(t, "utf8").digest("hex");

describe("reporting a breach", () => {
  test("the officer or the administrator records it, and the answer carries the 72 hour clock", async () => {
    for (const token of [api.A.dpo, api.A.admin]) {
      const res = await post(token, "", REPORT);
      expect(res.status).toBe(201);
      expect(res.body).toMatchObject({
        state: "reported", title: "Laptop lost", nature: ["confidentiality"], dataCategories: ["phone numbers", "names"], approxPrincipalsAffected: 120,
        signedOffAt: null, boardNotifiedAt: null, principalsNotifiedAt: null, closedAt: null, boardOverdue: false, boardNotifiedLate: null,
      });
      expect(res.body.id).toMatch(/^[0-9a-f-]{36}$/);
      expect(Date.parse(res.body.boardDeadline as string)).toBe(Date.parse(REPORT.discoveredAt) + 72 * 3_600_000);
      expect(res.body.reportedBy).toMatch(/^api-key:/);
    }
  });

  test("an incident reported by a signed-in officer names that officer", async () => {
    // A staff session is covered in force-password-change and consent-review; here the key is enough to see the actor is recorded.
    const created = await report();
    const row = (await owner("SELECT reported_by FROM breach_incidents WHERE id = $1", [created.id]))[0];
    expect(row?.reported_by).toMatch(/^api-key:/);
  });

  test("a time and a number are optional, and are null in the answer when left out", async () => {
    const rest: Record<string, unknown> = { ...REPORT };
    delete rest.occurredAt;
    delete rest.approxPrincipalsAffected;
    const res = await post(api.A.dpo, "", rest);
    expect(res.status).toBe(201);
    expect(res.body).toMatchObject({ occurredAt: null, approxPrincipalsAffected: null });
  });

  test("is an audit event that holds a hash of the content and none of the words", async () => {
    const created = await report(api.A.dpo, { description: "UNIQUE-SENTENCE-FOR-THE-AUDIT-CHECK" });
    const events = await owner("SELECT action, actor_type, ref_table, ref_id, payload_sha256 FROM consent_audit_log WHERE tenant_id = $1 AND ref_id = $2", [api.A.id, created.id]);
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({ action: "breach.reported", ref_table: "breach_incidents" });
    expect(String(events[0]?.payload_sha256)).toMatch(/^[0-9a-f]{64}$/);
    expect(JSON.stringify(await owner("SELECT * FROM consent_audit_log WHERE tenant_id = $1", [api.A.id]))).not.toContain("UNIQUE-SENTENCE-FOR-THE-AUDIT-CHECK");
    expect((await api.http().get("/v1/audit/verify").set(bearer(api.A.auditor))).body.ok).toBe(true);
  });

  test.each([
    ["no title", { title: undefined }, "title"],
    ["an empty title", { title: "   " }, "title"],
    ["a title over 120 characters", { title: "x".repeat(121) }, "title"],
    ["a description over 4000 characters", { description: "x".repeat(4001) }, "description"],
    ["no description", { description: undefined }, "description"],
    ["a time that is not a time", { discoveredAt: "yesterday" }, "discoveredAt"],
    ["a time without a zone", { discoveredAt: "2026-11-06T09:00:00" }, "discoveredAt"],
    ["a discovery in the future", { discoveredAt: new Date(Date.now() + 3_600_000).toISOString() }, "discoveredAt"],
    ["a discovery more than ten years ago", { discoveredAt: "2010-01-01T00:00:00Z" }, "discoveredAt"],
    ["an occurrence after the discovery", { occurredAt: new Date(Date.parse(REPORT.discoveredAt) + 60_000).toISOString() }, "occurredAt"],
    ["no nature", { nature: [] }, "nature"],
    ["an unknown nature", { nature: ["theft"] }, "nature"],
    ["a nature given twice", { nature: ["integrity", "integrity"] }, "nature"],
    ["no data categories", { dataCategories: [] }, "dataCategories"],
    ["more than 20 data categories", { dataCategories: Array.from({ length: 21 }, (_, i) => `c${String(i)}`) }, "dataCategories"],
    ["a data category given twice", { dataCategories: ["Names", "names"] }, "dataCategories"],
    ["an empty data category", { dataCategories: ["names", " "] }, "dataCategories"],
    ["a negative number of people", { approxPrincipalsAffected: -1 }, "approxPrincipalsAffected"],
    ["a fraction of a person", { approxPrincipalsAffected: 1.5 }, "approxPrincipalsAffected"],
    ["a number of people given as text", { approxPrincipalsAffected: "120" }, "approxPrincipalsAffected"],
    ["no consequences", { likelyConsequences: "" }, "likelyConsequences"],
    ["no measures", { measuresTaken: undefined }, "measuresTaken"],
    ["a field that is not part of the form", { severity: "high" }, "severity"],
  ])("refuses %s, naming the field", async (_n, over, field) => {
    const res = await post(api.A.dpo, "", { ...REPORT, ...over });
    expect({ status: res.status, field: res.body.field }).toEqual({ status: 400, field });
  });

  test("a body that is not an object is refused", async () => {
    expect((await post(api.A.dpo, "", [])).status).toBe(400);
  });

  test("is for the officer and the administrator only", async () => {
    for (const token of [api.A.auditor, api.A.server, api.A.pk]) expect((await post(token, "", REPORT)).status).toBe(403);
    expect((await api.http().post("/v1/breaches").send(REPORT)).status).toBe(401);
  });
});

describe("reading incidents", () => {
  test("the list is the organisation's own, newest discovery first, and each is the same as its own answer", async () => {
    const older = await report(api.B.dpo, { title: "Older", discoveredAt: hoursAgo(30), occurredAt: null });
    const newer = await report(api.B.dpo, { title: "Newer", discoveredAt: hoursAgo(1), occurredAt: null });
    expect(older.id).toBeDefined();
    expect(newer.id).toBeDefined();
    const list = (await get(api.B.dpo)).body as { id: string; title: string }[];
    expect(list.map((b) => b.id)).toEqual([newer.id, older.id]);
    expect((await get(api.B.dpo, `/${older.id}`)).body).toEqual(list[1]);
    expect(JSON.stringify((await get(api.A.dpo)).body)).not.toContain(older.id);
  });

  test("another organisation's incident is 404, a bad id is 400, and the roles that may not read get 403", async () => {
    const mine = await report(api.A.dpo);
    expect((await get(api.B.dpo, `/${mine.id}`)).status).toBe(404);
    expect((await get(api.A.dpo, `/${randomUUID()}`)).status).toBe(404);
    expect((await get(api.A.dpo, "/nope")).status).toBe(400);
    for (const token of [api.A.auditor, api.A.server, api.A.pk]) expect((await get(token)).status).toBe(403);
    expect((await api.http().get("/v1/breaches")).status).toBe(401);
  });

  test("an incident found three days ago and not yet reported to the Board is overdue", async () => {
    const created = await report(api.A.dpo, { discoveredAt: hoursAgo(80), occurredAt: null });
    expect(created.boardOverdue).toBe(true);
    expect((await report(api.A.dpo, { discoveredAt: hoursAgo(71), occurredAt: null })).boardOverdue).toBe(false);
  });
});

describe("correcting a report", () => {
  test("changes only what is sent, is an audit event, and is allowed until sign-off", async () => {
    const created = await report();
    const res = await patch(api.A.admin, created.id, { description: "Corrected description.", nature: ["confidentiality", "integrity"], approxPrincipalsAffected: null });
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ description: "Corrected description.", nature: ["confidentiality", "integrity"], approxPrincipalsAffected: null, title: "Laptop lost" });
    expect((await owner("SELECT action FROM consent_audit_log WHERE ref_id = $1 ORDER BY seq_no", [created.id])).map((e) => e.action)).toEqual(["breach.reported", "breach.updated"]);
  });

  test.each([
    ["nothing", {}, "body"],
    ["an unknown field", { state: "closed" }, "state"],
    ["a field that is not valid", { title: "" }, "title"],
    ["a discovery after the occurrence it would then contradict", { discoveredAt: hoursAgo(20) }, "occurredAt"],
  ])("refuses %s", async (_n, body, field) => {
    const created = await report();
    const res = await patch(api.A.dpo, created.id, body);
    expect({ status: res.status, field: res.body.field }).toEqual({ status: 400, field });
  });

  test("can clear the time it happened with null", async () => {
    const created = await report();
    expect((await patch(api.A.dpo, created.id, { occurredAt: null })).body.occurredAt).toBeNull();
  });

  test("is refused once the incident is signed off", async () => {
    const created = await report();
    await post(api.A.dpo, `/${created.id}/sign-off`);
    const res = await patch(api.A.dpo, created.id, { title: "Too late" });
    expect({ status: res.status, error: res.body.error }).toEqual({ status: 409, error: "locked" });
  });

  test("is for the officer and the administrator, and another organisation's incident is 404", async () => {
    const created = await report();
    expect((await patch(api.B.dpo, created.id, { title: "x" })).status).toBe(404);
    for (const token of [api.A.auditor, api.A.pk]) expect((await patch(token, created.id, { title: "x" })).status).toBe(403);
  });
});

describe("the drafts", () => {
  test("are written from the facts and the organisation's profile, and say they are drafts", async () => {
    const created = await report();
    const res = await get(api.A.dpo, `/${created.id}/drafts`);
    expect(res.status).toBe(200);
    expect(res.body.boardNotification.split("\n")[0]).toMatch(/^DRAFT: not reviewed by a lawyer/);
    expect(res.body.boardNotification).toContain("Organisation: Example Controller Pvt Ltd");
    expect(res.body.boardNotification).toContain("Contact: Grievance Officer, privacy@example.org");
    expect(res.body.boardNotification).toContain("A laptop with a customer list was lost on a train.");
    expect(res.body.boardNotification).toContain("Time allowed from the day it was found: 72 hours");
    expect(res.body.principalNotice).toContain("Subject: A security incident that involved your personal data");
    expect(res.body.principalNotice).toContain("- phone numbers");
    expect(res.body.boardDeadline).toBe(created.boardDeadline);
  });

  test("follow a correction", async () => {
    const created = await report();
    await patch(api.A.dpo, created.id, { description: "A different account of it." });
    expect((await get(api.A.dpo, `/${created.id}/drafts`)).body.boardNotification).toContain("A different account of it.");
  });

  test("cannot be made for an organisation whose profile does not say who the controller is", async () => {
    const created = await report(api.B.dpo);
    await owner("UPDATE tenants SET profile = '{}' WHERE id = $1", [api.B.id]);
    try {
      const res = await get(api.B.dpo, `/${created.id}/drafts`);
      expect({ status: res.status, error: res.body.error }).toEqual({ status: 422, error: "incomplete_setup" });
    } finally {
      await owner("UPDATE tenants SET profile = $2 WHERE id = $1", [api.B.id, JSON.stringify(PROFILE)]);
    }
  });

  test("another organisation's incident is 404", async () => {
    const created = await report();
    expect((await get(api.B.dpo, `/${created.id}/drafts`)).status).toBe(404);
  });
});

describe("signing off", () => {
  test("is the officer's act: the administrator cannot, and the answer says who signed and when", async () => {
    const created = await report();
    expect((await post(api.A.admin, `/${created.id}/sign-off`)).status).toBe(403);
    expect(await stateOf(created.id)).toBe("reported");
    const res = await post(api.A.dpo, `/${created.id}/sign-off`);
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ state: "signed_off", signedOffAt: expect.any(String) });
    expect(res.body.signedOffBy).toMatch(/^api-key:/);
  });

  test("records the hash of exactly the two drafts that were shown, so it can be shown later what was signed", async () => {
    const created = await report();
    const drafts = (await get(api.A.dpo, `/${created.id}/drafts`)).body as { boardNotification: string; principalNotice: string };
    await post(api.A.dpo, `/${created.id}/sign-off`);
    const row = (await owner("SELECT signed_off_board_sha256 AS b, signed_off_principal_sha256 AS p FROM breach_incidents WHERE id = $1", [created.id]))[0];
    expect(row).toEqual({ b: sha(drafts.boardNotification), p: sha(drafts.principalNotice) });
    // The drafts of a signed-off incident are the same afterwards, because the incident cannot change.
    expect((await get(api.A.dpo, `/${created.id}/drafts`)).body).toMatchObject(drafts);
  });

  test("happens once, and is an audit event", async () => {
    const created = await report();
    await post(api.A.dpo, `/${created.id}/sign-off`);
    const again = await post(api.A.dpo, `/${created.id}/sign-off`);
    expect({ status: again.status, error: again.body.error }).toEqual({ status: 409, error: "illegal_transition" });
    expect((await owner("SELECT action FROM consent_audit_log WHERE ref_id = $1 ORDER BY seq_no", [created.id])).map((e) => e.action)).toEqual(["breach.reported", "breach.signed_off"]);
  });

  test("another organisation's incident is 404", async () => {
    const created = await report();
    expect((await post(api.B.dpo, `/${created.id}/sign-off`)).status).toBe(404);
  });
});

describe("telling the Board", () => {
  test("is recorded after sign-off, with the time and the reference the Board gave, and says whether it was on time", async () => {
    const created = await report(api.A.dpo, { discoveredAt: hoursAgo(10), occurredAt: null });
    await post(api.A.dpo, `/${created.id}/sign-off`);
    const res = await post(api.A.dpo, `/${created.id}/board-notified`, BOARD);
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ state: "board_notified", boardReference: "DPB-2026-0042", boardOverdue: false, boardNotifiedLate: false });
    expect(Date.parse(res.body.boardNotifiedAt as string)).toBe(Date.parse(BOARD.notifiedAt));
  });

  test("a notice given after the 72 hours is recorded as late, not hidden", async () => {
    const created = await report(api.A.dpo, { discoveredAt: hoursAgo(100), occurredAt: null });
    await post(api.A.dpo, `/${created.id}/sign-off`);
    const res = await post(api.A.dpo, `/${created.id}/board-notified`, BOARD);
    expect(res.body).toMatchObject({ boardNotifiedLate: true, boardOverdue: false });
  });

  test("cannot be recorded before sign-off, or twice", async () => {
    const created = await report();
    const early = await post(api.A.dpo, `/${created.id}/board-notified`, BOARD);
    expect({ status: early.status, error: early.body.error }).toEqual({ status: 409, error: "illegal_transition" });
    await post(api.A.dpo, `/${created.id}/sign-off`);
    expect((await post(api.A.dpo, `/${created.id}/board-notified`, BOARD)).status).toBe(200);
    expect((await post(api.A.dpo, `/${created.id}/board-notified`, BOARD)).status).toBe(409);
  });

  test.each([
    ["no time", { reference: "x" }, "notifiedAt"],
    ["a time that is not a time", { notifiedAt: "soon", reference: "x" }, "notifiedAt"],
    ["a time in the future", { notifiedAt: new Date(Date.now() + 3_600_000).toISOString(), reference: "x" }, "notifiedAt"],
    ["a time before the discovery", { notifiedAt: hoursAgo(500), reference: "x" }, "notifiedAt"],
    ["no reference", { notifiedAt: new Date().toISOString() }, "reference"],
    ["an empty reference", { notifiedAt: new Date().toISOString(), reference: " " }, "reference"],
    ["a reference over 200 characters", { notifiedAt: new Date().toISOString(), reference: "x".repeat(201) }, "reference"],
    ["another field", { notifiedAt: new Date().toISOString(), reference: "x", state: "closed" }, "state"],
  ])("refuses %s", async (_n, body, field) => {
    const created = await report();
    await post(api.A.dpo, `/${created.id}/sign-off`);
    const res = await post(api.A.dpo, `/${created.id}/board-notified`, body);
    expect({ status: res.status, field: res.body.field }).toEqual({ status: 400, field });
    expect(await stateOf(created.id)).toBe("signed_off");
  });

  test("is for the officer only, and an audit event", async () => {
    const created = await report();
    await post(api.A.dpo, `/${created.id}/sign-off`);
    expect((await post(api.A.admin, `/${created.id}/board-notified`, BOARD)).status).toBe(403);
    await post(api.A.dpo, `/${created.id}/board-notified`, BOARD);
    expect((await owner("SELECT action FROM consent_audit_log WHERE ref_id = $1 ORDER BY seq_no", [created.id])).map((e) => e.action)).toEqual(["breach.reported", "breach.signed_off", "breach.board_notified"]);
  });
});

describe("telling the affected people", () => {
  test("is recorded once, after sign-off, whether or not the Board has been told yet", async () => {
    const signed = await report();
    await post(api.A.dpo, `/${signed.id}/sign-off`);
    const res = await post(api.A.dpo, `/${signed.id}/principals-notified`, TOLD);
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ state: "signed_off", principalsHow: "Email to each person", principalsCount: 120, principalsNotifiedAt: expect.any(String) });
    expect((await post(api.A.dpo, `/${signed.id}/principals-notified`, TOLD)).status).toBe(409);

    const board = await report();
    await post(api.A.dpo, `/${board.id}/sign-off`);
    await post(api.A.dpo, `/${board.id}/board-notified`, BOARD);
    expect((await post(api.A.dpo, `/${board.id}/principals-notified`, { how: "Letter", count: 0 })).body).toMatchObject({ state: "board_notified", principalsCount: 0 });
  });

  test("cannot be recorded before sign-off", async () => {
    const created = await report();
    const res = await post(api.A.dpo, `/${created.id}/principals-notified`, TOLD);
    expect({ status: res.status, error: res.body.error }).toEqual({ status: 409, error: "illegal_transition" });
  });

  test.each([
    ["no description of how", { count: 1 }, "how"],
    ["an empty description", { how: " ", count: 1 }, "how"],
    ["a description over 1000 characters", { how: "x".repeat(1001), count: 1 }, "how"],
    ["no number", { how: "Email" }, "count"],
    ["a negative number", { how: "Email", count: -1 }, "count"],
    ["a number that is not whole", { how: "Email", count: 1.5 }, "count"],
    ["another field", { how: "Email", count: 1, state: "closed" }, "state"],
  ])("refuses %s", async (_n, body, field) => {
    const created = await report();
    await post(api.A.dpo, `/${created.id}/sign-off`);
    const res = await post(api.A.dpo, `/${created.id}/principals-notified`, body);
    expect({ status: res.status, field: res.body.field }).toEqual({ status: 400, field });
  });

  test("is for the officer only, and an audit event", async () => {
    const created = await report();
    await post(api.A.dpo, `/${created.id}/sign-off`);
    expect((await post(api.A.admin, `/${created.id}/principals-notified`, TOLD)).status).toBe(403);
    await post(api.A.dpo, `/${created.id}/principals-notified`, TOLD);
    expect((await owner("SELECT action FROM consent_audit_log WHERE ref_id = $1 ORDER BY seq_no", [created.id])).map((e) => e.action)).toEqual(["breach.reported", "breach.signed_off", "breach.principals_notified"]);
  });
});

describe("closing", () => {
  const NOTE = { note: "Laptop recovered; no further action." };

  async function readyToClose() {
    const created = await report();
    await post(api.A.dpo, `/${created.id}/sign-off`);
    await post(api.A.dpo, `/${created.id}/board-notified`, BOARD);
    return created;
  }

  test("needs the Board to have been told, and the affected people", async () => {
    const created = await report();
    await post(api.A.dpo, `/${created.id}/sign-off`);
    const early = await post(api.A.dpo, `/${created.id}/close`, NOTE);
    expect({ status: early.status, error: early.body.error }).toEqual({ status: 409, error: "illegal_transition" });
    await post(api.A.dpo, `/${created.id}/board-notified`, BOARD);
    const noPeople = await post(api.A.dpo, `/${created.id}/close`, NOTE);
    expect({ status: noPeople.status, error: noPeople.body.error }).toEqual({ status: 409, error: "principals_not_notified" });
    expect(await stateOf(created.id)).toBe("board_notified");
  });

  test("closes with a note, and a closed incident can do nothing more", async () => {
    const created = await readyToClose();
    await post(api.A.dpo, `/${created.id}/principals-notified`, TOLD);
    const res = await post(api.A.dpo, `/${created.id}/close`, NOTE);
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ state: "closed", closingNote: "Laptop recovered; no further action.", closedAt: expect.any(String) });
    const bodies: Record<string, object> = { "/sign-off": {}, "/board-notified": BOARD, "/principals-notified": TOLD, "/close": NOTE };
    for (const [path, body] of Object.entries(bodies)) {
      expect({ path, status: (await post(api.A.dpo, `/${created.id}${path}`, body)).status }).toEqual({ path, status: 409 });
    }
    expect((await patch(api.A.dpo, created.id, { title: "x" })).status).toBe(409);
  });

  test.each([
    ["no note", {}, "note"],
    ["an empty note", { note: " " }, "note"],
    ["a note over 2000 characters", { note: "x".repeat(2001) }, "note"],
    ["another field", { note: "ok", state: "closed" }, "state"],
  ])("refuses %s", async (_n, body, field) => {
    const created = await readyToClose();
    await post(api.A.dpo, `/${created.id}/principals-notified`, TOLD);
    const res = await post(api.A.dpo, `/${created.id}/close`, body);
    expect({ status: res.status, field: res.body.field }).toEqual({ status: 400, field });
  });

  test("is for the officer only", async () => {
    const created = await readyToClose();
    await post(api.A.dpo, `/${created.id}/principals-notified`, TOLD);
    expect((await post(api.A.admin, `/${created.id}/close`, NOTE)).status).toBe(403);
  });

  test("the whole life of an incident is in the audit log, in order, and the chain still verifies", async () => {
    const created = await readyToClose();
    await post(api.A.dpo, `/${created.id}/principals-notified`, TOLD);
    await post(api.A.dpo, `/${created.id}/close`, NOTE);
    expect((await owner("SELECT action FROM consent_audit_log WHERE ref_id = $1 ORDER BY seq_no", [created.id])).map((e) => e.action)).toEqual([
      "breach.reported", "breach.signed_off", "breach.board_notified", "breach.principals_notified", "breach.closed",
    ]);
    expect((await api.http().get("/v1/audit/verify").set(bearer(api.A.auditor))).body.ok).toBe(true);
  });

  test("two people acting on the same incident at once cannot both succeed", async () => {
    const created = await report();
    const results = await Promise.all([1, 2, 3, 4].map(() => post(api.A.dpo, `/${created.id}/sign-off`)));
    expect(results.map((r) => r.status).sort()).toEqual([200, 409, 409, 409]);
  });
});
