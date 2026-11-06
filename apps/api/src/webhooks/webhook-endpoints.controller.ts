import { Body, Controller, Delete, Get, HttpCode, Param, Post } from "@nestjs/common";
import { Auth, Scopes, type AuthContext } from "../auth/access.js";
import { bad, objectBody, uuidParam } from "../http/validate.js";
import { WEBHOOK_EVENTS, WebhookService, type WebhookEvent } from "./webhook.service.js";

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
    return this.webhooks.create(auth.tenantId, auth.keyId, body.url, events);
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
    await this.webhooks.disable(auth.tenantId, auth.keyId, uuidParam(id, "id"));
  }

  /** Issues a new signing secret, shown once. The old secret stops working at once. */
  @Post(":id/rotate-secret")
  @HttpCode(200)
  @Scopes("tenant_admin")
  rotate(@Auth() auth: AuthContext, @Param("id") id: string) {
    return this.webhooks.rotate(auth.tenantId, auth.keyId, uuidParam(id, "id"));
  }
}
