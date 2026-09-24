import { and, desc, eq, isNull, ne, sql } from "drizzle-orm";
import { Router } from "express";
import { projectScope, vehicleScope, type Access } from "../../auth/access.js";
import { db } from "../../db/client.js";
import { assignments, auditLogs, notifications, projects, users, vehicles } from "../../db/schema/index.js";
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
  maintenance: null,
  expiringDocuments: null,
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
      upcoming: UPCOMING,
    },
  });
});
