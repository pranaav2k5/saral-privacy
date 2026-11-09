import { runReminders } from "../../src/reminders/reminders-cli.js";
import { MASTER, startApi, type Api } from "./harness.js";

let api: Api;
beforeAll(async () => {
  api = await startApi();
});
afterAll(async () => {
  await api.stop();
});

const env = (over: Record<string, string | undefined> = {}) => ({ DATABASE_URL: api.db.url, SARAL_DEV_MASTER_SECRET: MASTER, NODE_ENV: "test", ...over });
async function reminders(args: string[], e: NodeJS.ProcessEnv = env()) {
  const out: string[] = [];
  const err: string[] = [];
  const code = await runReminders(args, e, { out: (l) => out.push(l), err: (l) => err.push(l) });
  return { code, out: out.join("\n"), err: err.join("\n") };
}
const bearer = (t: string) => ({ Authorization: `Bearer ${t}` });

describe("the reminders command", () => {
  test("with nothing to remind about it says so and exits 0", async () => {
    const r = await reminders([]);
    expect(r.code).toBe(0);
    expect(r.out).toMatch(/^Reminders: 0 queued, 0 waiting for an endpoint, in [0-9]+ organisations?\.$/);
  });

  test("queues what is due, and says how many, and a second run queues none", async () => {
    await api.http().post("/v1/webhook-endpoints").set(bearer(api.A.admin)).send({ url: "https://cli.example.org/hook", events: ["breach.deadline_passed"] });
    const found = new Date(Date.now() - 5 * 86_400_000).toISOString();
    const made = await api.http().post("/v1/breaches").set(bearer(api.A.dpo)).send({
      title: "Old", description: "Found days ago.", discoveredAt: found, nature: ["integrity"], dataCategories: ["names"], likelyConsequences: "None known.", measuresTaken: "Fixed.",
    });
    expect(made.status).toBe(201);
    const first = await reminders([]);
    expect(first.code).toBe(0);
    expect(first.out).toMatch(/^Reminders: 1 queued, 0 waiting for an endpoint, in [0-9]+ organisations?\.$/);
    expect((await reminders([])).out).toMatch(/^Reminders: 0 queued/);
  });

  test("any argument is bad usage, and the usage says how often to run it", async () => {
    const r = await reminders(["--date", "2026-11-06"]);
    expect(r.code).toBe(2);
    expect(r.err).toContain("Usage: pnpm --filter @saral/api reminders");
    expect(r.err).toMatch(/at least once an hour/);
  });

  test.each(["DATABASE_URL", "SARAL_DEV_MASTER_SECRET"])("without %s it says what is missing and exits 2", async (name) => {
    const r = await reminders([], env({ [name]: undefined }));
    expect(r.code).toBe(2);
    expect(r.err).toBe(`${name} is required.`);
  });

  test("a database it cannot reach is said without the connection string, and exits 1", async () => {
    const r = await reminders([], env({ DATABASE_URL: "postgres://nobody:secret-pass@127.0.0.1:1/none" }));
    expect(r.code).toBe(1);
    expect(r.err).not.toContain("secret-pass");
    expect(r.err).toMatch(/The reminder job failed/);
  });

  test("says 'organisation' for one and 'organisations' for any other number", async () => {
    const { ReminderJob } = await import("../../src/reminders/reminder-job.js");
    const original = ReminderJob.prototype.run;
    const zero = { "breach.deadline_soon": 0, "breach.deadline_passed": 0, "ropa.review_soon": 0, "ropa.review_overdue": 0 };
    try {
      for (const [tenants, words] of [[1, "1 organisation."], [0, "0 organisations."], [2, "2 organisations."]] as const) {
        ReminderJob.prototype.run = async () => ({ tenants, queued: zero, waiting: 0, failures: [] });
        expect((await reminders([])).out).toBe(`Reminders: 0 queued, 0 waiting for an endpoint, in ${words}`);
      }
    } finally {
      ReminderJob.prototype.run = original;
    }
  });

  test("a failure in an organisation exits 1 and is said in words with its id", async () => {
    const { ReminderJob } = await import("../../src/reminders/reminder-job.js");
    const original = ReminderJob.prototype.run;
    ReminderJob.prototype.run = async () => ({ tenants: 3, queued: { "breach.deadline_soon": 0, "breach.deadline_passed": 0, "ropa.review_soon": 0, "ropa.review_overdue": 0 }, waiting: 0, failures: [{ tenantId: "t-1", message: "it broke" }] });
    try {
      const r = await reminders([]);
      expect(r.code).toBe(1);
      expect(r.err).toBe("Organisation t-1: reminders could not be queued (it broke).");
    } finally {
      ReminderJob.prototype.run = original;
    }
  });
});
