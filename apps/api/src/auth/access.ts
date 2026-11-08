import { SetMetadata, createParamDecorator, type ExecutionContext } from "@nestjs/common";
import type { ApiKeyKind, Scope } from "./api-keys.js";

export const ACCESS_KEY = "saral:access";
export const PENDING_PASSWORD_KEY = "saral:pending-password";

export interface AccessRule {
  public?: boolean;
  scopes?: Scope[];
}

/** The caller may use the route if its key has at least one of these scopes. */
export const Scopes = (...scopes: Scope[]) => SetMetadata(ACCESS_KEY, { scopes } satisfies AccessRule);

/** A session whose password must still be changed may use this route. Every other route refuses it until the password is changed. */
export const AllowPendingPasswordChange = () => SetMetadata(PENDING_PASSWORD_KEY, true);

/** Anyone may call the route. Every route must say so explicitly; a route with no rule is refused. */
export const Public = () => SetMetadata(ACCESS_KEY, { public: true } satisfies AccessRule);

export interface AuthContext {
  /** Who is acting, for audit entries: `api-key:<id>` or `staff:<id>`. */
  actor: string;
  /** The key's id, or the staff user's id. */
  keyId: string;
  tenantId: string;
  kind: ApiKeyKind | "session";
  scopes: Scope[];
  /** Sessions only: the staff role, when the person last signed in with a password and a code (seconds), and the session version. */
  role?: "tenant_admin" | "dpo";
  authAt?: number;
  sessionVersion?: number;
  /** Sessions only: the person is still using a password an operator gave them. */
  mustChangePassword?: boolean;
}

export interface HttpRequest {
  headers: Record<string, string | string[] | undefined>;
  /** The caller's address as Express works it out (it reads `X-Forwarded-For` only when told to trust a proxy). */
  ip?: string;
  auth?: AuthContext;
}

export const Auth = createParamDecorator((_data: unknown, ctx: ExecutionContext): AuthContext => {
  const auth = ctx.switchToHttp().getRequest<HttpRequest>().auth;
  if (auth === undefined) throw new Error("Auth() used on a route without Scopes()");
  return auth;
});
