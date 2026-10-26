import { randomBytes } from "node:crypto";
import { logger, safePath } from "../lib/logger.js";
import type { ErrorRequestHandler } from "express";
import { ZodError } from "zod";
import { localeFromRequest, translateText, tr } from "../i18n/index.js";

export class HttpError extends Error {
  constructor(
    public readonly status: number,
    public readonly code: string,
    message: string,
    public readonly details?: unknown,
  ) {
    super(message);
  }
}

export const badRequest = (message = tr("طلب غير صالح"), details?: unknown) =>
  new HttpError(400, "BAD_REQUEST", message, details);
export const unauthorized = (message = tr("يجب تسجيل الدخول")) =>
  new HttpError(401, "UNAUTHORIZED", message);
export const forbidden = (message = tr("ليست لديك صلاحية لتنفيذ هذا الإجراء")) =>
  new HttpError(403, "FORBIDDEN", message);
/** Used for records outside the caller's scope as well, so existence is not leaked. */
export const notFound = (message = tr("العنصر غير موجود")) => new HttpError(404, "NOT_FOUND", message);
export const conflict = (message = tr("البيانات متعارضة مع سجل موجود")) =>
  new HttpError(409, "CONFLICT", message);

type PgError = { code?: string; constraint?: string };

/** Localizes error texts for the request language (messages defined at module level, e.g. zod, are translated here). */
function localizeDetails(details: unknown, loc: "ar" | "en"): unknown {
  if (!Array.isArray(details)) return details;
  return details.map((d) => (d && typeof d === "object" && typeof (d as { message?: unknown }).message === "string" ? { ...d, message: translateText((d as { message: string }).message, loc) } : d));
}

export type IssueLike = { code: string; message: string; origin?: string; format?: string; expected?: string; minimum?: number | bigint; maximum?: number | bigint };
const ARABIC = /[\u0600-\u06FF]/;

/**
 * Our own validation messages are written in Arabic (catalog entries). Zod's
 * built-in messages are technical English ("Invalid input: expected string…"),
 * so they are replaced by a friendly message chosen by issue code — never shown raw.
 */
export function friendlyIssue(i: IssueLike): string {
  if (ARABIC.test(i.message)) return i.message;
  const n = (v: number | bigint | undefined) => (v === undefined ? "" : String(v));
  switch (i.code) {
    case "invalid_type":
      if (/received (null|undefined)/.test(i.message)) return tr("هذا الحقل مطلوب");
      if (i.expected === "int") return tr("يجب إدخال رقم صحيح");
      if (i.expected === "number") return tr("يجب إدخال رقم");
      return tr("القيمة المدخلة غير صالحة");
    case "too_small":
      if (i.origin === "string") return tr("النص قصير جدًا (الحد الأدنى {0} أحرف)", n(i.minimum));
      if (i.origin === "array" || i.origin === "set") return tr("اختر عنصرًا واحدًا على الأقل");
      return tr("يجب ألا تقل القيمة عن {0}", n(i.minimum));
    case "too_big":
      if (i.origin === "string") return tr("النص طويل جدًا (الحد الأقصى {0} حرفًا)", n(i.maximum));
      return tr("يجب ألا تزيد القيمة عن {0}", n(i.maximum));
    case "invalid_format":
      if (i.format === "email") return tr("بريد إلكتروني غير صالح");
      return tr("الصيغة غير صالحة");
    case "invalid_value":
      return tr("اختيار غير صالح");
    case "unrecognized_keys":
      return tr("الطلب يحتوي على حقول غير مسموحة");
    default:
      return tr("القيمة المدخلة غير صالحة");
  }
}

const NET_CODES = new Set(["ECONNREFUSED", "ECONNRESET", "ETIMEDOUT", "EPIPE", "ENOTFOUND", "EAI_AGAIN", "ECONNABORTED"]);

/** "unavailable" (connection class), "timeout" (statement cancelled), or null when the error is something else. */
export function databaseIssue(err: unknown): "unavailable" | "timeout" | null {
  for (let e: unknown = err, depth = 0; e && typeof e === "object" && depth < 4; e = (e as { cause?: unknown }).cause, depth++) {
    const { code, message } = e as { code?: string; message?: string };
    if (code === "57014") return "timeout";
    if (code && (code.startsWith("08") || ["57P01", "57P02", "57P03", "53300", "53400"].includes(code) || NET_CODES.has(code))) return "unavailable";
    if (typeof message === "string" && /timeout exceeded when trying to connect|Connection terminated|connection timeout|Client has encountered a connection error/i.test(message)) return "unavailable";
  }
  return null;
}

export const errorHandler: ErrorRequestHandler = (err, req, res, _next) => {
  const loc = localeFromRequest(req);
  if (err instanceof HttpError) {
    res.status(err.status).json({ error: { code: err.code, message: translateText(err.message, loc), details: localizeDetails(err.details, loc) } });
    return;
  }
  if (err instanceof ZodError) {
    res.status(400).json({
      error: {
        code: "VALIDATION_ERROR",
        message: translateText(tr("البيانات المدخلة غير صالحة"), loc),
        details: err.issues.map((i) => ({ path: i.path.join("."), message: translateText(friendlyIssue(i as unknown as IssueLike), loc) })),
      },
    });
    return;
  }
  // body-parser errors (malformed JSON, payload too large)
  if (typeof err === "object" && err && "type" in err) {
    const type = (err as { type: string }).type;
    if (type === "entity.parse.failed") {
      res.status(400).json({ error: { code: "BAD_JSON", message: tr("صيغة JSON غير صالحة") } });
      return;
    }
    if (type === "entity.too.large") {
      res.status(413).json({ error: { code: "PAYLOAD_TOO_LARGE", message: tr("حجم الطلب كبير جدًا") } });
      return;
    }
  }
  const pgErr = (err as { cause?: PgError }).cause ?? (err as PgError);
  if (pgErr?.code === "23505") {
    res.status(409).json({ error: { code: "CONFLICT", message: tr("يوجد سجل بنفس البيانات مسبقًا"), details: { constraint: pgErr.constraint } } });
    return;
  }
  if (pgErr?.code === "23503") {
    res.status(409).json({ error: { code: "CONFLICT", message: tr("لا يمكن تنفيذ العملية بسبب ارتباط بسجلات أخرى") } });
    return;
  }
  // The database is unreachable / overloaded / cut a statement short: a temporary condition, not a bug.
  // 503 + Retry-After lets browsers, the reverse proxy and monitors treat it as "try again", and nothing is retried here
  // (a blind retry of a write could duplicate it).
  const errorId = randomBytes(5).toString("hex");
  const dbIssue = databaseIssue(err);
  if (dbIssue) {
    logger.warn("database unavailable", { errorId, requestId: req.id, kind: dbIssue, method: req.method, path: safePath(req.originalUrl), err });
    res.setHeader("Retry-After", "5");
    res.status(503).json({ error: { code: dbIssue === "timeout" ? "DB_TIMEOUT" : "DB_UNAVAILABLE", message: tr("الخدمة غير متاحة مؤقتًا، حاول بعد لحظات"), errorId } });
    return;
  }
  // Never leak internals to the client; the error id ties the response to the structured log line.
  logger.error("unhandled error", { errorId, requestId: req.id, method: req.method, path: safePath(req.originalUrl), userId: req.session?.userId, err });
  res.status(500).json({ error: { code: "INTERNAL", message: tr("حدث خطأ غير متوقع"), errorId } });
};
