import { Body, Controller, Get, HttpCode, Param, Post, Query } from "@nestjs/common";
import { Auth, Scopes, type AuthContext } from "../auth/access.js";
import { bad, normalizeIdentifier, objectBody, uuidParam } from "../http/validate.js";
import { DsrService } from "./dsr.service.js";
import { DSR_STATES, DSR_TYPES, type DsrState, type DsrType } from "./state.js";

const MAX_DETAILS = 2000;
const MAX_REASON = 500;

@Controller("v1/dsr")
export class DsrController {
  constructor(private readonly dsr: DsrService) {}

  /** A person asks for access, correction, erasure, nomination or to complain. The same answer whoever they are. */
  @Post()
  @Scopes("sdk")
  submit(@Auth() auth: AuthContext, @Body() raw: unknown) {
    const body = objectBody(raw);
    if (!DSR_TYPES.includes(body.type as DsrType)) throw bad("type", `must be one of: ${DSR_TYPES.join(", ")}`);
    const identifier = normalizeIdentifier(body.identifier);
    if (body.details !== undefined && (typeof body.details !== "string" || body.details.length > MAX_DETAILS)) {
      throw bad("details", `must be text of at most ${String(MAX_DETAILS)} characters`);
    }
    return this.dsr.submit(auth.tenantId, { type: body.type as DsrType, identifier, ...(typeof body.details === "string" ? { details: body.details } : {}) });
  }

  /** The data protection officer's queue, soonest due first. */
  @Get()
  @Scopes("dpo")
  list(@Auth() auth: AuthContext, @Query("state") state?: string, @Query("overdue") overdue?: string) {
    if (state !== undefined && !DSR_STATES.includes(state as DsrState)) throw bad("state", `must be one of: ${DSR_STATES.join(", ")}`);
    if (overdue !== undefined && overdue !== "true" && overdue !== "false") throw bad("overdue", "must be true or false");
    return this.dsr.list(auth.tenantId, { ...(state !== undefined ? { state: state as DsrState } : {}), ...(overdue === "true" ? { overdue: true } : {}) });
  }

  @Get(":id")
  @Scopes("dpo")
  get(@Auth() auth: AuthContext, @Param("id") id: string) {
    return this.dsr.get(auth.tenantId, uuidParam(id, "id"));
  }

  @Post(":id/transition")
  @HttpCode(200)
  @Scopes("dpo")
  transition(@Auth() auth: AuthContext, @Param("id") id: string, @Body() raw: unknown) {
    const requestId = uuidParam(id, "id");
    const body = objectBody(raw);
    if (!DSR_STATES.includes(body.to as DsrState)) throw bad("to", `must be one of: ${DSR_STATES.join(", ")}`);
    if (body.reason !== undefined && (typeof body.reason !== "string" || body.reason.length > MAX_REASON)) {
      throw bad("reason", `must be text of at most ${String(MAX_REASON)} characters`);
    }
    if (body.to === "rejected" && (typeof body.reason !== "string" || body.reason.trim() === "")) throw bad("reason", "a rejection needs a reason");
    return this.dsr.transition(auth.tenantId, auth.keyId, requestId, body.to as DsrState, typeof body.reason === "string" ? body.reason : undefined);
  }

  /** Shows the person's contact to the data protection officer. Every read is an audit event. */
  @Post(":id/reveal-contact")
  @HttpCode(200)
  @Scopes("dpo")
  reveal(@Auth() auth: AuthContext, @Param("id") id: string) {
    return this.dsr.revealContact(auth.tenantId, auth.keyId, uuidParam(id, "id"));
  }
}
