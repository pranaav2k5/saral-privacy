import { Injectable } from "@nestjs/common";
import { anchorBody, hashesEqual, isHash, type Anchor } from "@saral/audit-chain";
import { Database } from "../db/database.js";
import { AuditService, utcDay } from "./audit.service.js";
import { anchorKey, type ObjectStore } from "./object-store.js";

export type AnchorFailure =
  | { tenantId: string; kind: "chain_invalid"; failure: string; seqNo: string }
  /** The store already holds a different anchor for that organisation and day. It was left alone. */
  | { tenantId: string; kind: "anchor_conflict" }
  /** The day's entries do not continue from the latest earlier anchor in the store: entries after that anchor were removed or changed. */
  | { tenantId: string; kind: "broken_link"; previousDate: string }
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

const DIGITS = /^[0-9]{1,30}$/;
const ANCHOR_FILE = /\/(\d{4}-\d{2}-\d{2})\.json$/;

/** An anchor read back from the store, or undefined if it is not one for this organisation. */
function parseStoredAnchor(text: string, tenantId: string): Anchor | undefined {
  try {
    const a = JSON.parse(text) as Partial<Record<keyof Anchor, unknown>>;
    if (a.version !== 1 || a.tenantId !== tenantId || typeof a.date !== "string" || typeof a.lastSeqNo !== "string" || !DIGITS.test(a.lastSeqNo) || typeof a.headHash !== "string" || !isHash(a.headHash)) return undefined;
    return a as unknown as Anchor;
  } catch {
    return undefined;
  }
}

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
      let found: Awaited<ReturnType<AuditService["anchor"]>>;
      try {
        found = await this.audit.anchor(tenantId, day.label, { lock: true });
      } catch (e) {
        report.failures.push({ tenantId, kind: "read_error", message: clip(e) });
        continue;
      }
      if (found !== null && "failure" in found) {
        report.failures.push({ tenantId, kind: "chain_invalid", failure: found.failure, seqNo: found.seqNo });
        continue;
      }
      try {
        const key = anchorKey(tenantId, day.label);
        if (found === null) {
          // Nothing in the database for the day. If an anchor for it is stored, entries were removed after it was written.
          if ((await opts.store.get(key)) === undefined) report.skipped += 1;
          else report.failures.push({ tenantId, kind: "anchor_conflict" });
          continue;
        }
        const body = anchorBody(found.anchor);
        const link = await this.checkLink(opts.store, tenantId, found.anchor, found.startPrevHash);
        if (link !== undefined) {
          report.failures.push({ tenantId, ...link });
          continue;
        }
        if ((await opts.store.putIfAbsent(key, body)) === "written") report.written += 1;
        else if ((await opts.store.get(key)) === body) report.unchanged += 1;
        else report.failures.push({ tenantId, kind: "anchor_conflict" });
      } catch (e) {
        report.failures.push({ tenantId, kind: "store_error", message: clip(e) });
      }
    }
    return report;
  }

  /**
   * The day must continue from the latest anchor stored for an earlier day (days with no entries have no anchor, so it may be several days
   * back): its first entry must be the next number and point at that anchor's head. Otherwise entries after that anchor were removed, and
   * later ones appended from what was left would pass for a clean chain. With no earlier anchor there is nothing to check against.
   */
  private async checkLink(store: ObjectStore, tenantId: string, anchor: Anchor, startPrevHash: string): Promise<{ kind: "broken_link"; previousDate: string } | { kind: "store_error"; message: string } | undefined> {
    const earlier = (await store.list(`anchors/${tenantId}/`)).map((k) => ANCHOR_FILE.exec(k)?.[1]).filter((d): d is string => d !== undefined && d < anchor.date).sort();
    const previousDate = earlier.at(-1);
    if (previousDate === undefined) return undefined;
    const text = await store.get(anchorKey(tenantId, previousDate));
    const previous = text === undefined ? undefined : parseStoredAnchor(text, tenantId);
    if (previous === undefined) return { kind: "store_error", message: `the anchor of ${previousDate} could not be read, so this day cannot be checked against it` };
    if (BigInt(previous.lastSeqNo) + 1n !== BigInt(anchor.firstSeqNo) || !hashesEqual(previous.headHash, startPrevHash)) return { kind: "broken_link", previousDate };
    return undefined;
  }
}
