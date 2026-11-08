import { Body, Controller, Get, HttpCode, Param, Patch, Post } from "@nestjs/common";
import { Auth, Scopes, type AuthContext } from "../auth/access.js";
import { objectBody, uuidParam } from "../http/validate.js";
import { parseBoardNotified, parseClose, parsePatch, parsePrincipals, parseReport } from "./breach-input.js";
import { BreachService } from "./breach.service.js";

/**
 * Personal data breach incidents. The officer and the administrator may report, read and correct. Signing off and recording what was
 * done after it are the officer's, because they are the officer's word.
 */
@Controller("v1/breaches")
export class BreachesController {
  constructor(private readonly breaches: BreachService) {}

  @Post()
  @Scopes("dpo", "tenant_admin")
  report(@Auth() auth: AuthContext, @Body() raw: unknown) {
    return this.breaches.report(auth.tenantId, auth, parseReport(objectBody(raw), new Date()));
  }

  @Get()
  @Scopes("dpo", "tenant_admin")
  list(@Auth() auth: AuthContext) {
    return this.breaches.list(auth.tenantId);
  }

  @Get(":id/drafts")
  @Scopes("dpo", "tenant_admin")
  drafts(@Auth() auth: AuthContext, @Param("id") id: string) {
    return this.breaches.getDrafts(auth.tenantId, uuidParam(id, "id"));
  }

  @Get(":id")
  @Scopes("dpo", "tenant_admin")
  get(@Auth() auth: AuthContext, @Param("id") id: string) {
    return this.breaches.get(auth.tenantId, uuidParam(id, "id"));
  }

  @Patch(":id")
  @Scopes("dpo", "tenant_admin")
  update(@Auth() auth: AuthContext, @Param("id") id: string, @Body() raw: unknown) {
    return this.breaches.update(auth.tenantId, auth, uuidParam(id, "id"), parsePatch(objectBody(raw), new Date()));
  }

  @Post(":id/sign-off")
  @HttpCode(200)
  @Scopes("dpo")
  signOff(@Auth() auth: AuthContext, @Param("id") id: string) {
    return this.breaches.signOff(auth.tenantId, auth, uuidParam(id, "id"));
  }

  @Post(":id/board-notified")
  @HttpCode(200)
  @Scopes("dpo")
  boardNotified(@Auth() auth: AuthContext, @Param("id") id: string, @Body() raw: unknown) {
    const body = objectBody(raw);
    return this.breaches.boardNotified(auth.tenantId, auth, uuidParam(id, "id"), (discoveredAt) => parseBoardNotified(body, new Date(), discoveredAt));
  }

  @Post(":id/principals-notified")
  @HttpCode(200)
  @Scopes("dpo")
  principalsNotified(@Auth() auth: AuthContext, @Param("id") id: string, @Body() raw: unknown) {
    return this.breaches.principalsNotified(auth.tenantId, auth, uuidParam(id, "id"), parsePrincipals(objectBody(raw)));
  }

  @Post(":id/close")
  @HttpCode(200)
  @Scopes("dpo")
  close(@Auth() auth: AuthContext, @Param("id") id: string, @Body() raw: unknown) {
    return this.breaches.close(auth.tenantId, auth, uuidParam(id, "id"), parseClose(objectBody(raw)));
  }
}
