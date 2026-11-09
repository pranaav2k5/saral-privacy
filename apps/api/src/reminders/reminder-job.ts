import { Injectable } from "@nestjs/common";
import { sha256Hex } from "@saral/audit-chain";
import { AuditService } from "../audit/audit.service.js";
import { boardDeadline } from "../breaches/state.js";
import { Database } from "../db/database.js";
import { WebhookService, type WebhookEvent } from "../webhooks/webhook.service.js";
import { breachStage, ropaStage } from "./rules.js";

export type ReminderEvent = Extract<WebhookEvent, "breach.deadline_soon" | "breach.deadline_passed" | "ropa.review_soon" | "ropa.review_overdue">;
export const REMINDER_EVENTS: readonly ReminderEvent[] = ["breach.deadline_soon", "breach.deadline_passed", "ropa.review_soon", "ropa.review_overdue"];

export interface ReminderReport {
  /** The organisations looked at. */
  tenants: number;
  /** Reminders queued by this run, by event. */
  queued: Record<ReminderEvent, number>;
  /** Reminders that are due but were not sent, because no active endpoint asked for the event. They go out once one does. */
  waiting: number;
  failures: { tenantId: string; message: string }[];
}

interface Due {
  kind: "breach" | "ropa";
  refTable: "breach_incidents" | "ropa_versions";
  refId: string;
  stage: "soon" | "passed" | "overdue";
  event: ReminderEvent;
  data: Record<string, unknown>;
}

const clip = (e: unknown): string => (e instanceof Error ? e.message : "failed").slice(0, 200);
const zero = (): Record<ReminderEvent, number> => ({ "breach.deadline_soon": 0, "breach.deadline_passed": 0, "ropa.review_soon": 0, "ropa.review_overdue": 0 });

/** The date a stored record says its next review is due, or nothing if it says none or cannot be read. */
function reviewDue(documentJson: string): string | undefined {
  try {
    const review = (JSON.parse(documentJson) as { review?: unknown } | null)?.review;
    const due = typeof review === "object" && review !== null ? (review as { nextReviewDue?: unknown }).nextReviewDue : undefined;
    return typeof due === "string" ? due : undefined;
  } catch {
    return undefined;
  }
}

/**
 * The reminder job. For each organisation it works out what is due: a breach the Board has not been told about whose deadline is
 * within 24 hours or has passed, and the newest version of the record of processing when its next review is within 14 days or overdue.
 * Each is sent once, as a webhook event to the endpoints that asked for it (ids and dates only, never words), so it reaches a person
 * who has not opened the dashboard through whatever their own system does with it. Run it at least once an hour: more often is safe.
 *
 * The work of one organisation is one transaction under its lock, so two runs at once cannot send the same reminder twice, and a failure
 * in one organisation sends nothing for it, changes nothing, is reported by id, and leaves the others alone.
 */
@Injectable()
export class ReminderJob {
  constructor(
    private readonly db: Database,
    private readonly audit: AuditService,
    private readonly webhooks: WebhookService,
  ) {}

  async run(opts: { now?: Date } = {}): Promise<ReminderReport> {
    const now = opts.now ?? new Date();
    const tenantIds = await this.db.asAnchor(async (c) => (await c.query<{ id: string }>("SELECT id FROM tenants ORDER BY id")).rows.map((r) => r.id));
    const report: ReminderReport = { tenants: tenantIds.length, queued: zero(), waiting: 0, failures: [] };
    for (const tenantId of tenantIds) {
      try {
        const done = await this.forTenant(tenantId, now);
        for (const e of REMINDER_EVENTS) report.queued[e] += done.queued[e];
        report.waiting += done.waiting;
      } catch (e) {
        report.failures.push({ tenantId, message: clip(e) });
      }
    }
    return report;
  }

  private async forTenant(tenantId: string, now: Date): Promise<{ queued: Record<ReminderEvent, number>; waiting: number }> {
    return this.db.inScope({ tenantId }, async (c) => {
      await c.query("SELECT audit_append_lock($1)", [tenantId]);
      const due: Due[] = [];
      const incidents = await c.query<{ id: string; discovered_at: Date }>(
        "SELECT id, discovered_at FROM breach_incidents WHERE board_notified_at IS NULL AND state IN ('reported', 'signed_off') ORDER BY discovered_at, id");
      for (const i of incidents.rows) {
        const stage = breachStage(i.discovered_at, now);
        if (stage === null) continue;
        due.push({
          kind: "breach", refTable: "breach_incidents", refId: i.id, stage, event: stage === "soon" ? "breach.deadline_soon" : "breach.deadline_passed",
          data: { breachId: i.id, boardDeadline: boardDeadline(i.discovered_at).toISOString() },
        });
      }
      const latest = (await c.query<{ id: string; version: number; document_json: string }>("SELECT id, version, document_json FROM ropa_versions ORDER BY version DESC LIMIT 1")).rows[0];
      const next = latest === undefined ? undefined : reviewDue(latest.document_json);
      const ropa = ropaStage(next, now);
      if (latest !== undefined && next !== undefined && ropa !== null) {
        due.push({
          kind: "ropa", refTable: "ropa_versions", refId: latest.id, stage: ropa, event: ropa === "soon" ? "ropa.review_soon" : "ropa.review_overdue",
          data: { ropaVersionId: latest.id, version: latest.version, nextReviewDue: next },
        });
      }

      const result = { queued: zero(), waiting: 0 };
      for (const d of due) {
        const already = await c.query("SELECT 1 FROM reminders_sent WHERE kind = $1 AND ref_id = $2 AND stage = $3", [d.kind, d.refId, d.stage]);
        if (already.rowCount !== 0) continue;
        const endpoints = await this.webhooks.enqueue(c, tenantId, d.event, d.data);
        if (endpoints === 0) {
          result.waiting += 1;
          continue;
        }
        await c.query("INSERT INTO reminders_sent (tenant_id, kind, ref_id, stage) VALUES ($1, $2, $3, $4)", [tenantId, d.kind, d.refId, d.stage]);
        await this.audit.append(c, tenantId, {
          actorType: "system", actorId: "system:reminder-job", action: "reminder.sent", refTable: d.refTable, refId: d.refId,
          payloadSha256: sha256Hex(JSON.stringify(["saral.reminder", 1, tenantId, d.kind, d.refId, d.stage, endpoints])),
        });
        result.queued[d.event] += 1;
      }
      return result;
    });
  }
}
