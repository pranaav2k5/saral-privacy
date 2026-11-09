import { Inject, Injectable } from "@nestjs/common";
import type pg from "pg";
import { Database } from "../db/database.js";
import { KEY_PROVIDER, type KeyProvider } from "../keys/key-provider.js";
import { MAX_ATTEMPTS, nextAttemptDelaySeconds } from "./schedule.js";
import { endpointSecret, previousSecretActive, signWebhook } from "./signature.js";
import { WEBHOOK_HTTP, type WebhookHttp } from "./tokens.js";
import { WebhookService } from "./webhook.service.js";

const BATCH = 50;
/** One tenant with a large backlog may take at most this many slots of one claim, so it cannot starve the others. */
const PER_TENANT_CLAIM = 20;
/** How many endpoints are served at the same time. The deliveries of one endpoint always go one after another. */
const CONCURRENCY = 10;
const DEFAULT_ENDPOINT_BUDGET_MS = 60_000;
/** A claimed delivery that is not finished within this time becomes due again (the worker may have died). */
const VISIBILITY_TIMEOUT_MS = 5 * 60 * 1000;

export interface RunResult {
  delivered: number;
  retried: number;
  failed: number;
  /** Claimed but not sent because their endpoint used up its time budget. Not counted as an attempt. */
  released: number;
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
    private readonly webhooks: WebhookService,
  ) {}

  /** Source of jitter for retry delays; tests replace it. */
  random: () => number = Math.random;

  /**
   * Claims up to `limit` due deliveries inside the caller's transaction: counts the attempt and hides the row for the
   * visibility timeout, at most `perTenant` per tenant. `SKIP LOCKED` means a second worker, even one that starts before this transaction commits,
   * gets different rows instead of waiting for these or taking them again.
   */
  async claim(c: pg.ClientBase, now: Date, limit: number = BATCH, perTenant: number = PER_TENANT_CLAIM): Promise<Claimed[]> {
    const r = await c.query<Claimed>(
      `UPDATE webhook_deliveries d SET attempts = d.attempts + 1, next_attempt_at = $2
       FROM (SELECT d2.id FROM webhook_deliveries d2
             -- The conditions are repeated here on the locked row: after waiting for a concurrent claim, Postgres rechecks
             -- only the conditions of the locking query, so without them a row that was just claimed could be claimed again.
             WHERE d2.state = 'pending' AND d2.next_attempt_at <= $1 AND d2.attempts < ${String(MAX_ATTEMPTS)}
               AND d2.id IN (SELECT x.id FROM (
                     SELECT d3.id, row_number() OVER (PARTITION BY d3.tenant_id ORDER BY d3.next_attempt_at, d3.created_at) AS rn
                     FROM webhook_deliveries d3 JOIN webhook_endpoints e ON e.id = d3.endpoint_id
                     WHERE d3.state = 'pending' AND d3.next_attempt_at <= $1 AND d3.attempts < ${String(MAX_ATTEMPTS)} AND e.disabled_at IS NULL) x
                   WHERE x.rn <= $4)
             ORDER BY d2.next_attempt_at, d2.created_at LIMIT $3 FOR UPDATE OF d2 SKIP LOCKED) due
       WHERE d.id = due.id
       RETURNING d.id, d.tenant_id, d.endpoint_id, d.event_type, d.payload, d.attempts, d.created_at`,
      [now, new Date(now.getTime() + VISIBILITY_TIMEOUT_MS), limit, perTenant],
    );
    return r.rows.sort((a, b) => a.created_at.getTime() - b.created_at.getTime());
  }

  /**
   * Closes deliveries that can never be sent: a worker that died while sending the 15th attempt leaves the row pending
   * at 15 (it would otherwise be claimed again, push `attempts` past its limit and fail the whole claim for every tenant),
   * and events waiting for an endpoint that was disabled.
   */
  async sweep(c: pg.ClientBase, now: Date): Promise<void> {
    await c.query("UPDATE webhook_deliveries SET state = 'failed', last_error = 'abandoned after 15 attempts' WHERE state = 'pending' AND attempts >= $2 AND next_attempt_at <= $1", [now, MAX_ATTEMPTS]);
    await c.query("UPDATE webhook_deliveries d SET state = 'failed', last_error = 'endpoint disabled' FROM webhook_endpoints e WHERE d.endpoint_id = e.id AND e.disabled_at IS NOT NULL AND d.state = 'pending'");
  }

  async runOnce(now: Date): Promise<RunResult> {
    const claimed = await this.db.asWorker(async (c) => {
      await this.sweep(c, now);
      return this.claim(c, now);
    });
    const result: RunResult = { delivered: 0, retried: 0, failed: 0, released: 0 };
    if (claimed.length === 0) return result;

    const endpoints = await this.db.asWorker(async (c) => {
      const r = await c.query<{ id: string; url: string; secret_version: number; rotated_at: Date | null }>("SELECT id, url, secret_version, rotated_at FROM webhook_endpoints WHERE id = ANY($1)", [[...new Set(claimed.map((d) => d.endpoint_id))]]);
      return new Map(r.rows.map((e) => [e.id, e]));
    });

    // One chain per endpoint, in order. Chains run at the same time, at most CONCURRENCY of them, so a slow endpoint
    // delays only its own deliveries and the whole batch finishes well inside the visibility timeout.
    const chains = new Map<string, Claimed[]>();
    for (const d of claimed) chains.set(d.endpoint_id, [...(chains.get(d.endpoint_id) ?? []), d]);
    const queue = [...chains.values()];
    const worker = async (): Promise<void> => {
      for (let chain = queue.shift(); chain !== undefined; chain = queue.shift()) {
        const started = Date.now();
        for (const [i, d] of chain.entries()) {
          if (Date.now() - started > this.endpointBudgetMs) {
            // Out of time for this endpoint: put the rest back, and do not count it as an attempt.
            await this.release(chain.slice(i), now);
            result.released += chain.length - i;
            break;
          }
          const outcome = await this.deliver(d, endpoints.get(d.endpoint_id), now);
          result[outcome] += 1;
          if (outcome === "failed") await this.disableIfFailing(d);
        }
      }
    };
    await Promise.all(Array.from({ length: Math.min(CONCURRENCY, queue.length) }, worker));
    return result;
  }

  /** After a delivery has failed for good: an endpoint whose recent deliveries all failed is switched off. A problem here must not stop the run. */
  private async disableIfFailing(d: Claimed): Promise<void> {
    try {
      await this.webhooks.disableIfFailing(d.tenant_id, d.endpoint_id);
    } catch (e) {
      console.error("webhook worker: could not check the endpoint:", e instanceof Error ? e.message : e);
    }
  }

  /** Time one endpoint may spend per run before the rest of its claimed deliveries are released. Tests change it. */
  endpointBudgetMs = DEFAULT_ENDPOINT_BUDGET_MS;

  private async release(rest: Claimed[], now: Date): Promise<void> {
    await this.db.asWorker((c) =>
      c.query("UPDATE webhook_deliveries SET attempts = GREATEST(attempts - 1, 0), next_attempt_at = $2 WHERE id = ANY($1) AND state = 'pending'", [rest.map((d) => d.id), now]),
    );
  }

  private async deliver(d: Claimed, endpoint: { url: string; secret_version: number; rotated_at: Date | null } | undefined, now: Date): Promise<"delivered" | "retried" | "failed"> {
    let status: number | null = null;
    let error: string | null = null;
    try {
      if (endpoint === undefined) throw new Error("endpoint not found");
      const body = JSON.stringify({ id: d.id, type: d.event_type, createdAt: d.created_at.toISOString(), data: d.payload });
      const secret = endpointSecret(this.keys.webhookKey(), d.endpoint_id, endpoint.secret_version);
      // While a rotation's overlap lasts, the secret before this one signs too, so a receiver that has not switched over still verifies.
      const previous = previousSecretActive(endpoint.secret_version, endpoint.rotated_at, now) ? endpointSecret(this.keys.webhookKey(), d.endpoint_id, endpoint.secret_version - 1) : undefined;
      const res = await this.http.post({
        url: endpoint.url,
        headers: {
          "Content-Type": "application/json",
          "User-Agent": "Saral-Webhooks/1",
          "X-Saral-Event": d.event_type,
          "Idempotency-Key": d.id,
          "X-Saral-Signature": signWebhook(secret, Math.floor(now.getTime() / 1000), body, previous),
        },
        body,
      });
      status = res.status;
      if (status < 200 || status > 299) error = `HTTP ${String(status)}`;
    } catch (e) {
      error = (e instanceof Error ? e.message : "delivery failed").slice(0, 300);
    }
    return this.record(d, status, error, now);
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
