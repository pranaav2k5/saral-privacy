interface Window {
  count: number;
  resetAt: number;
}

export interface Verdict {
  allowed: boolean;
  /** Whole seconds until the window ends. Only meaningful when `allowed` is false. */
  retryAfterSec: number;
}

/**
 * Counts hits per key in fixed windows. The state is in this process only, so with several instances each one counts
 * separately and a caller can get up to that many times the limit. Memory is bounded: when the table is full, expired
 * keys go first and then the oldest key, so a flood of different keys cannot grow it without limit.
 */
export class FixedWindowLimiter {
  private readonly windows = new Map<string, Window>();

  constructor(
    private readonly now: () => number,
    private readonly maxKeys: number,
  ) {}

  get size(): number {
    return this.windows.size;
  }

  hit(key: string, limit: number, windowMs: number): Verdict {
    const t = this.now();
    let w = this.windows.get(key);
    if (w === undefined || t >= w.resetAt) {
      if (w === undefined) this.makeRoom(t);
      w = { count: 0, resetAt: t + windowMs };
      this.windows.set(key, w);
    }
    if (w.count >= limit) return { allowed: false, retryAfterSec: Math.max(1, Math.ceil((w.resetAt - t) / 1000)) };
    w.count++;
    return { allowed: true, retryAfterSec: 0 };
  }

  private makeRoom(t: number): void {
    if (this.windows.size < this.maxKeys) return;
    for (const [k, w] of this.windows) if (t >= w.resetAt) this.windows.delete(k);
    while (this.windows.size >= this.maxKeys) {
      const oldest = this.windows.keys().next();
      if (oldest.done) break;
      this.windows.delete(oldest.value);
    }
  }
}
