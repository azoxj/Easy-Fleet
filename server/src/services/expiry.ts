import { addDays, today } from "../lib/clock.js";

/**
 * Expiry rule (single definition used by every module):
 *   EXPIRED        expiryDate <  today
 *   EXPIRING_SOON  today <= expiryDate <= today + 30 days
 *   ACTIVE         expiryDate >  today + 30 days (or no expiry date)
 * "today" comes from the server clock in the business time zone — never from the client.
 */
export const EXPIRING_SOON_DAYS = 30;

export type ExpiryStatus = "ACTIVE" | "EXPIRING_SOON" | "EXPIRED";

export function expiryWindow(todayIso = today()) {
  return { today: todayIso, soonUntil: addDays(todayIso, EXPIRING_SOON_DAYS) };
}

export function expiryStatus(expiryDate: string | null | undefined, todayIso = today()): ExpiryStatus {
  if (!expiryDate) return "ACTIVE";
  const { today: t, soonUntil } = expiryWindow(todayIso);
  if (expiryDate < t) return "EXPIRED";
  if (expiryDate <= soonUntil) return "EXPIRING_SOON";
  return "ACTIVE";
}

/** Whole days from today until expiry (negative once expired). */
export function daysUntil(expiryDate: string, todayIso = today()): number {
  const a = Date.parse(`${todayIso}T00:00:00Z`);
  const b = Date.parse(`${expiryDate}T00:00:00Z`);
  return Math.round((b - a) / 86_400_000);
}

export type DriverEffectiveStatus = "ACTIVE" | "EXPIRED" | "SUSPENDED" | "INACTIVE";

/**
 * Effective driver status: administrative status wins, then an expired license
 * turns an ACTIVE driver into EXPIRED. An inactive employee makes the driver INACTIVE.
 */
export function driverEffectiveStatus(
  stored: "ACTIVE" | "SUSPENDED" | "INACTIVE",
  licenseExpiryDate: string | null,
  employeeStatus: string,
  todayIso = today(),
): DriverEffectiveStatus {
  if (employeeStatus !== "ACTIVE") return "INACTIVE";
  if (stored !== "ACTIVE") return stored;
  if (licenseExpiryDate && expiryStatus(licenseExpiryDate, todayIso) === "EXPIRED") return "EXPIRED";
  return "ACTIVE";
}
