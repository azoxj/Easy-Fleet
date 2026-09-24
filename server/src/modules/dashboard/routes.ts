import { and, desc, eq, isNull, lte, ne, sql } from "drizzle-orm";
import { Router } from "express";
import { driverScope, maintenanceScope, projectScope, vehicleScope, type Access } from "../../auth/access.js";
import { db } from "../../db/client.js";
import {
  assignments,
  auditLogs,
  drivers,
  employees,
  insurancePolicies,
  maintenanceRequests,
  notifications,
  projects,
  users,
  vehicleDocuments,
  vehicles,
} from "../../db/schema/index.js";
import { config } from "../../config.js";
import { today } from "../../lib/clock.js";
import { expiryWindow } from "../../services/expiry.js";
import { ctx } from "../../http/context.js";
import { requirePermission } from "../../http/middleware.js";

export const dashboardRouter = Router();

type View = "admin" | "project_manager" | "finance" | "driver" | "general";

function viewFor(access: Access): View {
  const r = new Set(access.roleKeys);
  if (r.has("SUPER_ADMIN")) return "admin";
  if (r.has("PROJECT_MANAGER")) return "project_manager";
  if (r.has("FINANCE")) return "finance";
  if (r.has("DRIVER")) return "driver";
  return "general";
}

/**
 * Metrics owned by modules that ship in later sprints. They are reported as
 * unavailable (null) — never as invented numbers.
 */
const UPCOMING = {
  accidents: null,
  violations: null,
  monthlyCost: null,
  pendingApprovals: null,
  pendingInvoices: null,
  approvedInvoices: null,
  pendingPayment: null,
  paidInvoices: null,
  totalFinancialValue: null,
  currentHandover: null,
} as const;

dashboardRouter.get("/", requirePermission("dashboard.view"), async (req, res) => {
  const { access } = ctx(req);
  const view = viewFor(access);

  const vehicleStats = access.has("vehicles.read")
    ? await db
        .select({ status: vehicles.status, n: sql<number>`count(*)::int` })
        .from(vehicles)
        .where(vehicleScope(access, "vehicles.read"))
        .groupBy(vehicles.status)
    : null;

  const projectStats = access.has("projects.read")
    ? await db
        .select({ status: projects.status, n: sql<number>`count(*)::int` })
        .from(projects)
        .where(projectScope(access, "projects.read"))
        .groupBy(projects.status)
    : null;

  const myAssignments = await db
    .select({ status: assignments.status, n: sql<number>`count(*)::int` })
    .from(assignments)
    .where(and(eq(assignments.assignedTo, access.userId), eq(assignments.organizationId, access.orgId)))
    .groupBy(assignments.status);

  const [unread] = await db
    .select({ n: sql<number>`count(*)::int` })
    .from(notifications)
    .where(and(eq(notifications.userId, access.userId), isNull(notifications.readAt)));

  const assignedVehicles =
    view === "driver" && access.has("vehicles.read")
      ? await db
          .select({ id: vehicles.id, plateNumber: vehicles.plateNumber, make: vehicles.make, model: vehicles.model, status: vehicles.status })
          .from(vehicles)
          .where(and(vehicleScope(access, "vehicles.read"), ne(vehicles.status, "ARCHIVED")))
          .limit(10)
      : null;

  const recentActivity =
    access.scopeOf("audit.read") === "ALL"
      ? await db
          .select({ id: auditLogs.id, action: auditLogs.action, entity: auditLogs.entity, entityId: auditLogs.entityId, createdAt: auditLogs.createdAt, userName: users.name })
          .from(auditLogs)
          .leftJoin(users, eq(users.id, auditLogs.userId))
          .where(eq(auditLogs.organizationId, access.orgId))
          .orderBy(desc(auditLogs.id))
          .limit(8)
      : null;

  const expiring = await expiringCounts(access);
  const maintenance = await maintenanceKpis(access);

  const byStatus = (rows: { status: string; n: number }[] | null) =>
    rows ? Object.fromEntries(rows.map((r) => [r.status, r.n])) : null;
  const sum = (rows: { n: number }[] | null) => (rows ? rows.reduce((a, r) => a + r.n, 0) : null);
  const vs = byStatus(vehicleStats);

  res.json({
    data: {
      view,
      vehicles: vs
        ? {
            total: sum(vehicleStats!.filter((r) => r.status !== "ARCHIVED")),
            active: (vs.AVAILABLE ?? 0) + (vs.ASSIGNED ?? 0),
            inMaintenance: vs.IN_MAINTENANCE ?? 0,
            byStatus: vs,
          }
        : null,
      projects: projectStats ? { total: sum(projectStats), active: byStatus(projectStats)!.ACTIVE ?? 0 } : null,
      myAssignments: byStatus(myAssignments),
      unreadNotifications: unread?.n ?? 0,
      assignedVehicles,
      recentActivity,
      expiring,
      maintenance,
      upcoming: UPCOMING,
    },
  });
});

/**
 * Items that are expired or expire within the 30-day window, each counted only
 * inside the caller's scope for the matching permission (null = no permission).
 */
