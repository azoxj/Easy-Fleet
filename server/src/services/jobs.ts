import { and, eq, isNull, lte, ne, sql } from "drizzle-orm";
import { permissionHolders } from "../auth/access.js";
import type { PermissionKey } from "../auth/permissions.js";
import { db } from "../db/client.js";
import { drivers, employees, insurancePolicies, projects, vehicleDocuments, vehicles } from "../db/schema/index.js";
import { daysUntil, expiryWindow } from "./expiry.js";
import { processEmailQueue } from "../email/service.js";
import { notifyUsers } from "./notifications.js";

/**
 * Background jobs. They run in-process on an interval (see index.ts) and can
 * also be triggered with `npm run jobs:run` (e.g. from cron) — every job is
 * idempotent: expiry notifications are de-duplicated per item/threshold.
 */

/** Threshold bucket so a user is reminded at 30, 15, 7 and 0 days, and once when expired. */
function bucketOf(days: number): string | null {
  if (days < 0) return "expired";
  if (days === 0) return "0";
  if (days <= 7) return "7";
  if (days <= 15) return "15";
  if (days <= 30) return "30";
  return null;
}

async function managersOf(orgId: string, projectId: string | null, perm: PermissionKey) {
  const ids = new Set(await permissionHolders(db, orgId, perm, projectId, { includeAllScope: true }));
  if (projectId) {
    const [p] = await db.select({ managerId: projects.managerId }).from(projects).where(eq(projects.id, projectId));
    if (p?.managerId) ids.add(p.managerId);
  }
  return [...ids];
}

export async function runExpiryScan(): Promise<{ notified: number }> {
  const { soonUntil } = expiryWindow();
  let notified = 0;
  const send = async (orgId: string, projectId: string | null, userIds: string[], type: string, title: string, link: string, key: string) => {
    const r = await notifyUsers(db, { orgId, userIds, type, title, link, projectId, dedupeKey: key, category: "DOCUMENT_EXPIRY" });
    notified += r.length;
  };
  const phrase = (days: number) => (days < 0 ? `منتهية منذ ${-days} يوم` : days === 0 ? "تنتهي اليوم" : `تنتهي خلال ${days} يوم`);

  // Registrations
  const regs = await db
    .select({ id: vehicleDocuments.id, expiryDate: vehicleDocuments.expiryDate, orgId: vehicles.organizationId, projectId: vehicles.projectId, vehicleId: vehicles.id, plate: vehicles.plateNumber })
    .from(vehicleDocuments)
    .innerJoin(vehicles, eq(vehicles.id, vehicleDocuments.vehicleId))
    .where(and(eq(vehicleDocuments.documentType, "REGISTRATION"), isNull(vehicleDocuments.supersededAt), isNull(vehicleDocuments.deletedAt), ne(vehicles.status, "ARCHIVED"), lte(vehicleDocuments.expiryDate, soonUntil)));
  for (const r of regs) {
    const days = daysUntil(r.expiryDate!);
    const b = bucketOf(days);
    if (!b) continue;
    await send(r.orgId, r.projectId, await managersOf(r.orgId, r.projectId, "registration.update"), days < 0 ? "REGISTRATION_EXPIRED" : "REGISTRATION_EXPIRING", `استمارة المركبة ${r.plate} ${phrase(days)}`, `/vehicles/${r.vehicleId}`, `reg:${r.id}:${r.expiryDate}:${b}`);
  }

  // Insurance
  const pols = await db
    .select({ id: insurancePolicies.id, expiryDate: insurancePolicies.expiryDate, orgId: vehicles.organizationId, projectId: vehicles.projectId, vehicleId: vehicles.id, plate: vehicles.plateNumber })
    .from(insurancePolicies)
    .innerJoin(vehicles, eq(vehicles.id, insurancePolicies.vehicleId))
    .where(and(isNull(insurancePolicies.supersededAt), ne(vehicles.status, "ARCHIVED"), lte(insurancePolicies.expiryDate, soonUntil)));
  for (const p of pols) {
    const days = daysUntil(p.expiryDate);
    const b = bucketOf(days);
    if (!b) continue;
    await send(p.orgId, p.projectId, await managersOf(p.orgId, p.projectId, "insurance.update"), days < 0 ? "INSURANCE_EXPIRED" : "INSURANCE_EXPIRING", `تأمين المركبة ${p.plate} ${phrase(days)}`, `/vehicles/${p.vehicleId}`, `ins:${p.id}:${p.expiryDate}:${b}`);
  }

  // Driver licenses (managers + the driver's own account)
  const lic = await db
    .select({ id: drivers.id, expiry: drivers.licenseExpiryDate, orgId: drivers.organizationId, projectId: employees.projectId, name: employees.fullName, userId: employees.userId })
    .from(drivers)
    .innerJoin(employees, eq(employees.id, drivers.employeeId))
    .where(and(isNull(drivers.archivedAt), lte(drivers.licenseExpiryDate, soonUntil)));
  for (const d of lic) {
    const days = daysUntil(d.expiry!);
    const b = bucketOf(days);
    if (!b) continue;
    const recipients = await managersOf(d.orgId, d.projectId, "drivers.update");
    await send(d.orgId, d.projectId, recipients, days < 0 ? "LICENSE_EXPIRED" : "LICENSE_EXPIRING", `رخصة السائق ${d.name} ${phrase(days)}`, `/drivers/${d.id}`, `lic:${d.id}:${d.expiry}:${b}`);
    if (d.userId) {
      const r = await notifyUsers(db, { orgId: d.orgId, userIds: [d.userId], type: days < 0 ? "LICENSE_EXPIRED" : "LICENSE_EXPIRING", title: `رخصة القيادة الخاصة بك ${phrase(days)}`, dedupeKey: `lic-self:${d.id}:${d.expiry}:${b}`, category: "DOCUMENT_EXPIRY" });
      notified += r.length;
    }
  }
  return { notified };
}

