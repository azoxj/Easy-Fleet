import { sql } from "drizzle-orm";
import type { NextFunction, Request, Response } from "express";
import { db } from "../db/client.js";
import { HttpError } from "../http/errors.js";

/**
 * Fixed-window rate limiter backed by PostgreSQL (table rate_limits), so the
 * limit is shared by every app instance. Used for security-sensitive paths
 * (login, password changes, uploads, public handover links, GPS pings).
 * The general API limiter stays in memory for speed.
 */
export class PgRateLimiter {
  constructor(
    private readonly prefix: string,
    readonly limit: number,
    private readonly windowMs: number,
  ) {}

  private k(key: string) {
    return `${this.prefix}:${key}`.slice(0, 300);
  }

  /** Records a hit; returns ms until the window resets when over the limit, else 0. */
  async hit(key: string): Promise<number> {
    const w = `${this.windowMs} milliseconds`;
    const r = await db.execute<{ count: number; ms: number }>(sql`
      insert into rate_limits (key, window_start, count) values (${this.k(key)}, now(), 1)
      on conflict (key) do update set
        count = case when rate_limits.window_start <= now() - ${w}::interval then 1 else rate_limits.count + 1 end,
        window_start = case when rate_limits.window_start <= now() - ${w}::interval then now() else rate_limits.window_start end
      returning count, greatest(0, extract(epoch from (window_start + ${w}::interval - now())) * 1000)::float8 as ms`);
    const row = r.rows[0]!;
    return row.count > this.limit ? Math.max(1, Math.ceil(row.ms)) : 0;
  }

  /** ms until reset if the key is already at/over the limit (no hit recorded). */
  async blocked(key: string): Promise<number> {
    const w = `${this.windowMs} milliseconds`;
    const r = await db.execute<{ count: number; ms: number }>(sql`
      select count, greatest(0, extract(epoch from (window_start + ${w}::interval - now())) * 1000)::float8 as ms
        from rate_limits where key = ${this.k(key)} and window_start > now() - ${w}::interval`);
    const row = r.rows[0];
    return row && row.count >= this.limit ? Math.max(1, Math.ceil(row.ms)) : 0;
  }

  async reset(key: string): Promise<void> {
    await db.execute(sql`delete from rate_limits where key = ${this.k(key)}`);
  }
}

export function pgRateLimit(limiter: PgRateLimiter, keyFn: (req: Request) => string, onLimited?: (req: Request) => Promise<void>) {
  return async (req: Request, res: Response, next: NextFunction) => {
    try {
      const wait = await limiter.hit(keyFn(req));
      if (wait > 0) {
        res.setHeader("Retry-After", Math.ceil(wait / 1000).toString());
        if (onLimited) await onLimited(req).catch(() => undefined);
        return next(new HttpError(429, "RATE_LIMITED", "عدد الطلبات كبير، حاول لاحقًا"));
      }
      next();
    } catch (e) {
      next(e);
    }
  };
}

/** Upload limiter shared by every file endpoint (per user). */
export const uploadLimiter = new PgRateLimiter("upload", 60, 10 * 60_000);
export const uploadRateLimit = pgRateLimit(uploadLimiter, (req) => req.session?.userId ?? req.ip ?? "anon");
