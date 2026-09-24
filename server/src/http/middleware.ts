import type { NextFunction, Request, RequestHandler, Response } from "express";
import { loadAccess } from "../auth/access.js";
import type { PermissionKey } from "../auth/permissions.js";
import { readCookie, resolveSession, safeEqual, SESSION_COOKIE } from "../auth/session.js";
import { config } from "../config.js";
import { db } from "../db/client.js";
import { RateLimiter } from "../lib/rate-limit.js";
import { forbidden, HttpError, unauthorized } from "./errors.js";

export const securityHeaders: RequestHandler = (_req, res, next) => {
  res.setHeader("X-Content-Type-Options", "nosniff");
  res.setHeader("X-Frame-Options", "DENY");
  res.setHeader("Referrer-Policy", "same-origin");
  res.setHeader("Cross-Origin-Opener-Policy", "same-origin");
  res.setHeader("Cross-Origin-Resource-Policy", "same-origin");
  res.setHeader("Permissions-Policy", "camera=(self), geolocation=(self), microphone=()");
  res.setHeader(
    "Content-Security-Policy",
    [
      "default-src 'self'",
      "img-src 'self' data: blob:",
      "style-src 'self' 'unsafe-inline' https://fonts.googleapis.com",
      "font-src 'self' https://fonts.gstatic.com",
      "script-src 'self'",
      "connect-src 'self'",
      "frame-ancestors 'none'",
      "base-uri 'self'",
      "form-action 'self'",
      "object-src 'none'",
    ].join("; "),
  );
  if (config.COOKIE_SECURE) res.setHeader("Strict-Transport-Security", "max-age=31536000; includeSubDomains");
  next();
};

export const noStore: RequestHandler = (_req, res, next) => {
  res.setHeader("Cache-Control", "no-store");
  next();
};

const UNSAFE = new Set(["POST", "PUT", "PATCH", "DELETE"]);

/**
 * Cross-site request protection for state-changing requests:
 * rejects foreign Origins and cross-site Sec-Fetch-Site. Combined with
 * SameSite=Strict cookies and the per-session CSRF token (below).
 */
export const originCheck: RequestHandler = (req, _res, next) => {
  if (!UNSAFE.has(req.method)) return next();
  const origin = req.get("origin");
  if (origin && !config.appOrigins.includes(origin)) {
    const self = `${req.protocol}://${req.get("host")}`;
    if (origin !== self) return next(forbidden("مصدر الطلب غير مسموح"));
  }
  const site = req.get("sec-fetch-site");
  if (site && site !== "same-origin" && site !== "same-site" && site !== "none") {
    return next(forbidden("مصدر الطلب غير مسموح"));
  }
  next();
};

/** Attaches req.session + req.access when a valid session cookie is present. */
export const loadSession: RequestHandler = async (req, _res, next) => {
  const token = readCookie(req.headers.cookie, SESSION_COOKIE);
  if (!token) return next();
  const session = await resolveSession(db, token);
  if (session) {
    req.session = session;
    req.access = await loadAccess(db, session.userId, session.orgId);
  }
  next();
};

/** Paths reachable while the user is forced to change their password. */
const PASSWORD_CHANGE_ALLOWED = new Set(["/api/auth/me", "/api/auth/logout", "/api/auth/change-password"]);

export const requireAuth: RequestHandler = (req, _res, next) => {
  if (!req.session || !req.access) return next(unauthorized());
  if (UNSAFE.has(req.method)) {
    const header = req.get("x-csrf-token") ?? "";
    if (!safeEqual(header, req.session.csrfToken)) {
      return next(new HttpError(403, "CSRF", "رمز الحماية غير صالح، أعد تحميل الصفحة"));
    }
  }
  if (req.session.mustChangePassword && !PASSWORD_CHANGE_ALLOWED.has(req.originalUrl.split("?")[0]!)) {
    return next(new HttpError(403, "PASSWORD_CHANGE_REQUIRED", "يجب تغيير كلمة المرور أولًا"));
  }
  next();
};

export function requirePermission(perm: PermissionKey): RequestHandler {
  return (req, _res, next) => {
    if (!req.access) return next(unauthorized());
    if (!req.access.has(perm)) return next(forbidden());
    next();
  };
}

export function rateLimit(limiter: RateLimiter, keyFn: (req: Request) => string = (r) => r.ip ?? "unknown") {
  return (req: Request, res: Response, next: NextFunction) => {
    const wait = limiter.hit(keyFn(req));
    if (wait > 0) {
      res.setHeader("Retry-After", Math.ceil(wait / 1000).toString());
      return next(new HttpError(429, "RATE_LIMITED", "عدد الطلبات كبير، حاول لاحقًا"));
    }
    next();
  };
}
