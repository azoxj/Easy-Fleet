import type { ErrorRequestHandler } from "express";
import { ZodError } from "zod";

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

export const badRequest = (message = "طلب غير صالح", details?: unknown) =>
  new HttpError(400, "BAD_REQUEST", message, details);
export const unauthorized = (message = "يجب تسجيل الدخول") =>
  new HttpError(401, "UNAUTHORIZED", message);
export const forbidden = (message = "ليست لديك صلاحية لتنفيذ هذا الإجراء") =>
  new HttpError(403, "FORBIDDEN", message);
/** Used for records outside the caller's scope as well, so existence is not leaked. */
export const notFound = (message = "العنصر غير موجود") => new HttpError(404, "NOT_FOUND", message);
export const conflict = (message = "البيانات متعارضة مع سجل موجود") =>
  new HttpError(409, "CONFLICT", message);

type PgError = { code?: string; constraint?: string };

export const errorHandler: ErrorRequestHandler = (err, _req, res, _next) => {
  if (err instanceof HttpError) {
    res.status(err.status).json({ error: { code: err.code, message: err.message, details: err.details } });
    return;
  }
  if (err instanceof ZodError) {
    res.status(400).json({
      error: {
        code: "VALIDATION_ERROR",
        message: "البيانات المدخلة غير صالحة",
        details: err.issues.map((i) => ({ path: i.path.join("."), message: i.message })),
      },
    });
    return;
  }
  // body-parser errors (malformed JSON, payload too large)
  if (typeof err === "object" && err && "type" in err) {
    const type = (err as { type: string }).type;
    if (type === "entity.parse.failed") {
      res.status(400).json({ error: { code: "BAD_JSON", message: "صيغة JSON غير صالحة" } });
      return;
    }
    if (type === "entity.too.large") {
      res.status(413).json({ error: { code: "PAYLOAD_TOO_LARGE", message: "حجم الطلب كبير جدًا" } });
      return;
    }
  }
  const pgErr = (err as { cause?: PgError }).cause ?? (err as PgError);
  if (pgErr?.code === "23505") {
    res.status(409).json({ error: { code: "CONFLICT", message: "يوجد سجل بنفس البيانات مسبقًا", details: { constraint: pgErr.constraint } } });
    return;
  }
  if (pgErr?.code === "23503") {
    res.status(409).json({ error: { code: "CONFLICT", message: "لا يمكن تنفيذ العملية بسبب ارتباط بسجلات أخرى" } });
    return;
  }
  // Never leak internals to the client.
  console.error("[unhandled]", err);
  res.status(500).json({ error: { code: "INTERNAL", message: "حدث خطأ غير متوقع" } });
};
