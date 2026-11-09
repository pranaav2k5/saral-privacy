import { ConflictException, Inject, Injectable, NotFoundException, UnprocessableEntityException } from "@nestjs/common";
import { randomUUID } from "node:crypto";
import { sha256Hex } from "@saral/audit-chain";
import type pg from "pg";
import { AuditService } from "../audit/audit.service.js";
import { Database } from "../db/database.js";
import { KEY_PROVIDER, type KeyProvider } from "../keys/key-provider.js";
import { SECRET_OVERLAP_MS, endpointSecret, formatSecret, previousSecretActive } from "./signature.js";
import { URL_RESOLVER } from "./tokens.js";
import { WebhookUrlError, assertWebhookUrl, type Resolver } from "./url-guard.js";

export type WebhookEvent = "consent.granted" | "consent.withdrawn" | "dsr.submitted" | "dsr.transitioned";
export const WEBHOOK_EVENTS: readonly WebhookEvent[] = ["consent.granted", "consent.withdrawn", "dsr.submitted", "dsr.transitioned"];
const MAX_ENDPOINTS = 10;
/** An endpoint is disabled when this many of its most recent finished deliveries, with none delivered among them, all failed for good. */
export const AUTO_DISABLE_AFTER = 10;
export const DELIVERY_STATES = ["pending", "delivered", "failed"] as const;
export type DeliveryState = (typeof DELIVERY_STATES)[number];
export const DEFAULT_DELIVERY_LIMIT = 50;
export const MAX_DELIVERY_LIMIT = 100;

export interface EndpointView {
  id: string;
  url: string;
  events: WebhookEvent[];
  createdAt: string;
  disabledAt: string | null;
  /** `admin` when the administrator disabled it (also for endpoints disabled before reasons were kept), `failures` when Saral did. */
  disabledReason: "admin" | "failures" | null;
  /** While a rotated secret's predecessor still signs deliveries as well, when that stops; otherwise null. */
  previousSecretUntil: string | null;
}

/** What the delivery log shows. The payload is left out on purpose: it is not needed to understand what happened. */
export interface DeliveryView {
  id: string;
  eventType: WebhookEvent;
  state: DeliveryState;
  attempts: number;
  createdAt: string;
  /** Only while pending: when the next try is due. */
  nextAttemptAt: string | null;
  deliveredAt: string | null;
  lastStatus: number | null;
  lastError: string | null;
}

type EndpointRow = {
  id: string;
  url: string;
  events: WebhookEvent[];
  created_at: Date;
  disabled_at: Date | null;
  disabled_reason: "admin" | "failures" | null;
  secret_version: number;
  rotated_at: Date | null;
};

function endpointView(e: EndpointRow, now: Date): EndpointView {
  return {
    id: e.id, url: e.url, events: e.events, createdAt: e.created_at.toISOString(),
    disabledAt: e.disabled_at ? e.disabled_at.toISOString() : null,
    // Endpoints disabled before reasons were kept have none recorded, and were disabled by their administrator.
    disabledReason: e.disabled_at === null ? null : (e.disabled_reason ?? "admin"),
    previousSecretUntil: e.rotated_at !== null && previousSecretActive(e.secret_version, e.rotated_at, now) ? new Date(e.rotated_at.getTime() + SECRET_OVERLAP_MS).toISOString() : null,
  };
}

@Injectable()
export class WebhookService {
  constructor(
    private readonly db: Database,
    private readonly audit: AuditService,
    @Inject(KEY_PROVIDER) private readonly keys: KeyProvider,
    @Inject(URL_RESOLVER) private readonly resolver: Resolver,
  ) {}

  /** Queues one delivery per subscribed, enabled endpoint, inside the caller's transaction. Payloads hold ids and states only. */
  async enqueue(c: pg.PoolClient, tenantId: string, type: WebhookEvent, data: Record<string, unknown>): Promise<number> {
    const endpoints = await c.query<{ id: string }>("SELECT id FROM webhook_endpoints WHERE disabled_at IS NULL AND $1 = ANY(events)", [type]);
    for (const e of endpoints.rows) {
      await c.query(
        "INSERT INTO webhook_deliveries (id, tenant_id, endpoint_id, event_type, payload) VALUES ($1, $2, $3, $4, $5)",
        [randomUUID(), tenantId, e.id, type, JSON.stringify(data)],
      );
    }
    return endpoints.rows.length;
  }

