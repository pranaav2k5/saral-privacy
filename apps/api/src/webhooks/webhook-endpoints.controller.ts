import { Body, Controller, Delete, Get, HttpCode, Param, Post, Query } from "@nestjs/common";
import { Auth, Scopes, type AuthContext } from "../auth/access.js";
import { bad, objectBody, uuidParam } from "../http/validate.js";
import { DEFAULT_DELIVERY_LIMIT, DELIVERY_STATES, MAX_DELIVERY_LIMIT, WEBHOOK_EVENTS, WebhookService, type DeliveryState, type WebhookEvent } from "./webhook.service.js";

@Controller("v1/webhook-endpoints")
export class WebhookEndpointsController {
  constructor(private readonly webhooks: WebhookService) {}

  /** Registers an https endpoint. The signing secret is in the response and is not shown again. */
  @Post()
  @Scopes("tenant_admin")
  create(@Auth() auth: AuthContext, @Body() raw: unknown) {
    const body = objectBody(raw);
    if (typeof body.url !== "string") throw bad("url", "must be a string");
    if (!Array.isArray(body.events) || body.events.length < 1 || body.events.length > WEBHOOK_EVENTS.length) {
      throw bad("events", `must list 1 to ${String(WEBHOOK_EVENTS.length)} of: ${WEBHOOK_EVENTS.join(", ")}`);
    }
    const events = body.events as unknown[];
    if (!events.every((e): e is WebhookEvent => WEBHOOK_EVENTS.includes(e as WebhookEvent))) throw bad("events", `unknown event; use: ${WEBHOOK_EVENTS.join(", ")}`);
    if (new Set(events).size !== events.length) throw bad("events", "an event is listed twice");
    return this.webhooks.create(auth.tenantId, auth.actor, body.url, events);
  }

  @Get()
  @Scopes("tenant_admin")
  list(@Auth() auth: AuthContext) {
    return this.webhooks.list(auth.tenantId);
  }

  /** Disables an endpoint: nothing more is sent to it, and its place in the cap is free again. */
  @Delete(":id")
  @HttpCode(204)
  @Scopes("tenant_admin")
  async disable(@Auth() auth: AuthContext, @Param("id") id: string): Promise<void> {
    await this.webhooks.disable(auth.tenantId, auth.actor, uuidParam(id, "id"));
  }

  /** The most recent deliveries of one endpoint, newest first, without their payloads. */
  @Get(":id/deliveries")
  @Scopes("tenant_admin")
  deliveries(@Auth() auth: AuthContext, @Param("id") id: string, @Query("state") state?: unknown, @Query("limit") limit?: unknown) {
    const endpointId = uuidParam(id, "id");
    if (state !== undefined && !DELIVERY_STATES.includes(state as DeliveryState)) throw bad("state", `must be one of: ${DELIVERY_STATES.join(", ")}`);
    let n = DEFAULT_DELIVERY_LIMIT;
    if (limit !== undefined) {
      if (typeof limit !== "string" || !/^[1-9][0-9]{0,2}$/.test(limit) || Number(limit) > MAX_DELIVERY_LIMIT) throw bad("limit", `must be a whole number from 1 to ${String(MAX_DELIVERY_LIMIT)}`);
      n = Number(limit);
    }
    return this.webhooks.deliveries(auth.tenantId, endpointId, state as DeliveryState | undefined, n);
  }

  /** Sends a failed delivery again: it goes back in the queue with its attempts unused. */
  @Post(":id/deliveries/:deliveryId/redeliver")
  @HttpCode(200)
  @Scopes("tenant_admin")
  redeliver(@Auth() auth: AuthContext, @Param("id") id: string, @Param("deliveryId") deliveryId: string) {
    return this.webhooks.redeliver(auth.tenantId, auth.actor, uuidParam(id, "id"), uuidParam(deliveryId, "deliveryId"));
  }

  /** Issues a new signing secret, shown once. The old secret stops working at once. */
  @Post(":id/rotate-secret")
  @HttpCode(200)
  @Scopes("tenant_admin")
  rotate(@Auth() auth: AuthContext, @Param("id") id: string) {
    return this.webhooks.rotate(auth.tenantId, auth.actor, uuidParam(id, "id"));
  }
}
