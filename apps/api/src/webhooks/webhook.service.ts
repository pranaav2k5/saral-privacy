import { ConflictException, Inject, Injectable, UnprocessableEntityException } from "@nestjs/common";
import { randomUUID } from "node:crypto";
import { sha256Hex } from "@saral/audit-chain";
import type pg from "pg";
import { AuditService } from "../audit/audit.service.js";
import { Database } from "../db/database.js";
import { KEY_PROVIDER, type KeyProvider } from "../keys/key-provider.js";
import { endpointSecret, formatSecret } from "./signature.js";
import { URL_RESOLVER } from "./tokens.js";
import { WebhookUrlError, assertWebhookUrl, type Resolver } from "./url-guard.js";

export type WebhookEvent = "consent.granted" | "consent.withdrawn";
export const WEBHOOK_EVENTS: readonly WebhookEvent[] = ["consent.granted", "consent.withdrawn"];
const MAX_ENDPOINTS = 10;

export interface EndpointView {
  id: string;
  url: string;
  events: WebhookEvent[];
  createdAt: string;
  disabledAt: string | null;
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

  async create(tenantId: string, keyId: string, url: string, events: WebhookEvent[]): Promise<EndpointView & { secret: string }> {
    try {
      await assertWebhookUrl(url, this.resolver);
    } catch (e) {
      if (e instanceof WebhookUrlError) throw new UnprocessableEntityException({ error: "invalid_url", message: e.message });
      throw e;
    }
    const id = randomUUID();
    return this.db.inScope({ tenantId }, async (c) => {
      const count = (await c.query<{ n: number }>("SELECT count(*)::int AS n FROM webhook_endpoints WHERE disabled_at IS NULL")).rows[0]?.n ?? 0;
      if (count >= MAX_ENDPOINTS) throw new ConflictException({ error: "too_many_endpoints", message: `a tenant may have at most ${String(MAX_ENDPOINTS)} active endpoints` });
      const row = (await c.query<{ created_at: Date }>("INSERT INTO webhook_endpoints (id, tenant_id, url, events) VALUES ($1, $2, $3, $4) RETURNING created_at", [id, tenantId, url, events])).rows[0] as { created_at: Date };
      await this.audit.append(c, tenantId, {
        actorType: "system", actorId: `api-key:${keyId}`, action: "webhook.endpoint_created", refTable: "webhook_endpoints", refId: id,
        payloadSha256: sha256Hex(JSON.stringify(["saral.webhook_endpoint", 1, tenantId, id, url, [...events].sort(), 1])),
      });
      return { id, url, events, createdAt: row.created_at.toISOString(), disabledAt: null, secret: formatSecret(endpointSecret(this.keys.webhookKey(), id, 1)) };
    });
  }

  async list(tenantId: string): Promise<EndpointView[]> {
    return this.db.inScope({ tenantId }, async (c) => {
      const r = await c.query<{ id: string; url: string; events: WebhookEvent[]; created_at: Date; disabled_at: Date | null }>("SELECT id, url, events, created_at, disabled_at FROM webhook_endpoints ORDER BY created_at");
      return r.rows.map((e) => ({ id: e.id, url: e.url, events: e.events, createdAt: e.created_at.toISOString(), disabledAt: e.disabled_at ? e.disabled_at.toISOString() : null }));
    });
  }
}
