import { HttpException, Inject, Injectable } from "@nestjs/common";
import { FixedWindowLimiter } from "./limiter.js";
import { RATE_LIMITS, RATE_LIMIT_CLOCK, type Limits, type Policy } from "./policies.js";

const MAX_KEYS = 100_000;

@Injectable()
export class RateLimitService {
  private readonly limiter: FixedWindowLimiter;

  constructor(
    @Inject(RATE_LIMITS) readonly limits: Limits,
    @Inject(RATE_LIMIT_CLOCK) clock: () => number,
  ) {
    this.limiter = new FixedWindowLimiter(clock, MAX_KEYS);
  }

  /** Counts one request. Past the limit it answers 429 and says in a header and in words how long to wait. */
  check(res: { setHeader(name: string, value: string): unknown }, key: string, policy: Policy): void {
    const v = this.limiter.hit(key, policy.limit, policy.windowMs);
    if (v.allowed) return;
    res.setHeader("Retry-After", String(v.retryAfterSec));
    const s = v.retryAfterSec;
    throw new HttpException({ error: "rate_limited", message: `Too many requests. Try again in ${String(s)} ${s === 1 ? "second" : "seconds"}.` }, 429);
  }
}
