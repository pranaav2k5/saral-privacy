import { createHash, randomUUID } from "node:crypto";
import { canonicalRopa, parseRopaDocument } from "../../src/ropa/ropa-document.js";
import { startApi, type Api } from "./harness.js";

let api: Api;
beforeAll(async () => {
  api = await startApi();
});
afterAll(async () => {
  await api.stop();
});

const bearer = (t: string) => ({ Authorization: `Bearer ${t}` });
const owner = (sql: string, params: unknown[] = []) => api.db.owner.query(sql, params).then((r) => r.rows as Record<string, unknown>[]);
const sha = (t: string) => createHash("sha256").update(t, "utf8").digest("hex");

const activity = (over: Record<string, unknown> = {}) => ({
  name: "Customer support", description: "We answer questions that customers send us.", purposes: ["Answer customer questions"], legalBasis: "consent", principals: ["customers"],
  personalData: ["name", "email address"], involvesChildren: false, source: "directly_from_person", recipients: [{ name: "Helpdesk Cloud Ltd", role: "processor", country: "IN" }],
  crossBorder: false, transferCountries: [], retention: "12 months after the last message", securityMeasures: ["encryption_in_transit", "access_control"], storage: "Helpdesk Cloud, Mumbai region", owner: "Support team", ...over,
});
const doc = (over: Record<string, unknown> = {}) => ({
  schema: "saral.ropa/1",
  organisation: { name: "Example Controller Pvt Ltd", address: "1 Example Road, Bengaluru 560001", contactName: "Grievance Officer", contactEmail: "privacy@example.org", sector: "Software", significantDataFiduciary: "no" },
  review: { lastReviewedOn: "2026-11-01" },
  activities: [activity()],
  ...over,
});
const save = (token: string, document: unknown, note?: unknown, basedOn?: unknown) =>
  api.http().post("/v1/ropa").set(bearer(token)).send({ document, ...(note === undefined ? {} : { note }), ...(basedOn === undefined ? {} : { basedOn }) } as object);
const get = (token: string, path = "") => api.http().get(`/v1/ropa${path}`).set(bearer(token));
let n = 0;
/** A record that differs from every other one in this file, so saving it is always a change. */
const distinct = () => doc({ notes: `Version written by test ${String(n++)}.` });

