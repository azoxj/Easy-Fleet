import { and, desc, eq, inArray, isNull, lte, ne, sql, type AnyColumn } from "drizzle-orm";
import { Router } from "express";
import { driverScope, maintenanceScope, ownDriverId, projectScope, vehicleScope, type Access } from "../../auth/access.js";
import { pendingApprovals } from "../approvals/routes.js";
import { costsCte, costsScope } from "../finance/costs.js";
import { invoiceScope } from "../finance/invoices.js";
import { monthStart } from "../finance/summary.js";
import { accidentScope } from "../operations/accidents.js";
import { fuelScope } from "../operations/fuel.js";
import { violationScope } from "../operations/violations.js";
import { db } from "../../db/client.js";
import {
  accidents,
  fuelTransactions,
  handoverSessions,
  invoices,
  trips,
  violations,
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

  const [expiring, maintenance, ops, approvals, charts] = await Promise.all([expiringCounts(access), maintenanceKpis(access), operationsKpis(access), pendingApprovals(access), chartData(access)]);

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
      ...ops,
      pendingApprovals: approvals.length,
      charts,
      alerts: buildAlerts({ expiring, maintenance, ops, approvals: approvals.length }),
    },
  });
});

const n = sql<number>`count(*)::int`;

/**
 * Accidents, violations, fuel, invoices, costs and the driver's current
 * handover/trip — each null when the caller lacks the module's permission.
 */
async function operationsKpis(access: Access) {
  const t = today();
  const tz = config.APP_TIMEZONE;
  const m0 = monthStart(t);
  const m1 = monthStart(t, 1);
  const inMonth = (col: AnyColumn) => sql`(${col} at time zone ${tz})::date >= ${m0}::date and (${col} at time zone ${tz})::date < ${m1}::date`;

  const accidentsKpi = access.has("accidents.read")
    ? await db
        .select({ open: sql<number>`count(*) filter (where ${accidents.status} <> 'CLOSED')::int`, thisMonth: sql<number>`count(*) filter (where ${inMonth(accidents.occurredAt)})::int` })
        .from(accidents)
        .where(accidentScope(access))
        .then((r) => r[0] ?? { open: 0, thisMonth: 0 })
    : null;
  const violationsKpi = access.has("violations.read")
    ? await db
        .select({ open: sql<number>`count(*) filter (where ${violations.status} in ('OPEN','DISPUTED'))::int`, openAmount: sql<string>`coalesce(sum(${violations.amount}) filter (where ${violations.status} in ('OPEN','DISPUTED')), 0)::numeric(14,2)::text` })
        .from(violations)
        .where(violationScope(access))
        .then((r) => r[0] ?? { open: 0, openAmount: "0.00" })
    : null;
  const fuelKpi = access.has("fuel.read")
    ? await db
        .select({ liters: sql<string>`coalesce(sum(${fuelTransactions.liters}), 0)::numeric(14,2)::text`, cost: sql<string>`coalesce(sum(${fuelTransactions.total}), 0)::numeric(14,2)::text`, fills: n })
        .from(fuelTransactions)
        .where(and(fuelScope(access), inMonth(fuelTransactions.fueledAt)))
        .then((r) => r[0] ?? { liters: "0.00", cost: "0.00", fills: 0 })
    : null;
  let invoicesKpi = null;
  if (access.has("invoices.read")) {
    const rows = await db.select({ status: invoices.status, n, total: sql<string>`coalesce(sum(${invoices.total}), 0)::text` }).from(invoices).where(invoiceScope(access)).groupBy(invoices.status);
    const by = Object.fromEntries(rows.map((r) => [r.status, r]));
    const cnt = (...k: string[]) => k.reduce((x, s) => x + (by[s]?.n ?? 0), 0);
    const amt = (...k: string[]) => k.reduce((x, s) => x + Number(by[s]?.total ?? 0), 0).toFixed(2);
    const [overdue] = await db.select({ n }).from(invoices).where(and(invoiceScope(access), sql`${invoices.dueDate} < ${t}::date and ${invoices.status} not in ('TRANSFERRED','PAID','CANCELLED','REJECTED')`));
    invoicesKpi = {
      pending: cnt("SUBMITTED", "UNDER_REVIEW"),
      approved: cnt("APPROVED", "TRANSFER_PENDING"),
      transferPending: cnt("TRANSFER_PENDING"),
      paid: cnt("TRANSFERRED", "PAID"),
      rejected: cnt("REJECTED"),
      overdue: overdue?.n ?? 0,
      totalValue: amt("SUBMITTED", "UNDER_REVIEW", "APPROVED", "TRANSFER_PENDING", "TRANSFERRED", "PAID"),
      pendingPaymentAmount: amt("TRANSFER_PENDING"),
    };
  }
  let monthlyCost: string | null = null;
  if (access.has("finance.read")) {
    const r = await db.execute<{ total: string }>(sql`with ${costsCte(access.orgId, tz)}
      select coalesce(sum(amount), 0)::numeric(16,2)::text as total from costs where ${costsScope(access)} and day >= ${m0}::date and day < ${m1}::date`);
    monthlyCost = r.rows[0]?.total ?? "0.00";
  }
  let currentHandover = null;
  let activeTrip = null;
  if (access.has("handover.read") || access.has("gps.track")) {
    const driverId = await ownDriverId(db, access);
    if (driverId && access.has("handover.read")) {
      const [h] = await db
        .select({ id: handoverSessions.id, status: handoverSessions.status, plateNumber: vehicles.plateNumber, expiresAt: handoverSessions.expiresAt })
        .from(handoverSessions)
        .innerJoin(vehicles, eq(vehicles.id, handoverSessions.vehicleId))
        .where(and(eq(handoverSessions.driverId, driverId), inArray(handoverSessions.status, ["PENDING_HANDOVER", "RETURN_PENDING"])))
        .limit(1);
      currentHandover = h ?? null;
    }
    if (access.has("gps.track")) {
      const [tr] = await db.select({ id: trips.id, vehicleId: trips.vehicleId, startedAt: trips.startedAt }).from(trips).where(and(eq(trips.userId, access.userId), eq(trips.status, "ACTIVE"))).limit(1);
      activeTrip = tr ?? null;
    }
  }
  return { accidents: accidentsKpi, violations: violationsKpi, fuel: fuelKpi, invoices: invoicesKpi, monthlyCost, currentHandover, activeTrip };
}

