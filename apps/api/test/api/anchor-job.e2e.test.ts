import { mkdtempSync, readFileSync, rmSync, writeFileSync, chmodSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { anchorBody, buildAnchor, type Anchor, type ChainEntry } from "@saral/audit-chain";
import { AnchorJob } from "../../src/audit/anchor-job.js";
import { FileObjectStore, anchorKey, type ObjectStore } from "../../src/audit/object-store.js";
import { startApi, type Api } from "./harness.js";

let api: Api;
let job: AnchorJob;
let dir: string;
beforeAll(async () => {
  api = await startApi();
  job = api.app.get(AnchorJob);
  for (let i = 0; i < 3; i++) await api.grant(api.A, { identifier: `+91970000020${String(i)}` });
  await api.grant(api.B);
});
afterAll(async () => {
  await api.stop();
});
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "saral-anchors-"));
});
afterEach(() => {
  chmodSync(dir, 0o755);
  rmSync(dir, { recursive: true, force: true });
});

const TODAY = new Date().toISOString().slice(0, 10);
/** The day after, so that the day being anchored is over. */
const TOMORROW = new Date(Date.parse(`${TODAY}T00:00:00Z`) + 86_400_000 + 3_600_000);
const fileOf = (tenantId: string, date = TODAY) => join(dir, anchorKey(tenantId, date));
const entriesOf = async (tenantId: string) =>
  (await api.db.owner.query("SELECT * FROM consent_audit_log WHERE tenant_id = $1 ORDER BY seq_no", [tenantId])).rows.map((r: Record<string, unknown>) => ({
    tenantId: r.tenant_id, seqNo: r.seq_no, ts: (r.ts as Date).toISOString(), actorType: r.actor_type, actorId: r.actor_id, action: r.action, refTable: r.ref_table,
    refId: r.ref_id, payloadSha256: r.payload_sha256, prevHash: r.prev_hash, entryHash: r.entry_hash, canonicalSchemaVersion: r.canonical_schema_version, hmacSchemaVersion: r.hmac_schema_version,
  })) as ChainEntry[];

