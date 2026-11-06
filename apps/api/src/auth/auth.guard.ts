import { ForbiddenException, Inject, Injectable, UnauthorizedException, type CanActivate, type ExecutionContext } from "@nestjs/common";
import { Reflector } from "@nestjs/core";
import { timingSafeEqual } from "node:crypto";
import { Database } from "../db/database.js";
import { KEY_PROVIDER, type KeyProvider } from "../keys/key-provider.js";
import { ACCESS_KEY, type AccessRule, type HttpRequest } from "./access.js";
import { hashSecret, parseApiKey, type Scope } from "./api-keys.js";

const INVALID = "invalid API key";
const NO_KEY = Buffer.alloc(32);

/**
 * Deny by default: a route needs `@Public()` or `@Scopes(...)`. Keys are checked by their HMAC in constant time,
 * and every failure to authenticate gets the same 401, so a caller learns nothing about which keys exist.
 */
@Injectable()
export class AuthGuard implements CanActivate {
  constructor(
    private readonly reflector: Reflector,
    private readonly db: Database,
    @Inject(KEY_PROVIDER) private readonly keys: KeyProvider,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const rule = this.reflector.getAllAndOverride<AccessRule | undefined>(ACCESS_KEY, [context.getHandler(), context.getClass()]);
    if (rule === undefined) throw new ForbiddenException("this route has no access rule");
    if (rule.public === true) return true;

    const req = context.switchToHttp().getRequest<HttpRequest>();
    const header = req.headers.authorization;
    const token = typeof header === "string" && header.startsWith("Bearer ") ? header.slice(7).trim() : "";
    const parsed = parseApiKey(token);
    if (parsed === null) throw new UnauthorizedException(INVALID);

    const row = await this.db.inScope({ apiKeyId: parsed.id }, async (c) => {
      const r = await c.query<{ tenant_id: string; kind: "publishable" | "secret"; scopes: Scope[]; secret_hmac: string; allowed_origins: string[]; revoked_at: Date | null }>(
        "SELECT tenant_id, kind, scopes, secret_hmac, allowed_origins, revoked_at FROM api_keys",
      );
      return r.rows[0];
    });
    const given = Buffer.from(hashSecret(this.keys.apiKeyPepper(), parsed.secret), "hex");
    const stored = row ? Buffer.from(row.secret_hmac, "hex") : NO_KEY;
    const matches = timingSafeEqual(given, stored.length === given.length ? stored : NO_KEY);
    if (!row || !matches || row.revoked_at !== null || row.kind !== parsed.kind) throw new UnauthorizedException(INVALID);

    if (row.kind === "publishable" && row.allowed_origins.length > 0) {
      const origin = req.headers.origin;
      if (typeof origin !== "string" || !row.allowed_origins.includes(origin)) {
        throw new ForbiddenException("this key may not be used from this origin");
      }
    }
    const wanted = rule.scopes ?? [];
    if (!wanted.some((s) => row.scopes.includes(s))) {
      throw new ForbiddenException(`this key needs one of the scopes: ${wanted.join(", ")}`);
    }
    req.auth = { keyId: parsed.id, tenantId: row.tenant_id, kind: row.kind, scopes: row.scopes };
    return true;
  }
}
