import { Inject, Injectable } from "@nestjs/common";
import type pg from "pg";
import { Database } from "../db/database.js";
import { KEY_PROVIDER, type KeyProvider } from "../keys/key-provider.js";
import { MAX_ATTEMPTS, nextAttemptDelaySeconds } from "./schedule.js";
import { endpointSecret, signWebhook } from "./signature.js";
import { WEBHOOK_HTTP, type WebhookHttp } from "./tokens.js";

const BATCH = 50;
/** A claimed delivery that is not finished within this time becomes due again (the worker may have died). */
const VISIBILITY_TIMEOUT_MS = 5 * 60 * 1000;

export interface RunResult {
  delivered: number;
  retried: number;
  failed: number;
}

export type Claimed = { id: string; tenant_id: string; endpoint_id: string; event_type: string; payload: Record<string, unknown>; attempts: number; created_at: Date };

/**
 * Sends due webhook deliveries. At-least-once: a delivery is claimed (and its attempt counted) in a short transaction,
 * sent outside any transaction, and its outcome recorded in a second short transaction. The receiver de-duplicates with
 * the Idempotency-Key header, which is the delivery id. Several workers may run at once; `SKIP LOCKED` keeps them apart.
 */
@Injectable()
export class WebhookWorker {
  constructor(
    private readonly db: Database,
    @Inject(KEY_PROVIDER) private readonly keys: KeyProvider,
    @Inject(WEBHOOK_HTTP) private readonly http: WebhookHttp,
  ) {}

  /** Source of jitter for retry delays; tests replace it. */
  random: () => number = Math.random;

  /**
   * Claims up to `limit` due deliveries inside the caller's transaction: counts the attempt and hides the row for the
   * visibility timeout. `SKIP LOCKED` means a second worker, even one that starts before this transaction commits,
   * gets different rows instead of waiting for these or taking them again.
   */
  async claim(c: pg.ClientBase, now: Date, limit: number = BATCH): Promise<Claimed[]> {
    const r = await c.query<Claimed>(
      `UPDATE webhook_deliveries d SET attempts = d.attempts + 1, next_attempt_at = $2
       FROM (SELECT d2.id FROM webhook_deliveries d2 JOIN webhook_endpoints e ON e.id = d2.endpoint_id
             WHERE d2.state = 'pending' AND d2.next_attempt_at <= $1 AND e.disabled_at IS NULL
             ORDER BY d2.next_attempt_at LIMIT $3 FOR UPDATE OF d2 SKIP LOCKED) due
       WHERE d.id = due.id
       RETURNING d.id, d.tenant_id, d.endpoint_id, d.event_type, d.payload, d.attempts, d.created_at`,
      [now, new Date(now.getTime() + VISIBILITY_TIMEOUT_MS), limit],
    );
    return r.rows;
  }

  async runOnce(now: Date): Promise<RunResult> {
    const claimed = await this.db.asWorker((c) => this.claim(c, now));
    const result: RunResult = { delivered: 0, retried: 0, failed: 0 };
    if (claimed.length === 0) return result;

    const endpoints = await this.db.asWorker(async (c) => {
      const r = await c.query<{ id: string; url: string; secret_version: number }>("SELECT id, url, secret_version FROM webhook_endpoints WHERE id = ANY($1)", [[...new Set(claimed.map((d) => d.endpoint_id))]]);
      return new Map(r.rows.map((e) => [e.id, e]));
    });

    for (const d of claimed) {
      const endpoint = endpoints.get(d.endpoint_id);
      let status: number | null = null;
      let error: string | null = null;
      try {
        if (endpoint === undefined) throw new Error("endpoint not found");
        const body = JSON.stringify({ id: d.id, type: d.event_type, createdAt: d.created_at.toISOString(), data: d.payload });
        const secret = endpointSecret(this.keys.webhookKey(), d.endpoint_id, endpoint.secret_version);
        const res = await this.http.post({
          url: endpoint.url,
          headers: {
            "Content-Type": "application/json",
            "User-Agent": "Saral-Webhooks/1",
            "X-Saral-Event": d.event_type,
            "Idempotency-Key": d.id,
            "X-Saral-Signature": signWebhook(secret, Math.floor(now.getTime() / 1000), body),
          },
          body,
        });
        status = res.status;
        if (status < 200 || status > 299) error = `HTTP ${String(status)}`;
      } catch (e) {
        error = (e instanceof Error ? e.message : "delivery failed").slice(0, 300);
      }
      const outcome = await this.record(d, status, error, now);
      result[outcome] += 1;
    }
    return result;
  }

  private async record(d: Claimed, status: number | null, error: string | null, now: Date): Promise<"delivered" | "retried" | "failed"> {
    if (error === null) {
      await this.db.asWorker((c) =>
        c.query("UPDATE webhook_deliveries SET state = 'delivered', delivered_at = $2, last_status = $3, last_error = NULL WHERE id = $1", [d.id, now, status]),
      );
      return "delivered";
    }
    const delay = nextAttemptDelaySeconds(Math.min(d.attempts, MAX_ATTEMPTS), this.random);
    await this.db.asWorker((c) =>
      delay === null
        ? c.query("UPDATE webhook_deliveries SET state = 'failed', last_status = $2, last_error = $3 WHERE id = $1", [d.id, status, error])
        : c.query("UPDATE webhook_deliveries SET next_attempt_at = $2, last_status = $3, last_error = $4 WHERE id = $1", [d.id, new Date(now.getTime() + delay * 1000), status, error]),
    );
    return delay === null ? "failed" : "retried";
  }
}
