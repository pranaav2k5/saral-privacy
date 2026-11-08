import { mkdtempSync, readFileSync, rmSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runAnchor } from "../../src/audit/anchor-cli.js";
import { AuditService } from "../../src/audit/audit.service.js";
import { MASTER, startApi, type Api } from "./harness.js";

let api: Api;
let dir: string;
// Entry times come from a fixed clock, so a run that crosses midnight still finds its entries on the day it anchors.
const TODAY = "2026-11-06";
const AT = Date.parse(`${TODAY}T10:00:00Z`);
beforeAll(async () => {
  api = await startApi();
  api.app.get(AuditService).now = () => AT;
  await api.grant(api.A);
});
afterAll(async () => {
  await api.stop();
});
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "saral-anchor-cli-"));
});
afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

const env = (over: Record<string, string | undefined> = {}) => ({ DATABASE_URL: api.db.url, SARAL_DEV_MASTER_SECRET: MASTER, NODE_ENV: "test", ANCHOR_DIR: dir, ...over });
async function anchor(args: string[], e: NodeJS.ProcessEnv = env(), now = new Date(Date.parse(`${TODAY}T00:00:00Z`) + 86_400_000 + 600_000)) {
  const out: string[] = [];
  const err: string[] = [];
  const code = await runAnchor(args, e, { out: (l) => out.push(l), err: (l) => err.push(l) }, () => now);
  return { code, out: out.join("\n"), err: err.join("\n") };
}

describe("the anchor command", () => {
  test("anchors the named day and says how many were written", async () => {
    const r = await anchor(["--date", TODAY]);
    expect(r.code).toBe(0);
    expect(r.out).toMatch(new RegExp(`Anchored ${TODAY}: [1-9][0-9]* written, 0 unchanged, [0-9]+ with no entries\\.`));
    expect(existsSync(join(dir, "anchors", api.A.id, `${TODAY}.json`))).toBe(true);
    expect(readFileSync(join(dir, "anchors", api.A.id, `${TODAY}.json`), "utf8")).toContain(`"date":"${TODAY}"`);
  });

  test("with no date it anchors yesterday, the last whole day", async () => {
    const tomorrow = new Date(Date.parse(`${TODAY}T00:00:00Z`) + 86_400_000 + 600_000);
    const r = await anchor([], env(), tomorrow);
    expect(r.code).toBe(0);
    expect(r.out).toContain(`Anchored ${TODAY}:`);
  });

  test("run twice, the second time writes nothing", async () => {
    await anchor(["--date", TODAY]);
    const r = await anchor(["--date", TODAY]);
    expect(r.code).toBe(0);
    expect(r.out).toMatch(/0 written, [1-9][0-9]* unchanged/);
  });

  test("a conflict or a broken chain is said in words and exits with 1", async () => {
    await anchor(["--date", TODAY]);
    await api.grant(api.A); // a new entry that day makes the stored anchor differ from today's
    const r = await anchor(["--date", TODAY]);
    expect(r.code).toBe(1);
    expect(r.err).toContain(api.A.id);
    expect(r.err).toMatch(/already holds a different anchor/);
  });

  test("a day that is not over is refused in words and exits with 2", async () => {
    const r = await anchor(["--date", TODAY], env(), new Date(Date.parse(`${TODAY}T12:00:00Z`)));
    expect(r.code).toBe(2);
    expect(r.err).toContain("not over");
  });

  test.each([
    ["an unknown flag", ["--dat", "2026-01-01"]],
    ["a flag with no value", ["--date"]],
    ["a bad date", ["--date", "yesterday"]],
    ["a date that is not a day on the calendar", ["--date", "2026-02-30"]],
    ["a month that does not exist", ["--date", "2026-13-01"]],
    ["a date given twice", ["--date", "2026-01-01", "--date", "2026-01-02"]],
    ["a stray word", ["now"]],
  ])("%s prints the usage and exits with 2", async (_n, args) => {
    const r = await anchor(args);
    expect(r.code).toBe(2);
    expect(r.err).toContain("Usage:");
  });

  test.each([
    ["DATABASE_URL", { DATABASE_URL: undefined }],
    ["SARAL_DEV_MASTER_SECRET", { SARAL_DEV_MASTER_SECRET: undefined }],
    ["ANCHOR_DIR", { ANCHOR_DIR: undefined }],
  ])("without %s it stops and says which is missing", async (name, over) => {
    const r = await anchor(["--date", TODAY], env(over));
    expect(r.code).toBe(2);
    expect(r.err).toContain(name);
  });

  test("in production it stops, because only the development key provider exists", async () => {
    const r = await anchor(["--date", TODAY], env({ NODE_ENV: "production" }));
    expect(r.code).toBe(2);
    expect(r.err).toMatch(/production/i);
    expect(existsSync(join(dir, "anchors"))).toBe(false);
  });

  test("the database address, which holds a password, is never printed, even when the connection fails", async () => {
    const url = "postgres://someone:hunter2hunter2@127.0.0.1:1/nothing";
    const r = await anchor(["--date", TODAY], env({ DATABASE_URL: url }));
    expect(r.code).toBe(1);
    expect(r.out + r.err).not.toContain("hunter2");
  });
});
