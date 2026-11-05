import { Body, Controller, Get, HttpCode, Param, Post, Res } from "@nestjs/common";
import { Auth, Scopes, type AuthContext } from "../auth/access.js";
import { bad, boolField, keyField, normalizeIdentifier, objectBody, uuidParam } from "../http/validate.js";
import { ConsentService } from "./consent.service.js";

const MAX_PURPOSES = 50;

@Controller("v1/consents")
export class ConsentsController {
  constructor(private readonly consents: ConsentService) {}

  /**
   * Records a consent and returns the signed receipt (a Kantara KI-CR-v1.1.0 JWT): 201. If the same person already has an
   * identical granted consent for the notice it is returned unchanged: 200, so a retry after a lost response is safe.
   */
  @Post()
  @Scopes("sdk")
  async grant(@Auth() auth: AuthContext, @Body() raw: unknown, @Res({ passthrough: true }) res: { status(code: number): unknown }) {
    const body = objectBody(raw);
    const noticeId = uuidParam(body.noticeId, "noticeId");
    const identifier = normalizeIdentifier(body.identifier);
    if (!Array.isArray(body.purposes) || body.purposes.length < 1 || body.purposes.length > MAX_PURPOSES) {
      throw bad("purposes", `must be an array of 1 to ${String(MAX_PURPOSES)} purposes`);
    }
    const seen = new Set<string>();
    const purposes = (body.purposes as unknown[]).map((p, i) => {
      const o = objectBody(p, `purposes[${String(i)}]`);
      const key = keyField(o.key, `purposes[${String(i)}].key`);
      if (seen.has(key)) throw bad(`purposes[${String(i)}].key`, `${key} appears twice`);
      seen.add(key);
      return { key, granted: boolField(o.granted, `purposes[${String(i)}].granted`) };
    });
    const { reused, ...result } = await this.consents.grant(auth.tenantId, { noticeId, identifier, purposes, keyKind: auth.kind });
    if (reused) res.status(200);
    return { ...result, status: "granted" as const };
  }

  /** Withdraws every granted consent of the person, found by identifier alone (optionally for one notice). */
  @Post("withdraw")
  @HttpCode(200)
  @Scopes("sdk")
  withdrawAll(@Auth() auth: AuthContext, @Body() raw: unknown) {
    const body = objectBody(raw);
    const identifier = normalizeIdentifier(body.identifier);
    const noticeId = body.noticeId === undefined ? undefined : uuidParam(body.noticeId, "noticeId");
    return this.consents.withdrawAll(auth.tenantId, identifier, noticeId);
  }

  /** Withdraws a consent as easily as it was given. The caller proves who they are with the same identifier. */
  @Post(":id/withdraw")
  @HttpCode(200)
  @Scopes("sdk")
  withdraw(@Auth() auth: AuthContext, @Param("id") id: string, @Body() raw: unknown) {
    const consentId = uuidParam(id, "id");
    const identifier = normalizeIdentifier(objectBody(raw).identifier);
    return this.consents.withdraw(auth.tenantId, consentId, identifier);
  }

  @Get(":id/receipt")
  @Scopes("tenant_admin")
  receipt(@Auth() auth: AuthContext, @Param("id") id: string) {
    return this.consents.receipt(auth.tenantId, uuidParam(id, "id"));
  }
}
