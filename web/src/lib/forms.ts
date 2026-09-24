import { ApiError } from "./api";

/** Maps a server validation error to { field: message } for inline form errors. */
export function fieldErrors(err: unknown): Record<string, string> {
  if (!(err instanceof ApiError) || !Array.isArray(err.details)) return {};
  const out: Record<string, string> = {};
  for (const d of err.details as { path?: string; message?: string }[]) {
    if (d.path && d.message && !out[d.path]) out[d.path] = d.message;
  }
  return out;
}

export function errorMessage(err: unknown, fallback = "حدث خطأ غير متوقع"): string {
  return err instanceof ApiError ? err.message : fallback;
}

/** Converts "" to null and trims strings, so optional fields are cleared rather than sent as empty text. */
export function clean<T extends Record<string, unknown>>(values: T): { [K in keyof T]: T[K] | null } {
  const out = {} as { [K in keyof T]: T[K] | null };
  for (const [k, v] of Object.entries(values)) {
    (out as Record<string, unknown>)[k] = typeof v === "string" ? (v.trim() === "" ? null : v.trim()) : v;
  }
  return out;
}
