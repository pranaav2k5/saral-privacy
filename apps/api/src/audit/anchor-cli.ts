import { AnchorJob, AnchorJobError, type AnchorFailure } from "./anchor-job.js";
import { AuditService } from "./audit.service.js";
import { Database } from "../db/database.js";
import { createDevKeyProvider } from "../keys/key-provider.js";
import { FileObjectStore } from "./object-store.js";

export interface Io {
  out(line: string): void;
  err(line: string): void;
}

const USAGE = `Usage: pnpm --filter @saral/api anchor [--date YYYY-MM-DD]

Writes the anchor of every organisation for one finished UTC day (the default is yesterday) to the folder in ANCHOR_DIR.
An anchor already there is never replaced. Run it once a day, after midnight UTC.

Environment:
  DATABASE_URL             the database (the owner role, as for the API)
  SARAL_DEV_MASTER_SECRET  the same value the API runs with
  ANCHOR_DIR               the folder that receives the anchors

Exit code: 0 done, 1 something could not be anchored, 2 bad usage or settings.`;

const DATE = /^\d{4}-\d{2}-\d{2}$/;

/** `YYYY-MM-DD` that is a real day on the calendar. */
function isRealDay(value: string): boolean {
  if (!DATE.test(value)) return false;
  const d = new Date(`${value}T00:00:00Z`);
  return !Number.isNaN(d.getTime()) && d.toISOString().slice(0, 10) === value;
}

function parse(argv: readonly string[]): { date?: string } | null {
  if (argv.length === 0) return {};
  if (argv.length !== 2 || argv[0] !== "--date" || !isRealDay(argv[1] as string)) return null;
  return { date: argv[1] as string };
}

function describe(f: AnchorFailure, date: string): string {
  switch (f.kind) {
    case "anchor_conflict":
      return `Organisation ${f.tenantId}: the store already holds a different anchor for ${date}. It was not replaced. Treat this as possible tampering, and investigate.`;
    case "broken_link":
      return `Organisation ${f.tenantId}: the entries for ${date} do not continue from the anchor of ${f.previousDate}, so entries were removed or changed after that anchor. No anchor was written.`;
    case "chain_invalid":
      return `Organisation ${f.tenantId}: the audit chain does not verify (${f.failure} at entry ${f.seqNo}), so no anchor was written.`;
    case "read_error":
      return `Organisation ${f.tenantId}: its entries could not be read (${f.message}), so no anchor was written.`;
    case "store_error":
      return `Organisation ${f.tenantId}: the anchor could not be stored (${f.message}).`;
  }
}

/** Runs the nightly anchor job once. Returns the exit code: 0 done, 1 something was not anchored, 2 bad usage or settings. */
export async function runAnchor(argv: readonly string[], env: NodeJS.ProcessEnv, io: Io, clock: () => Date = () => new Date()): Promise<number> {
  const parsed = parse(argv);
  if (parsed === null) {
    io.err(USAGE);
    return 2;
  }
  for (const name of ["DATABASE_URL", "SARAL_DEV_MASTER_SECRET", "ANCHOR_DIR"]) {
    if (!env[name]) {
      io.err(`${name} is required.`);
      return 2;
    }
  }
  const now = clock();
  const date = parsed.date ?? new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() - 1)).toISOString().slice(0, 10);
  let db: Database | undefined;
  try {
    // The development key provider, which refuses production: the audit keys of a real deployment come from KMS, which is not built.
    const keys = await createDevKeyProvider(env.SARAL_DEV_MASTER_SECRET, env.NODE_ENV);
    db = new Database({ databaseUrl: env.DATABASE_URL, nodeEnv: env.NODE_ENV, devMasterSecret: env.SARAL_DEV_MASTER_SECRET });
    const job = new AnchorJob(db, new AuditService(db, keys));
    const report = await job.run({ date, store: new FileObjectStore(env.ANCHOR_DIR as string), now });
    io.out(`Anchored ${report.date}: ${String(report.written)} written, ${String(report.unchanged)} unchanged, ${String(report.skipped)} with no entries.`);
    for (const f of report.failures) io.err(describe(f, report.date));
    return report.failures.length === 0 ? 0 : 1;
  } catch (e) {
    if (e instanceof AnchorJobError) {
      io.err(e.message);
      return 2;
    }
    const message = e instanceof Error ? e.message : "";
    // The development key provider refuses production with its own words; anything else shows only its code, because the text of a
    // database error can carry the connection string.
    if (/production/i.test(message)) {
      io.err(message);
      return 2;
    }
    io.err(`The anchor job failed (${(e as NodeJS.ErrnoException).code ?? "unexpected error"}).`);
    return 1;
  } finally {
    await db?.onModuleDestroy();
  }
}