describe("the nightly anchor job", () => {
  test("writes one anchor for each organisation that has entries that day, byte for byte what the anchor library produces", async () => {
    const report = await job.run({ date: TODAY, store: new FileObjectStore(dir), now: TOMORROW });
    expect(report.failures).toEqual([]);
    expect(report.written).toBeGreaterThanOrEqual(2);
    const a = readFileSync(fileOf(api.A.id), "utf8");
    expect(a).toBe(anchorBody(buildAnchor(api.A.id, TODAY, await entriesOf(api.A.id))));
    expect(JSON.parse(a)).toMatchObject({ version: 1, tenantId: api.A.id, date: TODAY, count: 3, firstSeqNo: "1", lastSeqNo: "3" });
    expect(readFileSync(fileOf(api.B.id), "utf8")).toContain(`"tenantId":"${api.B.id}"`);
  });

  test("an anchor is the same as the one the API serves for that day", async () => {
    await job.run({ date: TODAY, store: new FileObjectStore(dir), now: TOMORROW });
    const served = (await api.http().get(`/v1/audit/merkle-root?date=${TODAY}`).set("Authorization", `Bearer ${api.A.auditor}`)).body as Anchor;
    expect(readFileSync(fileOf(api.A.id), "utf8")).toBe(anchorBody(served));
  });

  test("an organisation with no entries that day gets no anchor, and is counted as skipped", async () => {
    const report = await job.run({ date: "2000-01-01", store: new FileObjectStore(dir), now: TOMORROW });
    expect(report.written).toBe(0);
    expect(report.skipped).toBeGreaterThanOrEqual(2);
    expect(report.failures).toEqual([]);
  });

  test("running it again changes nothing: the anchors are reported unchanged and not written a second time", async () => {
    const store = new FileObjectStore(dir);
    const first = await job.run({ date: TODAY, store, now: TOMORROW });
    const before = readFileSync(fileOf(api.A.id), "utf8");
    const second = await job.run({ date: TODAY, store, now: TOMORROW });
    expect(second.written).toBe(0);
    expect(second.unchanged).toBe(first.written);
    expect(second.failures).toEqual([]);
    expect(readFileSync(fileOf(api.A.id), "utf8")).toBe(before);
  });

  test("a different anchor already stored for that day is a conflict that is reported and never overwritten", async () => {
    mkdirSync(join(dir, "anchors", api.A.id), { recursive: true });
    const stored = anchorBody({ ...buildAnchor(api.A.id, TODAY, await entriesOf(api.A.id)), merkleRoot: "c".repeat(64) });
    writeFileSync(fileOf(api.A.id), stored);
    const report = await job.run({ date: TODAY, store: new FileObjectStore(dir), now: TOMORROW });
    expect(report.failures).toContainEqual({ tenantId: api.A.id, kind: "anchor_conflict" });
    expect(readFileSync(fileOf(api.A.id), "utf8")).toBe(stored);
    expect(readFileSync(fileOf(api.B.id), "utf8")).toContain(api.B.id); // the others were still anchored
  });

  test("a store that fails for one organisation is reported for it and the others are still anchored", async () => {
    const real = new FileObjectStore(dir);
    const flaky: ObjectStore = {
      get: (k) => real.get(k),
      putIfAbsent: (k, body) => (k.includes(api.B.id) ? Promise.reject(new Error("the disk is full")) : real.putIfAbsent(k, body)),
    };
    const report = await job.run({ date: TODAY, store: flaky, now: TOMORROW });
    expect(report.failures).toContainEqual({ tenantId: api.B.id, kind: "store_error", message: "the disk is full" });
    expect(report.written).toBeGreaterThanOrEqual(1);
  });

  test("refuses a day that is not over yet, a date that is not a real day, and a day in the future", async () => {
    const store = new FileObjectStore(dir);
    await expect(job.run({ date: TODAY, store, now: new Date(Date.parse(`${TODAY}T12:00:00Z`)) })).rejects.toThrow(/not over/);
    await expect(job.run({ date: "2099-01-01", store, now: TOMORROW })).rejects.toThrow(/not over/);
    await expect(job.run({ date: "2026-13-45", store, now: TOMORROW })).rejects.toThrow(/real date|YYYY-MM-DD/);
    await expect(job.run({ date: "yesterday", store, now: TOMORROW })).rejects.toThrow(/YYYY-MM-DD/);
    expect(() => readFileSync(fileOf(api.A.id))).toThrow();
  });

  test("a day is over the moment it ends", async () => {
    const report = await job.run({ date: TODAY, store: new FileObjectStore(dir), now: new Date(Date.parse(`${TODAY}T00:00:00Z`) + 86_400_000) });
    expect(report.failures).toEqual([]);
  });

  test("the anchors it writes are what the standalone check accepts", async () => {
    const { verifyLinksAgainstAnchor } = await import("@saral/audit-chain");
    await job.run({ date: TODAY, store: new FileObjectStore(dir), now: TOMORROW });
    const anchor = JSON.parse(readFileSync(fileOf(api.B.id), "utf8")) as Anchor;
    expect(verifyLinksAgainstAnchor(await entriesOf(api.B.id), anchor).ok).toBe(true);
  });

  // Last, because it leaves the first organisation's chain broken for the rest of this file.
  test("a chain that does not verify gets no anchor and is reported with the entry that failed, while the others are anchored", async () => {
    await api.db.owner.query("ALTER TABLE consent_audit_log DISABLE TRIGGER audit_no_update_delete");
    try {
      await api.db.owner.query("UPDATE consent_audit_log SET action = 'consent.withdrawn' WHERE tenant_id = $1 AND seq_no = 2", [api.A.id]);
    } finally {
      await api.db.owner.query("ALTER TABLE consent_audit_log ENABLE TRIGGER audit_no_update_delete");
    }
    const report = await job.run({ date: TODAY, store: new FileObjectStore(dir), now: TOMORROW });
    expect(report.failures).toContainEqual({ tenantId: api.A.id, kind: "chain_invalid", failure: "hash_mismatch", seqNo: "2" });
    expect(() => readFileSync(fileOf(api.A.id))).toThrow();
    expect(readFileSync(fileOf(api.B.id), "utf8")).toContain(api.B.id);
  });
});