  async create(tenantId: string, actor: string, url: string, events: WebhookEvent[]): Promise<EndpointView & { secret: string }> {
    try {
      await assertWebhookUrl(url, this.resolver);
    } catch (e) {
      if (e instanceof WebhookUrlError) throw new UnprocessableEntityException({ error: "invalid_url", message: e.message });
      throw e;
    }
    const id = randomUUID();
    return this.db.inScope({ tenantId }, async (c) => {
      // Serialise per tenant, so two registrations cannot both see 9 endpoints and both insert the 10th and 11th.
      await c.query("SELECT audit_append_lock($1)", [tenantId]);
      const count = (await c.query<{ n: number }>("SELECT count(*)::int AS n FROM webhook_endpoints WHERE disabled_at IS NULL")).rows[0]?.n ?? 0;
      if (count >= MAX_ENDPOINTS) throw new ConflictException({ error: "too_many_endpoints", message: `a tenant may have at most ${String(MAX_ENDPOINTS)} active endpoints` });
      const row = (await c.query<{ created_at: Date }>("INSERT INTO webhook_endpoints (id, tenant_id, url, events) VALUES ($1, $2, $3, $4) RETURNING created_at", [id, tenantId, url, events])).rows[0] as { created_at: Date };
      await this.audit.append(c, tenantId, {
        actorType: "system", actorId: actor, action: "webhook.endpoint_created", refTable: "webhook_endpoints", refId: id,
        payloadSha256: sha256Hex(JSON.stringify(["saral.webhook_endpoint", 1, tenantId, id, url, [...events].sort(), 1])),
      });
      return { id, url, events, createdAt: row.created_at.toISOString(), disabledAt: null, disabledReason: null, previousSecretUntil: null, secret: formatSecret(endpointSecret(this.keys.webhookKey(), id, 1)) };
    });
  }

  /** Stops sending to an endpoint and frees its place in the cap. Events still waiting for it are closed by the worker. */
  async disable(tenantId: string, actor: string, id: string): Promise<void> {
    await this.db.inScope({ tenantId }, async (c) => {
      await c.query("SELECT audit_append_lock($1)", [tenantId]);
      const r = await c.query<{ url: string; events: WebhookEvent[]; secret_version: number }>(
        "UPDATE webhook_endpoints SET disabled_at = now(), disabled_reason = 'admin' WHERE id = $1 AND disabled_at IS NULL RETURNING url, events, secret_version", [id]);
      const e = r.rows[0];
      if (e === undefined) throw new NotFoundException({ error: "not_found", message: "endpoint not found" });
      await this.audit.append(c, tenantId, {
        actorType: "system", actorId: actor, action: "webhook.endpoint_disabled", refTable: "webhook_endpoints", refId: id,
        payloadSha256: sha256Hex(JSON.stringify(["saral.webhook_endpoint", 1, tenantId, id, e.url, [...e.events].sort(), e.secret_version])),
      });
    });
  }

  /**
   * Replaces the signing secret. The new one is shown once. By default the old one stops working at once (later deliveries are signed
   * with the new one only), which is what to choose if it has leaked. With `overlap` the old one keeps signing alongside the new one for
   * 24 hours, so a receiver can be switched over without missing a delivery. Only the secret just before the current one is kept, so
   * a second rotation ends the overlap of the first, and a rotation without `overlap` ends any overlap at once.
   */
  async rotate(tenantId: string, actor: string, id: string, overlap = false): Promise<{ id: string; secret: string; previousSecretValidUntil: string | null }> {
    return this.db.inScope({ tenantId }, async (c) => {
      await c.query("SELECT audit_append_lock($1)", [tenantId]);
      const r = await c.query<{ url: string; events: WebhookEvent[]; secret_version: number; rotated_at: Date | null }>(
        "UPDATE webhook_endpoints SET secret_version = secret_version + 1, rotated_at = CASE WHEN $2::boolean THEN now() ELSE NULL END WHERE id = $1 AND disabled_at IS NULL RETURNING url, events, secret_version, rotated_at",
        [id, overlap]);
      const e = r.rows[0];
      if (e === undefined) throw new NotFoundException({ error: "not_found", message: "endpoint not found" });
      await this.audit.append(c, tenantId, {
        actorType: "system", actorId: actor, action: "webhook.endpoint_rotated", refTable: "webhook_endpoints", refId: id,
        payloadSha256: sha256Hex(JSON.stringify(["saral.webhook_endpoint", 1, tenantId, id, e.url, [...e.events].sort(), e.secret_version, overlap])),
      });
      return {
        id, secret: formatSecret(endpointSecret(this.keys.webhookKey(), id, e.secret_version)),
        previousSecretValidUntil: e.rotated_at === null ? null : new Date(e.rotated_at.getTime() + SECRET_OVERLAP_MS).toISOString(),
      };
    });
  }