describe("saving a version of the record", () => {
  test("the officer or the administrator saves it, and each save is the next version", async () => {
    const a = await save(api.A.dpo, distinct(), "First draft");
    expect(a.status).toBe(201);
    expect(a.body).toMatchObject({ version: 1, note: "First draft" });
    expect(a.body.id).toMatch(/^[0-9a-f-]{36}$/);
    expect(a.body.sha256).toMatch(/^[0-9a-f]{64}$/);
    expect(a.body.createdBy).toMatch(/^api-key:/);
    const b = await save(api.A.admin, distinct());
    expect(b.status).toBe(201);
    expect(b.body).toMatchObject({ version: 2, note: null });
  });

  test("keeps the record in its canonical form, with a hash that is the hash of exactly that text", async () => {
    const original = doc({ notes: "  Canonical check.  ", activities: [activity({ securityMeasures: ["access_control", "encryption_in_transit"] })] });
    const res = await save(api.A.dpo, original);
    const canonical = canonicalRopa(parseRopaDocument(original));
    expect(res.body.sha256).toBe(sha(canonical));
    const stored = (await owner("SELECT document_json, document_sha256 FROM ropa_versions WHERE id = $1", [res.body.id]))[0];
    expect(stored).toEqual({ document_json: canonical, document_sha256: sha(canonical) });
  });

  test("a save that changes nothing is not a new version, whatever its note says", async () => {
    const d = distinct();
    const first = await save(api.A.dpo, d);
    const again = await save(api.A.dpo, d, "No change at all");
    expect({ status: again.status, error: again.body.error }).toEqual({ status: 409, error: "unchanged" });
    expect(again.body.message).toContain(`version ${String(first.body.version)}`);
    expect((await get(api.A.dpo)).body[0].version).toBe(first.body.version);
  });

  test("the same record may come back after something else, because only the latest version is compared", async () => {
    const x = distinct();
    await save(api.A.dpo, x);
    await save(api.A.dpo, distinct());
    expect((await save(api.A.dpo, x)).status).toBe(201);
  });

  test("is an audit event holding the hash and none of the words", async () => {
    const d = doc({ notes: "UNIQUE-WORDS-FOR-THE-AUDIT-CHECK" });
    const res = await save(api.A.dpo, d);
    const events = await owner("SELECT action, ref_table, ref_id FROM consent_audit_log WHERE tenant_id = $1 AND ref_id = $2", [api.A.id, res.body.id]);
    expect(events).toEqual([{ action: "ropa.version_created", ref_table: "ropa_versions", ref_id: res.body.id }]);
    expect(JSON.stringify(await owner("SELECT * FROM consent_audit_log WHERE tenant_id = $1", [api.A.id]))).not.toContain("UNIQUE-WORDS-FOR-THE-AUDIT-CHECK");
    expect((await api.http().get("/v1/audit/verify").set(bearer(api.A.auditor))).body.ok).toBe(true);
  });

  test.each([
    ["no document", undefined, undefined, "document"],
    ["a document that is not an object", [], undefined, "document"],
    ["an activity with no name", doc({ activities: [activity({ name: "" })] }), undefined, "document.activities[0].name"],
    ["a transfer abroad that names no country", doc({ activities: [activity({ crossBorder: true, transferCountries: [] })] }), undefined, "document.activities[0].transferCountries"],
    ["a contact email that is not an email", doc({ organisation: { ...doc().organisation, contactEmail: "nope" } }), undefined, "document.organisation.contactEmail"],
    ["a review date in the future", doc({ review: { lastReviewedOn: "2999-01-01" } }), undefined, "document.review.lastReviewedOn"],
    ["a note that is blank", doc(), " ", "note"],
    ["a note over 500 characters", doc(), "x".repeat(501), "note"],
    ["a note that is not text", doc(), 5, "note"],
  ])("refuses %s, naming the field", async (_n, document, note, field) => {
    const res = await api.http().post("/v1/ropa").set(bearer(api.A.dpo)).send({ ...(document === undefined ? {} : { document }), ...(note === undefined ? {} : { note }) });
    expect({ status: res.status, field: res.body.field }).toEqual({ status: 400, field });
  });

  describe("saying which version a change started from", () => {
    const audited = async () => (await owner("SELECT count(*)::int AS n FROM consent_audit_log WHERE tenant_id = $1 AND action = 'ropa.version_created'", [api.A.id]))[0]?.n as number;

    test("is accepted when it is the newest version, and refused with 409 stale when another version has been saved since, saving and auditing nothing", async () => {
      const start = (await save(api.A.dpo, distinct())).body.version as number;
      const mine = await save(api.A.dpo, distinct(), undefined, start);
      expect({ status: mine.status, version: mine.body.version }).toEqual({ status: 201, version: start + 1 });
      const before = await audited();
      const late = await save(api.A.admin, distinct(), "Started from an old version", start);
      expect({ status: late.status, error: late.body.error, latest: late.body.latest }).toEqual({ status: 409, error: "stale", latest: start + 1 });
      expect(late.body.message).toContain(`version ${String(start + 1)}`);
      expect((await get(api.A.dpo)).body[0].version).toBe(start + 1);
      expect(await audited()).toBe(before);
    });

    test("0 means that nothing has been saved: accepted by an organisation with no versions, refused by one that has some", async () => {
      await owner("DELETE FROM ropa_versions WHERE tenant_id = $1", [api.B.id]);
      try {
        const ahead = await save(api.B.dpo, distinct(), undefined, 3);
        expect({ status: ahead.status, error: ahead.body.error, latest: ahead.body.latest }).toEqual({ status: 409, error: "stale", latest: 0 });
        const first = await save(api.B.dpo, distinct(), undefined, 0);
        expect({ status: first.status, version: first.body.version }).toEqual({ status: 201, version: 1 });
        const again = await save(api.B.dpo, distinct(), undefined, 0);
        expect({ status: again.status, error: again.body.error, latest: again.body.latest }).toEqual({ status: 409, error: "stale", latest: 1 });
      } finally {
        await owner("DELETE FROM ropa_versions WHERE tenant_id = $1", [api.B.id]);
      }
    });

    test("a change that started from an old version is stale even when it is the same as the newest, so the person reads what was saved", async () => {
      const d = distinct();
      const start = (await save(api.A.dpo, distinct())).body.version as number;
      await save(api.A.dpo, d);
      const res = await save(api.A.dpo, d, undefined, start);
      expect({ status: res.status, error: res.body.error }).toEqual({ status: 409, error: "stale" });
    });

    test("is optional: a save that does not say is the next version whatever the newest is", async () => {
      await save(api.A.dpo, distinct());
      expect((await save(api.A.dpo, distinct())).status).toBe(201);
    });

    test("two saves from the same version at once: one is saved and the other is stale", async () => {
      const start = (await save(api.A.dpo, distinct())).body.version as number;
      const results = await Promise.all([save(api.A.dpo, distinct(), undefined, start), save(api.A.admin, distinct(), undefined, start)]);
      expect(results.map((r) => r.status).sort()).toEqual([201, 409]);
      expect(results.find((r) => r.status === 409)?.body.error).toBe("stale");
      expect((await get(api.A.dpo)).body[0].version).toBe(start + 1);
    });

    test.each([["text", "3"], ["negative", -1], ["fraction", 1.5], ["above the limit", 201], ["null", null], ["true", true], ["a very large number", 1e21]])("a version number that is %s is 400, naming basedOn", async (_n, value) => {
      const res = await save(api.A.dpo, distinct(), undefined, value);
      expect({ status: res.status, field: res.body.field }).toEqual({ status: 400, field: "basedOn" });
    });
  });

  test("refuses a field that is not part of the request, and a body that is not an object", async () => {
    const extra = await api.http().post("/v1/ropa").set(bearer(api.A.dpo)).send({ document: distinct(), approved: true });
    expect({ status: extra.status, field: extra.body.field }).toEqual({ status: 400, field: "approved" });
    expect((await api.http().post("/v1/ropa").set(bearer(api.A.dpo)).send([])).status).toBe(400);
  });

  test("a record over 90 KiB is refused with the field named, and a large one under it is saved", async () => {
    const make = (i: number, purposes: number) => activity({ name: `A${String(i).padStart(2, "0")}`, description: "d", retention: "r".repeat(300), storage: "s".repeat(200), owner: "o".repeat(120), personalData: Array.from({ length: 20 }, (_, k) => `${"p".repeat(60)}${String(k).padStart(2, "0")}`), purposes: Array.from({ length: purposes }, (_, k) => `${"u".repeat(150)}${String(k)}`) });
    const sized = (purposes: number) => doc({ activities: Array.from({ length: 30 }, (_, i) => make(i, purposes)) });
    const bytes = (purposes: number) => Buffer.byteLength(JSON.stringify(sized(purposes)), "utf8");
    // Over the record's limit, but still inside the API's 100 KB request limit, so it is the record's own check that answers.
    expect(bytes(6)).toBeGreaterThan(90 * 1024);
    expect(bytes(6)).toBeLessThan(100_000);
    const over = await save(api.A.dpo, sized(6));
    expect({ status: over.status, field: over.body.field }).toEqual({ status: 400, field: "document" });
    expect(bytes(2)).toBeLessThan(90 * 1024);
    expect((await save(api.A.dpo, sized(2))).status).toBe(201);
  });

  test("is for the officer and the administrator only", async () => {
    for (const token of [api.A.auditor, api.A.server, api.A.pk]) expect((await save(token, distinct())).status).toBe(403);
    expect((await api.http().post("/v1/ropa").send({ document: distinct() })).status).toBe(401);
  });

  test("four saves at once give four different versions, with no failure", async () => {
    const results = await Promise.all([1, 2, 3, 4].map(() => save(api.B.dpo, distinct())));
    expect(results.map((r) => r.status)).toEqual([201, 201, 201, 201]);
    expect(results.map((r) => r.body.version).sort()).toEqual([1, 2, 3, 4]);
  });

  test("an organisation may keep at most 200 versions, and is told when it has reached them", async () => {
    await owner("DELETE FROM ropa_versions WHERE tenant_id = $1", [api.B.id]);
    await owner(
      `INSERT INTO ropa_versions (id, tenant_id, version, document_json, document_sha256, created_by)
       SELECT gen_random_uuid(), $1::uuid, g, '{"n":' || g || '}', encode(sha256(convert_to('{"n":' || g || '}', 'UTF8')), 'hex'), 'test' FROM generate_series(1, 199) g`,
      [api.B.id],
    );
    const last = await save(api.B.dpo, distinct());
    expect(last.body.version).toBe(200);
    const over = await save(api.B.dpo, distinct());
    expect({ status: over.status, error: over.body.error }).toEqual({ status: 409, error: "version_limit" });
    expect((await owner("SELECT count(*)::int AS n FROM ropa_versions WHERE tenant_id = $1", [api.B.id]))[0]?.n).toBe(200);
    await owner("DELETE FROM ropa_versions WHERE tenant_id = $1", [api.B.id]);
  });
});

