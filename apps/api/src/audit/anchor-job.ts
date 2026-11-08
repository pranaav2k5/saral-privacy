import { Injectable } from "@nestjs/common";
import { anchorBody } from "@saral/audit-chain";
import { Database } from "../db/database.js";
import { AuditService, utcDay } from "./audit.service.js";
import { anchorKey, type ObjectStore } from "./object-store.js";

export type AnchorFailure =
  | { tenantId: string; kind: "chain_invalid"; failure: string; seqNo: string }
  /** The store already holds a different anchor for that organisation and day. It was left alone. */
  | { tenantId: string; kind: "anchor_conflict" }
  | { tenantId: string; kind: "read_error"; message: string }
  | { tenantId: string; kind: "store_error"; message: string };

export interface AnchorReport {
  date: string;
  written: number;
  /** Already stored, and identical. */
  unchanged: number;
  /** Organisations with no entries that day. */
  skipped: number;
  failures: AnchorFailure[];
}

/** A problem with how the job was asked to run, not with any organisation. */
export class AnchorJobError extends Error {}

const clip = (e: unknown): string => (e instanceof Error ? e.message : "failed").slice(0, 200);

/**
 * The nightly job. For one finished UTC day it works out the anchor of every organisation that has entries (after
 * verifying the organisation's chain, so a broken chain is reported and never anchored) and writes it to the store once.
 * An anchor already there is never replaced: if it is identical the run is a repeat, and if it differs that is reported
 * as a conflict, because a stored anchor that disagrees with the database is the very thing the anchors exist to show.
 * One organisation's problem never stops the others.
 */
@Injectable()
export class AnchorJob {
  constructor(
    private readonly db: Database,
    private readonly audit: AuditService,
  ) {}

  async run(opts: { date: string; store: ObjectStore; now?: Date }): Promise<AnchorReport> {
    const day = utcDay(opts.date);
    if (day.end.getTime() > (opts.now ?? new Date()).getTime()) throw new AnchorJobError(`${opts.date} is not over yet (days end at midnight UTC), and an anchor of a part of a day would be wrong.`);
    const tenantIds = await this.db.asAnchor(async (c) => (await c.query<{ id: string }>("SELECT id FROM tenants ORDER BY id")).rows.map((r) => r.id));
    const report: AnchorReport = { date: day.label, written: 0, unchanged: 0, skipped: 0, failures: [] };
    for (const tenantId of tenantIds) {
      let body: string;
      try {
        const result = await this.audit.anchor(tenantId, day.label);
        if (result === null) {
          report.skipped += 1;
          continue;
        }
        if ("failure" in result) {
          report.failures.push({ tenantId, kind: "chain_invalid", failure: result.failure, seqNo: result.seqNo });
          continue;
        }
        body = anchorBody(result.anchor);
      } catch (e) {
        report.failures.push({ tenantId, kind: "read_error", message: clip(e) });
        continue;
      }
      try {
        const key = anchorKey(tenantId, day.label);
        if ((await opts.store.putIfAbsent(key, body)) === "written") report.written += 1;
        else if ((await opts.store.get(key)) === body) report.unchanged += 1;
        else report.failures.push({ tenantId, kind: "anchor_conflict" });
      } catch (e) {
        report.failures.push({ tenantId, kind: "store_error", message: clip(e) });
      }
    }
    return report;
  }
}
