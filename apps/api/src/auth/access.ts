import { SetMetadata, createParamDecorator, type ExecutionContext } from "@nestjs/common";
import type { ApiKeyKind, Scope } from "./api-keys.js";

export const ACCESS_KEY = "saral:access";

export interface AccessRule {
  public?: boolean;
  scopes?: Scope[];
}

/** The caller may use the route if its key has at least one of these scopes. */
export const Scopes = (...scopes: Scope[]) => SetMetadata(ACCESS_KEY, { scopes } satisfies AccessRule);

/** Anyone may call the route. Every route must say so explicitly; a route with no rule is refused. */
export const Public = () => SetMetadata(ACCESS_KEY, { public: true } satisfies AccessRule);

export interface AuthContext {
  keyId: string;
  tenantId: string;
  kind: ApiKeyKind;
  scopes: Scope[];
}

export interface HttpRequest {
  headers: Record<string, string | string[] | undefined>;
  auth?: AuthContext;
}

export const Auth = createParamDecorator((_data: unknown, ctx: ExecutionContext): AuthContext => {
  const auth = ctx.switchToHttp().getRequest<HttpRequest>().auth;
  if (auth === undefined) throw new Error("Auth() used on a route without Scopes()");
  return auth;
});