/** Six-month series for the dashboard charts (all from the database, scoped). */
async function chartData(access: Access) {
  const t = today();
  const tz = config.APP_TIMEZONE;
  const from6 = monthStart(t, -5);
  const m1 = monthStart(t, 1);
  const months = Array.from({ length: 6 }, (_, i) => monthStart(t, -5 + i).slice(0, 7));
  const monthKey = (col: AnyColumn) => sql<string>`to_char(date_trunc('month', ${col} at time zone ${tz}), 'YYYY-MM')`;
  const range = (col: AnyColumn) => sql`(${col} at time zone ${tz})::date >= ${from6}::date and (${col} at time zone ${tz})::date < ${m1}::date`;

  let costs = null;
  if (access.has("finance.read")) {
    const r = await db.execute<{ month: string; category: string; total: string }>(sql`with ${costsCte(access.orgId, tz)}
      select to_char(date_trunc('month', day), 'YYYY-MM') as month, category, sum(amount)::numeric(16,2)::text as total
        from costs where ${costsScope(access)} and day >= ${from6}::date and day < ${m1}::date group by 1, 2 order by 1`);
    costs = months.map((m) => ({ month: m, ...Object.fromEntries(r.rows.filter((x) => x.month === m).map((x) => [x.category, Number(x.total)])) }));
  }
  const fuel = access.has("fuel.read")
    ? await db
        .select({ month: monthKey(fuelTransactions.fueledAt), liters: sql<string>`sum(${fuelTransactions.liters})::text`, cost: sql<string>`sum(${fuelTransactions.total})::text` })
        .from(fuelTransactions)
        .where(and(fuelScope(access), range(fuelTransactions.fueledAt)))
        .groupBy(sql`1`)
        .then((rows) => months.map((m) => { const r = rows.find((x) => x.month === m); return { month: m, liters: Number(r?.liters ?? 0), cost: Number(r?.cost ?? 0) }; }))
    : null;
  const accidentsSeries = access.has("accidents.read")
    ? await db
        .select({ month: monthKey(accidents.occurredAt), n })
        .from(accidents)
        .where(and(accidentScope(access), range(accidents.occurredAt)))
        .groupBy(sql`1`)
        .then((rows) => months.map((m) => ({ month: m, count: rows.find((x) => x.month === m)?.n ?? 0 })))
    : null;
  const maintenanceSeries = access.has("maintenance.read")
    ? await db
        .select({ month: monthKey(maintenanceRequests.createdAt), n })
        .from(maintenanceRequests)
        .where(and(maintenanceScope(access, "maintenance.read"), range(maintenanceRequests.createdAt)))
        .groupBy(sql`1`)
        .then((rows) => months.map((m) => ({ month: m, count: rows.find((x) => x.month === m)?.n ?? 0 })))
    : null;
  return { months, costs, fuel, accidents: accidentsSeries, maintenance: maintenanceSeries };
}

type Alert = { level: "danger" | "warning" | "info"; key: string; title: string; count: number; link: string };

/** Actionable alerts derived from the KPIs above (only non-zero ones are returned). */
function buildAlerts(x: {
  expiring: Awaited<ReturnType<typeof expiringCounts>>;
  maintenance: Awaited<ReturnType<typeof maintenanceKpis>>;
  ops: Awaited<ReturnType<typeof operationsKpis>>;
  approvals: number;
}): Alert[] {
  const out: Alert[] = [];
  const push = (a: Alert) => a.count > 0 && out.push(a);
  if (x.expiring.total !== null) push({ level: "warning", key: "expiring", title: "مستندات منتهية أو تنتهي خلال 30 يومًا", count: x.expiring.total, link: "/documents?status=EXPIRING" });
  if (x.ops.invoices) push({ level: "danger", key: "overdueInvoices", title: "فواتير متأخرة عن تاريخ الاستحقاق", count: x.ops.invoices.overdue, link: "/finance/invoices?overdue=true" });
  push({ level: "info", key: "approvals", title: "عناصر بانتظار اعتمادك", count: x.approvals, link: "/approvals" });
  if (x.ops.accidents) push({ level: "danger", key: "openAccidents", title: "حوادث مفتوحة", count: x.ops.accidents.open, link: "/accidents?open=true" });
  if (x.ops.violations) push({ level: "warning", key: "openViolations", title: "مخالفات غير مسددة", count: x.ops.violations.open, link: "/violations?status=OPEN" });
  if (x.maintenance) push({ level: "warning", key: "awaitingHandover", title: "مركبات جاهزة للاستلام بعد الصيانة", count: x.maintenance.awaitingHandover, link: "/maintenance?status=READY_FOR_HANDOVER" });
  if (x.ops.currentHandover) push({ level: "info", key: "handover", title: x.ops.currentHandover.status === "PENDING_HANDOVER" ? "مطلوب منك استلام مركبة وتصويرها" : "لديك مركبة مستلمة بانتظار الإرجاع", count: 1, link: `/handovers/${x.ops.currentHandover.id}` });
  return out;
}

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