  /**
   * Switches a disabled endpoint on again, whether the administrator or Saral disabled it. The secret is the one it had (disabling and
   * enabling do not change it; rotate as well if it may have leaked). The address is checked again, since what a name points at can
   * change, and the cap of ten active endpoints is counted under the tenant lock as for a new endpoint.
   */
  async enable(tenantId: string, actor: string, id: string): Promise<EndpointView> {
    const url = await this.db.inScope({ tenantId }, async (c) => {
      const e = await this.requireEndpoint(c, id);
      if (e.disabled_at === null) throw new ConflictException({ error: "already_enabled", message: "this endpoint is already on" });
      return e.url;
    });
    try {
      await assertWebhookUrl(url, this.resolver);
    } catch (e) {
      if (e instanceof WebhookUrlError) throw new UnprocessableEntityException({ error: "invalid_url", message: e.message });
      throw e;
    }
    return this.db.inScope({ tenantId }, async (c) => {
      await c.query("SELECT audit_append_lock($1)", [tenantId]);
      const count = (await c.query<{ n: number }>("SELECT count(*)::int AS n FROM webhook_endpoints WHERE disabled_at IS NULL")).rows[0]?.n ?? 0;
      if (count >= MAX_ENDPOINTS) throw new ConflictException({ error: "too_many_endpoints", message: `a tenant may have at most ${String(MAX_ENDPOINTS)} active endpoints` });
      const r = await c.query<EndpointRow>(
        `UPDATE webhook_endpoints SET disabled_at = NULL, disabled_reason = NULL WHERE id = $1 AND disabled_at IS NOT NULL
         RETURNING id, url, events, created_at, disabled_at, disabled_reason, secret_version, rotated_at`, [id]);
      const e = r.rows[0];
      if (e === undefined) throw new ConflictException({ error: "already_enabled", message: "this endpoint is already on" });
      await this.audit.append(c, tenantId, {
        actorType: "system", actorId: actor, action: "webhook.endpoint_enabled", refTable: "webhook_endpoints", refId: id,
        payloadSha256: sha256Hex(JSON.stringify(["saral.webhook_endpoint", 1, tenantId, id, e.url, [...e.events].sort(), e.secret_version])),
      });
      return endpointView(e, new Date());
    });
  }

  async list(tenantId: string): Promise<EndpointView[]> {
    return this.db.inScope({ tenantId }, async (c) => {
      const r = await c.query<EndpointRow>("SELECT id, url, events, created_at, disabled_at, disabled_reason, secret_version, rotated_at FROM webhook_endpoints ORDER BY created_at, id");
      const now = new Date();
      return r.rows.map((e) => endpointView(e, now));
    });
  }

  /** The most recent deliveries of one endpoint, newest first, optionally of one state. Also for a disabled endpoint, so its history stays readable. */
  async deliveries(tenantId: string, endpointId: string, state: DeliveryState | undefined, limit: number): Promise<DeliveryView[]> {
    return this.db.inScope({ tenantId }, async (c) => {
      await this.requireEndpoint(c, endpointId);
      const r = await c.query<{ id: string; event_type: WebhookEvent; state: DeliveryState; attempts: number; created_at: Date; next_attempt_at: Date; delivered_at: Date | null; last_status: number | null; last_error: string | null }>(
        `SELECT id, event_type, state, attempts, created_at, next_attempt_at, delivered_at, last_status, last_error FROM webhook_deliveries
         WHERE endpoint_id = $1 AND ($2::text IS NULL OR state = $2) ORDER BY created_at DESC, id LIMIT $3`,
        [endpointId, state ?? null, limit],
      );
      return r.rows.map((d) => ({
        id: d.id, eventType: d.event_type, state: d.state, attempts: d.attempts, createdAt: d.created_at.toISOString(),
        nextAttemptAt: d.state === "pending" ? d.next_attempt_at.toISOString() : null,
        deliveredAt: d.delivered_at ? d.delivered_at.toISOString() : null, lastStatus: d.last_status, lastError: d.last_error,
      }));
    });
  }

