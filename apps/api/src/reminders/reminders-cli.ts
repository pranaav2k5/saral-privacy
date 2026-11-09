import { AuditService } from "../audit/audit.service.js";
import { Database } from "../db/database.js";
import { createDevKeyProvider } from "../keys/key-provider.js";
import type { Resolver } from "../webhooks/url-guard.js";
import { WebhookService } from "../webhooks/webhook.service.js";
import { REMINDER_EVENTS, ReminderJob } from "./reminder-job.js";

export interface Io {
  out(line: string): void;
  err(line: string): void;
}

const USAGE = `Usage: pnpm --filter @saral/api reminders

Queues the reminders that are due, as webhook events, for every organisation: a breach the Board has not been told about whose
deadline is within 24 hours or has passed, and the next review of the record of processing when it is within 14 days or overdue.
Each reminder is queued once, to the endpoints that asked for the event. Run it at least once an hour (running it more often is safe).
The webhook worker, which is part of the API, delivers what it queues.

Environment:
  DATABASE_URL             the database (the owner role, as for the API)
  SARAL_DEV_MASTER_SECRET  the same value the API runs with

Exit code: 0 done, 1 something could not be queued, 2 bad usage or settings.`;

/** Queuing never looks an address up: that happens when the endpoint is registered and at delivery. */
const neverResolves: Resolver = () => Promise.reject(new Error("the reminder job does not resolve addresses"));

/** Runs the reminder job once. Returns the exit code: 0 done, 1 something was not queued, 2 bad usage or settings. */
export async function runReminders(argv: readonly string[], env: NodeJS.ProcessEnv, io: Io, clock: () => Date = () => new Date()): Promise<number> {
  if (argv.length !== 0) {
    io.err(USAGE);
    return 2;
  }
  for (const name of ["DATABASE_URL", "SARAL_DEV_MASTER_SECRET"]) {
    if (!env[name]) {
      io.err(`${name} is required.`);
      return 2;
    }
  }
  let db: Database | undefined;
  try {
    // The development key provider, which refuses production: the audit keys of a real deployment come from KMS, which is not built.
    const keys = await createDevKeyProvider(env.SARAL_DEV_MASTER_SECRET, env.NODE_ENV);
    db = new Database({ databaseUrl: env.DATABASE_URL, nodeEnv: env.NODE_ENV, devMasterSecret: env.SARAL_DEV_MASTER_SECRET });
    const audit = new AuditService(db, keys);
    const job = new ReminderJob(db, audit, new WebhookService(db, audit, keys, neverResolves));
    const report = await job.run({ now: clock() });
    const queued = REMINDER_EVENTS.reduce((n, e) => n + report.queued[e], 0);
    io.out(`Reminders: ${String(queued)} queued, ${String(report.waiting)} waiting for an endpoint, in ${String(report.tenants)} ${report.tenants === 1 ? "organisation" : "organisations"}.`);
    for (const f of report.failures) io.err(`Organisation ${f.tenantId}: reminders could not be queued (${f.message}).`);
    return report.failures.length === 0 ? 0 : 1;
  } catch (e) {
    const message = e instanceof Error ? e.message : "";
    // The development key provider refuses production with its own words; anything else shows only its code, because the text of a
    // database error can carry the connection string.
    if (/production/i.test(message)) {
      io.err(message);
      return 2;
    }
    io.err(`The reminder job failed (${(e as NodeJS.ErrnoException).code ?? "unexpected error"}).`);
    return 1;
  } finally {
    await db?.onModuleDestroy();
  }
}
