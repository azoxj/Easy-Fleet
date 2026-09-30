import { sql, type AnyColumn, type SQL } from "drizzle-orm";
import { z } from "zod";
import { tr } from "../i18n/index.js";

export const uuid = z.uuid({ get message() { return tr("معرّف غير صالح"); } });
export const idParam = z.object({ id: uuid });

export const pagination = z.object({
  page: z.coerce.number().int().min(1).max(10_000).default(1),
  pageSize: z.coerce.number().int().min(1).max(100).default(20),
  /** Optional column sort for list screens; only keys whitelisted by the endpoint are applied (see sortOrder). */
  sort: z.string().trim().max(40).optional(),
  dir: z.enum(["asc", "desc"]).optional(),
});

/**
 * ORDER BY for a list endpoint: the requested column when it is in the endpoint's
 * whitelist (unknown keys are ignored, never interpolated), then the endpoint's
 * default order as a stable tie-breaker. Empty values sort last in both directions.
 */
export function sortOrder(q: { sort?: string; dir?: "asc" | "desc" }, allowed: Record<string, AnyColumn | SQL>, ...fallback: SQL[]): SQL[] {
  const col = q.sort && Object.hasOwn(allowed, q.sort) ? allowed[q.sort] : undefined;
  if (!col) return fallback;
  return [q.dir === "asc" ? sql`${col} asc nulls last` : sql`${col} desc nulls last`, ...fallback];
}

export const trimmed = (min: number, max: number) => z.string().trim().min(min).max(max);
export const optionalText = (max: number) =>
  z
    .string()
    .trim()
    .max(max)
    .transform((v) => (v === "" ? null : v))
    .nullable()
    .optional();

/** YYYY-MM-DD */
export const isoDate = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}$/, "صيغة التاريخ يجب أن تكون YYYY-MM-DD")
  .refine((s) => !Number.isNaN(Date.parse(s)), "تاريخ غير صالح");

/** Money as a decimal string with at most 2 fractional digits (never float). */
export const money = z
  .union([z.string(), z.number()])
  .transform((v) => String(v).trim())
  .refine((s) => /^\d{1,12}(\.\d{1,2})?$/.test(s), "مبلغ غير صالح");

export function paged<T>(data: T[], total: number, page: number, pageSize: number) {
  return { data, meta: { page, pageSize, total } };
}
