import { HttpException, Inject, Injectable, Optional } from "@nestjs/common";
import { FixedWindowLimiter } from "./limiter.js";
import { RATE_LIMITS, RATE_LIMIT_CLOCK, type Limits } from "./policies.js";

export const RATE_LIMIT_MAX_KEYS = Symbol("RATE_LIMIT_MAX_KEYS");
const MAX_KEYS = 100_000;

type Bucket = keyof Limits;

@Injectable()
export class RateLimitService {
  /** One table per bucket, so that filling one with keys (a flood of addresses) cannot make another forget its counts. */
  private readonly tables: Record<Bucket, FixedWindowLimiter>;

  constructor(
    @Inject(RATE_LIMITS) private readonly limits: Limits,
    @Inject(RATE_LIMIT_CLOCK) clock: () => number,
    @Optional() @Inject(RATE_LIMIT_MAX_KEYS) maxKeys: number = MAX_KEYS,
  ) {
    this.tables = { ip: new FixedWindowLimiter(clock, maxKeys), auth: new FixedWindowLimiter(clock, maxKeys), principal: new FixedWindowLimiter(clock, maxKeys) };
  }

  /** Counts one request in a bucket. Past its limit it answers 429 and says in a header and in words how long to wait. */
  check(res: { setHeader(name: string, value: string): unknown }, bucket: Bucket, key: string): void {
    const policy = this.limits[bucket];
    const v = this.tables[bucket].hit(key, policy.limit, policy.windowMs);
    if (v.allowed) return;
    res.setHeader("Retry-After", String(v.retryAfterSec));
    const s = v.retryAfterSec;
    throw new HttpException({ error: "rate_limited", message: `Too many requests. Try again in ${String(s)} ${s === 1 ? "second" : "seconds"}.` }, 429);
  }
}