/** Reminder buckets for the service schedule: by date (14/7/0 days, overdue) and by odometer (1000/500 km left, reached). */
function serviceBucket(daysLeft: number | null, kmLeft: number | null): string | null {
  const byDays = daysLeft === null ? null : daysLeft < 0 ? "d-over" : daysLeft === 0 ? "d0" : daysLeft <= 7 ? "d7" : daysLeft <= 14 ? "d14" : null;
  const byKm = kmLeft === null ? null : kmLeft <= 0 ? "k-over" : kmLeft <= 500 ? "k500" : kmLeft <= 1000 ? "k1000" : null;
  return byDays ?? byKm;
}

/**
 * Maintenance due / oil change due, from the vehicle service schedule
 * (next service / oil change date or odometer). De-duplicated per vehicle,
 * target and threshold, so each reminder is sent once (in-app + email).
 */
export async function runServiceDueScan(): Promise<{ notified: number }> {
  let notified = 0;
  const rows = await db
    .select({
      id: vehicles.id,
      orgId: vehicles.organizationId,
      projectId: vehicles.projectId,
      plate: vehicles.plateNumber,
      odometer: vehicles.currentOdometer,
      serviceDate: vehicles.nextServiceDate,
      serviceKm: vehicles.nextServiceOdometer,
      oilDate: vehicles.nextOilChangeDate,
      oilKm: vehicles.nextOilChangeOdometer,
    })
    .from(vehicles)
    .where(and(ne(vehicles.status, "ARCHIVED"), sql`(${vehicles.nextServiceDate} is not null or ${vehicles.nextServiceOdometer} is not null or ${vehicles.nextOilChangeDate} is not null or ${vehicles.nextOilChangeOdometer} is not null)`));
  for (const v of rows) {
    for (const kind of ["service", "oil"] as const) {
      const date = kind === "service" ? v.serviceDate : v.oilDate;
      const km = kind === "service" ? v.serviceKm : v.oilKm;
      const daysLeft = date ? daysUntil(date) : null;
      const kmLeft = km !== null ? km - v.odometer : null;
      const b = serviceBucket(daysLeft, kmLeft);
      if (!b) continue;
      const due = (daysLeft !== null && daysLeft <= 0) || (kmLeft !== null && kmLeft <= 0);
      const what = kind === "service" ? "الصيانة الدورية" : "تغيير الزيت";
      const title = due ? `${what} للمركبة ${v.plate} مستحقة الآن` : `${what} للمركبة ${v.plate} تقترب`;
      const body = [date ? `الموعد: ${date}` : null, km !== null ? `عند العداد: ${km} كم (الحالي ${v.odometer} كم)` : null].filter(Boolean).join(" — ");
      const r = await notifyUsers(db, {
        orgId: v.orgId,
        userIds: await managersOf(v.orgId, v.projectId, "maintenance.create"),
        type: kind === "service" ? "MAINTENANCE_DUE" : "OIL_CHANGE_DUE",
        title,
        body,
        link: `/vehicles/${v.id}`,
        projectId: v.projectId,
        entityType: "vehicle",
        entityId: v.id,
        category: "MAINTENANCE",
        dedupeKey: `${kind}:${v.id}:${date ?? ""}:${km ?? ""}:${b}`,
      });
      notified += r.length;
    }
  }
  return { notified };
}

/** Removes expired/revoked sessions (kept 7 days for forensics) and stale rate-limit counters. */
export async function runCleanup(): Promise<{ sessions: number; rateLimits: number; resetTokens: number }> {
  const s = await db.execute(sql`delete from sessions where (revoked_at is not null and revoked_at < now() - interval '7 days') or expires_at < now() - interval '7 days'`);
  const r = await db.execute(sql`delete from rate_limits where window_start < now() - interval '1 day'`);
  // used/expired reset tokens are useless after a day (hashes only, but no reason to keep them)
  const t = await db.execute(sql`delete from password_reset_tokens where expires_at < now() - interval '1 day' or used_at < now() - interval '1 day'`);
  return { sessions: s.rowCount ?? 0, rateLimits: r.rowCount ?? 0, resetTokens: t.rowCount ?? 0 };
}

/** Last in-process run (shown in Settings → System). */
export const jobStatus: { lastRunAt: Date | null; lastError: string | null; lastResult: unknown } = { lastRunAt: null, lastError: null, lastResult: null };

export async function runAllJobs() {
  try {
    const [expiry, service, cleanup] = [await runExpiryScan(), await runServiceDueScan(), await runCleanup()];
    // also drains the email outbox (useful when jobs run from cron: `npm run jobs:run`)
    const email = await processEmailQueue(200);
    Object.assign(jobStatus, { lastRunAt: new Date(), lastError: null, lastResult: { expiry, service, cleanup, email } });
    return { expiry, service, cleanup, email };
  } catch (e) {
    Object.assign(jobStatus, { lastRunAt: new Date(), lastError: e instanceof Error ? e.message : String(e) });
    throw e;
  }
}

let timer: NodeJS.Timeout | undefined;
export function startJobScheduler(intervalMs = 6 * 3_600_000) {
  const run = () => void runAllJobs().catch((e) => console.error("[jobs] failed", e));
  setTimeout(run, 10_000).unref();
  timer = setInterval(run, intervalMs);
  timer.unref();
}