describe("reading versions", () => {
  test("the list is the organisation's own, newest first, without the records", async () => {
    const list = (await get(api.A.dpo)).body as { version: number; sha256: string }[];
    expect(list.length).toBeGreaterThanOrEqual(3);
    expect(list.map((v) => v.version)).toEqual([...list.map((v) => v.version)].sort((a, b) => b - a));
    expect(Object.keys(list[0] as object).sort()).toEqual(["createdAt", "createdBy", "id", "note", "sha256", "version"]);
    expect(JSON.stringify(list)).not.toContain("Customer support");
  });

  test("the latest is the newest version with its record, and one version is found by its id", async () => {
    const saved = await save(api.A.dpo, distinct(), "Latest one");
    const latest = (await get(api.A.dpo, "/latest")).body;
    expect(latest).toMatchObject({ id: saved.body.id, version: saved.body.version, note: "Latest one" });
    expect(latest.document).toEqual(JSON.parse(canonicalRopa(parseRopaDocument(latest.document))));
    expect(sha(canonicalRopa(latest.document))).toBe(latest.sha256);
    expect((await get(api.A.dpo, `/${saved.body.id}`)).body).toEqual(latest);
  });

  test("an organisation that has saved nothing has no latest, and an empty list", async () => {
    await owner("DELETE FROM ropa_versions WHERE tenant_id = $1", [api.B.id]);
    expect((await get(api.B.dpo, "/latest")).status).toBe(404);
    expect((await get(api.B.dpo)).body).toEqual([]);
  });

  test("another organisation's version is 404, a bad id is 400, and the roles that may not read get 403", async () => {
    const mine = await save(api.A.dpo, distinct());
    expect((await get(api.B.dpo, `/${mine.body.id}`)).status).toBe(404);
    expect((await get(api.A.dpo, `/${randomUUID()}`)).status).toBe(404);
    expect((await get(api.A.dpo, "/nope")).status).toBe(400);
    for (const token of [api.A.auditor, api.A.server, api.A.pk]) {
      expect((await get(token)).status).toBe(403);
      expect((await get(token, "/latest")).status).toBe(403);
    }
    expect((await api.http().get("/v1/ropa")).status).toBe(401);
  });
});