async function expiringCounts(access: Access) {
  const { soonUntil } = expiryWindow();
  const count = async (q: Promise<{ n: number }[]>) => (await q)[0]?.n ?? 0;
  const n = sql<number>`count(*)::int`;

  const registrations = access.has("registration.read")
    ? await count(
        db
          .select({ n })
          .from(vehicleDocuments)
          .innerJoin(vehicles, eq(vehicles.id, vehicleDocuments.vehicleId))
          .where(
            and(
              vehicleScope(access, "registration.read"),
              eq(vehicleDocuments.documentType, "REGISTRATION"),
              isNull(vehicleDocuments.supersededAt),
              isNull(vehicleDocuments.deletedAt),
              ne(vehicles.status, "ARCHIVED"),
              lte(vehicleDocuments.expiryDate, soonUntil),
            ),
          ),
      )
    : null;
  const insurance = access.has("insurance.read")
    ? await count(
        db
          .select({ n })
          .from(insurancePolicies)
          .innerJoin(vehicles, eq(vehicles.id, insurancePolicies.vehicleId))
          .where(and(vehicleScope(access, "insurance.read"), isNull(insurancePolicies.supersededAt), ne(vehicles.status, "ARCHIVED"), lte(insurancePolicies.expiryDate, soonUntil))),
      )
    : null;
  const documents = access.has("vehicle_documents.read")
    ? await count(
        db
          .select({ n })
          .from(vehicleDocuments)
          .innerJoin(vehicles, eq(vehicles.id, vehicleDocuments.vehicleId))
          .where(
            and(
              vehicleScope(access, "vehicle_documents.read"),
              ne(vehicleDocuments.documentType, "REGISTRATION"),
              isNull(vehicleDocuments.deletedAt),
              ne(vehicles.status, "ARCHIVED"),
              lte(vehicleDocuments.expiryDate, soonUntil),
            ),
          ),
      )
    : null;
  const licenses = access.has("drivers.read")
    ? await count(
        db
          .select({ n })
          .from(drivers)
          .innerJoin(employees, eq(employees.id, drivers.employeeId))
          .where(and(driverScope(access, "drivers.read"), isNull(drivers.archivedAt), lte(drivers.licenseExpiryDate, soonUntil))),
      )
    : null;
  const parts = [registrations, insurance, documents, licenses].filter((x): x is number => x !== null);
  return { registrations, insurance, documents, licenses, total: parts.length ? parts.reduce((a, b) => a + b, 0) : null };
}

/** Maintenance KPIs from the database, within the caller's maintenance scope (null without permission). */
async function maintenanceKpis(access: Access) {
  if (!access.has("maintenance.read")) return null;
  const rows = await db
    .select({ status: maintenanceRequests.status, n: sql<number>`count(*)::int` })
    .from(maintenanceRequests)
    .where(maintenanceScope(access, "maintenance.read"))
    .groupBy(maintenanceRequests.status);
  const by = Object.fromEntries(rows.map((r) => [r.status, r.n])) as Record<string, number>;
  const open = ["REQUESTED", "INSPECTION", "QUOTE_PENDING", "PENDING_APPROVAL", "APPROVED", "IN_REPAIR", "READY_FOR_HANDOVER", "ACCEPTED"].reduce((a, k) => a + (by[k] ?? 0), 0);
  let costThisMonth: string | null = null;
  if (access.has("maintenance.parts.read") && access.has("maintenance.labor.read")) {
    // "This month" follows the business clock (APP_TIMEZONE), like every other date rule.
    const tz = config.APP_TIMEZONE;
    const t = today();
    const monthStart = `${t.slice(0, 8)}01`;
    const nextMonth = new Date(Date.UTC(Number(t.slice(0, 4)), Number(t.slice(5, 7)), 1)).toISOString().slice(0, 10);
    const [c] = await db
      .select({
        total: sql<string>`coalesce(sum(
          coalesce((select sum(p.total) from maintenance_parts p where p.maintenance_request_id = "maintenance_requests"."id"), 0)
          + coalesce((select sum(l.total) from maintenance_labor l where l.maintenance_request_id = "maintenance_requests"."id"), 0)
        ), 0)::numeric(16,2)::text`,
      })
      .from(maintenanceRequests)
      .where(
        and(
          maintenanceScope(access, "maintenance.read"),
          eq(maintenanceRequests.status, "CLOSED"),
          sql`(${maintenanceRequests.closedAt} at time zone ${tz})::date >= ${monthStart}::date`,
          sql`(${maintenanceRequests.closedAt} at time zone ${tz})::date < ${nextMonth}::date`,
        ),
      );
    costThisMonth = c?.total ?? "0.00";
  }
  return {
    open,
    awaitingInspection: by.REQUESTED ?? 0,
    inInspection: (by.INSPECTION ?? 0) + (by.QUOTE_PENDING ?? 0),
    awaitingApproval: by.PENDING_APPROVAL ?? 0,
    inRepair: (by.APPROVED ?? 0) + (by.IN_REPAIR ?? 0),
    awaitingHandover: by.READY_FOR_HANDOVER ?? 0,
    costThisMonth,
  };
}
