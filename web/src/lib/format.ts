import { intlLocale, t } from "../i18n";

/** Locale-aware formatting (Arabic: ar-SA with Latin digits and Gregorian calendar; English: en-GB). Stored values are never changed. */
const LOCALE = () => intlLocale();

export function formatNumber(n: number | string | null | undefined): string {
  if (n === null || n === undefined || n === "") return "—";
  const v = typeof n === "string" ? Number(n) : n;
  if (!Number.isFinite(v)) return "—";
  return new Intl.NumberFormat(LOCALE()).format(v);
}

export function formatMoney(n: number | string | null | undefined): string {
  if (n === null || n === undefined || n === "") return "—";
  const v = typeof n === "string" ? Number(n) : n;
  if (!Number.isFinite(v)) return "—";
  return t("format.sar", { v: new Intl.NumberFormat(LOCALE(), { minimumFractionDigits: 0, maximumFractionDigits: 2 }).format(v) });
}

export function formatDate(d: string | Date | null | undefined): string {
  if (!d) return "—";
  const date = typeof d === "string" ? new Date(d.length === 10 ? `${d}T00:00:00` : d) : d;
  if (Number.isNaN(date.getTime())) return "—";
  return new Intl.DateTimeFormat(LOCALE(), { year: "numeric", month: "short", day: "numeric" }).format(date);
}

export function formatDateTime(d: string | Date | null | undefined): string {
  if (!d) return "—";
  const date = typeof d === "string" ? new Date(d) : d;
  if (Number.isNaN(date.getTime())) return "—";
  return new Intl.DateTimeFormat(LOCALE(), { year: "numeric", month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" }).format(date);
}

export function formatTime(d: string | Date | null | undefined): string {
  if (!d) return "—";
  const date = typeof d === "string" ? new Date(d) : d;
  if (Number.isNaN(date.getTime())) return "—";
  return new Intl.DateTimeFormat(LOCALE(), { hour: "2-digit", minute: "2-digit" }).format(date);
}

/** Short month name for "YYYY-MM" keys (charts). */
export function formatMonth(month: string): string {
  const [y, mo] = month.split("-").map(Number);
  if (!y || !mo) return month;
  return new Intl.DateTimeFormat(LOCALE(), { month: "short" }).format(new Date(Date.UTC(y, mo - 1, 1)));
}

export function timeAgo(d: string | Date, now = new Date()): string {
  const date = typeof d === "string" ? new Date(d) : d;
  const sec = Math.round((now.getTime() - date.getTime()) / 1000);
  if (sec < 60) return t("common.justNow");
  const min = Math.round(sec / 60);
  if (min < 60) return t("format.minAgo", { min });
  const hr = Math.round(min / 60);
  if (hr < 24) return t("format.hoursAgo", { hr });
  const day = Math.round(hr / 24);
  if (day < 30) return t("format.daysAgo", { day });
  return formatDate(date);
}
