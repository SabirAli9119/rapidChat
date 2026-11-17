/**
 * A small in-memory limiter: at most `limit` actions per `windowMs` for each key.
 * Express limiters cannot see Socket.IO events, so the socket layer uses this one.
 * It lives in this process only, which matches the single-server setup used elsewhere.
 */
export class FixedWindowLimiter {
  private readonly windows = new Map<string, { count: number; resetAt: number }>();

  constructor(
    private readonly limit: number,
    private readonly windowMs: number,
  ) {}

  /** Records one attempt. When it is refused, retryAfterMs says how long until the window resets. */
  consume(key: string, now: number = Date.now()): { allowed: boolean; retryAfterMs: number } {
    if (this.windows.size > 10_000) this.prune(now);

    const current = this.windows.get(key);
    if (!current || current.resetAt <= now) {
      this.windows.set(key, { count: 1, resetAt: now + this.windowMs });
      return { allowed: true, retryAfterMs: 0 };
    }
    if (current.count >= this.limit) {
      return { allowed: false, retryAfterMs: current.resetAt - now };
    }
    current.count++;
    return { allowed: true, retryAfterMs: 0 };
  }

  private prune(now: number): void {
    for (const [key, window] of this.windows) {
      if (window.resetAt <= now) this.windows.delete(key);
    }
  }
}