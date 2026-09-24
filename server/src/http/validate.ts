import { z } from "zod";

export const uuid = z.uuid({ message: "معرّف غير صالح" });
export const idParam = z.object({ id: uuid });

export const pagination = z.object({
  page: z.coerce.number().int().min(1).max(10_000).default(1),
  pageSize: z.coerce.number().int().min(1).max(100).default(20),
});

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
