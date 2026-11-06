import { Injectable, type CanActivate, type ExecutionContext } from "@nestjs/common";
import { Reflector } from "@nestjs/core";
import type { HttpRequest } from "../auth/access.js";
import { clientKey } from "./client-key.js";
import { RateLimitService } from "./rate-limit.service.js";
import { SKIP_THROTTLE_KEY, THROTTLE_KEY } from "./throttle.js";

type Req = HttpRequest & { ip?: string };
type Res = { setHeader(name: string, value: string): unknown };

/**
 * Runs before the key or session is looked up, so a flood of made-up keys or passwords is refused without touching the
 * database or spending the time a password check takes. Counts by address: with no proxy in front that is the connection's
 * own address, and `X-Forwarded-For` is ignored unless TRUST_PROXY says how many proxies to believe.
 */
@Injectable()
export class IpRateLimitGuard implements CanActivate {
  constructor(
    private readonly reflector: Reflector,
    private readonly limits: RateLimitService,
  ) {}

  canActivate(context: ExecutionContext): boolean {
    const targets = [context.getHandler(), context.getClass()];
    if (this.reflector.getAllAndOverride<boolean | undefined>(SKIP_THROTTLE_KEY, targets) === true) return true;
    const http = context.switchToHttp();
    const res = http.getResponse<Res>();
    const who = clientKey(http.getRequest<Req>().ip);
    this.limits.check(res, `ip:${who}`, this.limits.limits.ip);
    if (this.reflector.getAllAndOverride<string | undefined>(THROTTLE_KEY, targets) === "auth") {
      this.limits.check(res, `auth:${who}`, this.limits.limits.auth);
    }
    return true;
  }
}

/** Runs after authentication: one key or one staff session is limited wherever it is used from. Requests that failed to authenticate never get here. */
@Injectable()
export class PrincipalRateLimitGuard implements CanActivate {
  constructor(private readonly limits: RateLimitService) {}

  canActivate(context: ExecutionContext): boolean {
    const http = context.switchToHttp();
    const auth = http.getRequest<Req>().auth;
    if (auth !== undefined) this.limits.check(http.getResponse<Res>(), `principal:${auth.keyId}`, this.limits.limits.principal);
    return true;
  }
}
