import { Body, Controller, ForbiddenException, Get, Headers, HttpCode, Param, Post, Res } from "@nestjs/common";
import { Auth, Scopes, type AuthContext } from "../auth/access.js";
import { bad, boolField, keyField, normalizeIdentifier, objectBody, uuidParam } from "../http/validate.js";
import { ConsentService } from "./consent.service.js";

const MAX_PURPOSES = 50;
const IDEMPOTENCY_KEY = /^[A-Za-z0-9_-]{8,128}$/;

@Controller("v1/consents")
export class ConsentsController {
  constructor(private readonly consents: ConsentService) {}

  /**
   * Records a consent and returns the signed receipt (a Kantara KI-CR-v1.1.0 JWT): 201. A retry that carries the same
   * `Idempotency-Key` header returns the first result unchanged (200), so a lost response is safe to retry. Without the
   * header every request is a new consent.
   */
  @Post()
  @Scopes("sdk")
  async grant(
    @Auth() auth: AuthContext,
    @Body() raw: unknown,
    @Res({ passthrough: true }) res: { status(code: number): unknown },
    @Headers("idempotency-key") idempotencyKey?: string,
  ) {
    if (idempotencyKey !== undefined && !IDEMPOTENCY_KEY.test(idempotencyKey)) {
      throw bad("Idempotency-Key", "must be 8 to 128 letters, digits, dashes or underscores");
    }
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
    const { reused, ...result } = await this.consents.grant(auth.tenantId, { noticeId, identifier, purposes, keyKind: auth.kind === "session" ? "secret" : auth.kind, ...(idempotencyKey !== undefined ? { idempotencyKey } : {}) });
    if (reused) res.status(200);
    return { ...result, status: "granted" as const };
  }

  /**
   * Withdraws every granted consent of the person, found by identifier alone (optionally for one notice). Secret keys only:
   * the identifier proves nothing about who is calling, and a publishable key is public. A tenant's server calls this
   * after it has verified the person itself.
   */
  @Post("withdraw")
  @HttpCode(200)
  @Scopes("sdk")
  withdrawAll(@Auth() auth: AuthContext, @Body() raw: unknown) {
    if (auth.kind !== "secret") {
      throw new ForbiddenException("this route needs a secret key: call it from your server after you have verified the person");
    }
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
