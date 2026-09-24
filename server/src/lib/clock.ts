import { config } from "../config.js";

/**
 * Single source of "now" for business rules. Tests can pin the clock with
 * setClock(); production always uses the real server time.
 */
let override: Date | null = null;

export function now(): Date {
  return override ? new Date(override) : new Date();
}

/** Test-only: pin the clock (pass null to restore real time). */
export function setClock(date: Date | null) {
  override = date;
}

/** Today's calendar date (YYYY-MM-DD) in the business time zone. */
export function today(tz = config.APP_TIMEZONE): string {
  // en-CA formats as YYYY-MM-DD.
  return new Intl.DateTimeFormat("en-CA", { timeZone: tz, year: "numeric", month: "2-digit", day: "2-digit" }).format(now());
}

/** Adds whole days to a YYYY-MM-DD date string (calendar arithmetic, DST-safe). */
export function addDays(isoDate: string, days: number): string {
  const [y, m, d] = isoDate.split("-").map(Number) as [number, number, number];
  const dt = new Date(Date.UTC(y, m - 1, d));
  dt.setUTCDate(dt.getUTCDate() + days);
  return dt.toISOString().slice(0, 10);
}
