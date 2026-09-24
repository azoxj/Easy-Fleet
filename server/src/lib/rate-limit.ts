/**
 * Minimal fixed-window rate limiter kept in process memory.
 * Adequate for a single-instance internal deployment; swap the store for
 * Redis when running multiple instances (the interface stays the same).
 */
export class RateLimiter {
  private hits = new Map<string, { count: number; resetAt: number }>();

  constructor(
    private readonly limit: number,
    private readonly windowMs: number,
  ) {
    const timer = setInterval(() => this.sweep(), Math.min(windowMs, 60_000));
    timer.unref();
  }

  /** Records a hit; returns ms until reset when the limit is exceeded, else 0. */
  hit(key: string, now = Date.now()): number {
    const entry = this.hits.get(key);
    if (!entry || entry.resetAt <= now) {
      this.hits.set(key, { count: 1, resetAt: now + this.windowMs });
      return 0;
    }
    entry.count += 1;
    return entry.count > this.limit ? entry.resetAt - now : 0;
  }

  /** Returns ms until reset if already over the limit, without recording a hit. */
  blocked(key: string, now = Date.now()): number {
    const entry = this.hits.get(key);
    if (!entry || entry.resetAt <= now) return 0;
    return entry.count >= this.limit ? entry.resetAt - now : 0;
  }

  reset(key: string): void {
    this.hits.delete(key);
  }

  clear(): void {
    this.hits.clear();
  }

  private sweep(now = Date.now()) {
    for (const [k, v] of this.hits) if (v.resetAt <= now) this.hits.delete(k);
  }
}