  private async requireEndpoint(c: pg.PoolClient, endpointId: string): Promise<{ url: string; events: WebhookEvent[]; secret_version: number; disabled_at: Date | null }> {
    const e = (await c.query<{ url: string; events: WebhookEvent[]; secret_version: number; disabled_at: Date | null }>("SELECT url, events, secret_version, disabled_at FROM webhook_endpoints WHERE id = $1", [endpointId])).rows[0];
    if (e === undefined) throw new NotFoundException({ error: "not_found", message: "endpoint not found" });
    return e;
  }

  /**
   * Puts a failed delivery back in the queue with no attempts used, so the worker sends it again with the same idempotency key
   * (a receiver that already acted on it will recognise it). Only a failed delivery of an endpoint that is still enabled.
   * The database lets the application role do exactly this to a delivery, and nothing else.
   */
  async redeliver(tenantId: string, actor: string, endpointId: string, deliveryId: string): Promise<{ id: string; state: "pending" }> {
    return this.db.inScope({ tenantId }, async (c) => {
      await c.query("SELECT audit_append_lock($1)", [tenantId]);
      const endpoint = await this.requireEndpoint(c, endpointId);
      const d = (await c.query<{ state: DeliveryState }>("SELECT state FROM webhook_deliveries WHERE id = $1 AND endpoint_id = $2 FOR UPDATE", [deliveryId, endpointId])).rows[0];
      if (d === undefined) throw new NotFoundException({ error: "not_found", message: "delivery not found" });
      if (endpoint.disabled_at !== null) throw new ConflictException({ error: "endpoint_disabled", message: "this endpoint is disabled, so nothing can be sent to it" });
      if (d.state !== "failed") throw new ConflictException({ error: "not_failed", message: "only a delivery that has failed can be sent again" });
      await c.query("UPDATE webhook_deliveries SET state = 'pending', attempts = 0, next_attempt_at = now() WHERE id = $1", [deliveryId]);
      await this.audit.append(c, tenantId, {
        actorType: "system", actorId: actor, action: "webhook.delivery_redelivered", refTable: "webhook_deliveries", refId: deliveryId,
        payloadSha256: sha256Hex(JSON.stringify(["saral.webhook_delivery", 1, tenantId, endpointId, deliveryId, "redelivered"])),
      });
      return { id: deliveryId, state: "pending" as const };
    });
  }

  /**
   * Called by the worker when a delivery has just failed for good. If the endpoint's last ten finished deliveries have all
   * failed (a delivered one among them shows it still works for some events), it is disabled, for the same reason an administrator
   * would: nothing more is sent, and its waiting events are closed. The administrator can switch it on again.
   */
  async disableIfFailing(tenantId: string, endpointId: string): Promise<boolean> {
    return this.db.inScope({ tenantId }, async (c) => {
      await c.query("SELECT audit_append_lock($1)", [tenantId]);
      const recent = await c.query<{ state: DeliveryState }>(
        "SELECT state FROM webhook_deliveries WHERE endpoint_id = $1 AND state IN ('delivered', 'failed') ORDER BY created_at DESC, id LIMIT $2",
        [endpointId, AUTO_DISABLE_AFTER],
      );
      if (recent.rows.length < AUTO_DISABLE_AFTER || recent.rows.some((r) => r.state !== "failed")) return false;
      const r = await c.query<{ url: string; events: WebhookEvent[]; secret_version: number }>(
        "UPDATE webhook_endpoints SET disabled_at = now(), disabled_reason = 'failures' WHERE id = $1 AND disabled_at IS NULL RETURNING url, events, secret_version", [endpointId]);
      const e = r.rows[0];
      if (e === undefined) return false;
      await this.audit.append(c, tenantId, {
        actorType: "system", actorId: "system:webhook-worker", action: "webhook.endpoint_auto_disabled", refTable: "webhook_endpoints", refId: endpointId,
        payloadSha256: sha256Hex(JSON.stringify(["saral.webhook_endpoint", 1, tenantId, endpointId, e.url, [...e.events].sort(), e.secret_version])),
      });
      return true;
    });
  }
}
