import { and, eq, inArray, sql } from "drizzle-orm";
import type { Request } from "express";
import { canOnMaintenance, isAssignedToMaintenance, maintenanceScope, permissionHolders, type Access } from "../../auth/access.js";
import type { PermissionKey } from "../../auth/permissions.js";
import { db, type DbOrTx } from "../../db/client.js";
import { assignments, maintenanceEvents, maintenanceQuotes, maintenanceRequests, projects, vehicles } from "../../db/schema/index.js";
import { forbidden, HttpError, notFound } from "../../http/errors.js";
import { audit, type AuditAction } from "../../services/audit.js";
import { notifyUsers } from "../../services/notifications.js";
import type { MaintenanceStatus, RequestState } from "./workflow.js";

export type MR = typeof maintenanceRequests.$inferSelect;

export const mrLabel = (mr: { number: number }) => `MR-${mr.number}`;

export const invalidTransition = (message = "هذا الإجراء غير مسموح في حالة الطلب الحالية") =>
  new HttpError(409, "INVALID_TRANSITION", message);

/**
 * Loads a request the caller may use `perm` on.
 *  - not in the caller's read scope (or other org / unknown id) → 404 (no existence oracle)
 *  - readable but the caller cannot act with `perm` on it        → 403
 */
export async function loadRequest(a: Access, id: string, perm: PermissionKey, mode: "read" | "act" = "act") {
  if (!a.has("maintenance.read")) throw forbidden();
  const [mr] = await db
    .select()
    .from(maintenanceRequests)
    .where(and(eq(maintenanceRequests.id, id), maintenanceScope(a, "maintenance.read")))
    .limit(1);
  if (!mr) throw notFound("طلب الصيانة غير موجود");
  const assigned = await isAssignedToMaintenance(db, a, mr.id);
  if (!canOnMaintenance(a, perm, mr, assigned, mode)) throw forbidden();
  return { mr, assigned };
}

export async function stateOf(tx: DbOrTx, mr: MR): Promise<RequestState> {
  const [q] = await tx
    .select({ n: sql<number>`count(*)::int` })
    .from(maintenanceQuotes)
    .where(and(eq(maintenanceQuotes.maintenanceRequestId, mr.id), eq(maintenanceQuotes.status, "APPROVED")));
  return {
    status: mr.status as MaintenanceStatus,
    projectId: mr.projectId,
    assignedTo: mr.assignedTo,
    diagnosis: mr.diagnosis,
    workPerformed: mr.workPerformed,
    hasApprovedQuote: (q?.n ?? 0) > 0,
  };
}

/**
 * Records a domain event (append-only maintenance_events) AND an audit entry
 * tagged with the project and vehicle, so it also appears on the vehicle timeline.
 */
export async function recordEvent(
  tx: DbOrTx,
  req: Request,
  mr: MR,
  e: { type: string; audit: AuditAction; from?: string | null; to?: string | null; reason?: string | null; metadata?: Record<string, unknown>; entity?: string; entityId?: string },
) {
  const actorId = req.session!.userId;
  await tx.insert(maintenanceEvents).values({
    organizationId: mr.organizationId,
    maintenanceRequestId: mr.id,
    type: e.type,
    fromStatus: (e.from ?? null) as MaintenanceStatus | null,
    toStatus: (e.to ?? null) as MaintenanceStatus | null,
    actorId,
    reason: e.reason ?? null,
    metadata: e.metadata ?? null,
  });
  await audit(tx, req, {
    action: e.audit,
    entity: e.entity ?? "maintenance_request",
    entityId: e.entityId ?? mr.id,
    projectId: mr.projectId,
    vehicleId: mr.vehicleId,
    metadata: {
      maintenanceId: mr.id,
      maintenanceNumber: mrLabel(mr),
      ...(e.from !== undefined ? { fromStatus: e.from } : {}),
      ...(e.to !== undefined ? { toStatus: e.to } : {}),
      ...(e.reason ? { reason: e.reason } : {}),
      ...(e.metadata ?? {}),
    },
  });
}

/**
 * Atomic status change guarded by the current status (optimistic concurrency):
 * if another request changed the status first, nothing is updated and 409 is returned.
 */
export async function changeStatus(tx: DbOrTx, mr: MR, to: MaintenanceStatus, extra: Partial<typeof maintenanceRequests.$inferInsert> = {}) {
  const [u] = await tx
    .update(maintenanceRequests)
    .set({ ...extra, status: to, updatedAt: new Date() })
    .where(and(eq(maintenanceRequests.id, mr.id), eq(maintenanceRequests.status, mr.status)))
    .returning();
  if (!u) throw invalidTransition("تم تعديل الطلب من مستخدم آخر، أعد تحميل الصفحة");
  return u;
}

// ---------------------------------------------------------------- vehicle status hooks

/** Repair starts → vehicle IN_MAINTENANCE (previous status remembered on the request). */
export async function vehicleIntoMaintenance(tx: DbOrTx, req: Request, mr: MR) {
  const [v] = await tx.select().from(vehicles).where(eq(vehicles.id, mr.vehicleId));
  if (!v || v.status === "IN_MAINTENANCE" || v.status === "ARCHIVED" || v.status === "SOLD") return null;
  await tx.update(vehicles).set({ status: "IN_MAINTENANCE", updatedAt: new Date() }).where(eq(vehicles.id, v.id));
  await audit(tx, req, {
    action: "VEHICLE_UPDATED",
    entity: "vehicle",
    entityId: v.id,
    projectId: v.projectId,
    vehicleId: v.id,
    metadata: { changes: { status: { from: v.status, to: "IN_MAINTENANCE" } }, source: mrLabel(mr) },
  });
  return v.status;
}

/** After handover acceptance → restore the vehicle unless another repair is still running. */
export async function vehicleOutOfMaintenance(tx: DbOrTx, req: Request, mr: MR) {
  const [v] = await tx.select().from(vehicles).where(eq(vehicles.id, mr.vehicleId));
  if (!v || v.status !== "IN_MAINTENANCE") return;
  const [other] = await tx
    .select({ id: maintenanceRequests.id })
    .from(maintenanceRequests)
    .where(and(eq(maintenanceRequests.vehicleId, v.id), eq(maintenanceRequests.status, "IN_REPAIR")))
    .limit(1);
  if (other) return;
  const to = v.assignedDriverId ? "ASSIGNED" : "AVAILABLE";
  await tx.update(vehicles).set({ status: to, updatedAt: new Date() }).where(eq(vehicles.id, v.id));
  await audit(tx, req, {
    action: "VEHICLE_UPDATED",
    entity: "vehicle",
    entityId: v.id,
    projectId: v.projectId,
    vehicleId: v.id,
    metadata: { changes: { status: { from: "IN_MAINTENANCE", to } }, source: mrLabel(mr) },
  });
}

/** Keeps the Assignments module in sync: one active MAINTENANCE_REQUEST assignment for the technician. */
export async function syncTechnicianAssignment(tx: DbOrTx, mr: MR, technicianId: string | null, actorId: string) {
  await tx
    .update(assignments)
    .set({ status: "CANCELLED", updatedAt: new Date() })
    .where(
      and(
        eq(assignments.type, "MAINTENANCE_REQUEST"),
        eq(assignments.referenceId, mr.id),
        inArray(assignments.status, ["PENDING", "IN_PROGRESS"]),
        technicianId ? sql`${assignments.assignedTo} <> ${technicianId}` : sql`true`,
      ),
    );
  if (!technicianId) return;
  const [existing] = await tx
    .select({ id: assignments.id })
    .from(assignments)
    .where(and(eq(assignments.type, "MAINTENANCE_REQUEST"), eq(assignments.referenceId, mr.id), eq(assignments.assignedTo, technicianId), inArray(assignments.status, ["PENDING", "IN_PROGRESS"])));
  if (existing) return;
  await tx.insert(assignments).values({
    organizationId: mr.organizationId,
    type: "MAINTENANCE_REQUEST",
    assignedTo: technicianId,
    assignedBy: actorId,
    projectId: mr.projectId,
    vehicleId: mr.vehicleId,
    referenceId: mr.id,
    title: `صيانة ${mrLabel(mr)}: ${mr.issue}`.slice(0, 200),
    priority: mr.priority === "CRITICAL" ? "URGENT" : mr.priority,
  });
}

/** Closes the technician's assignment when the request ends. */
export async function finishTechnicianAssignment(tx: DbOrTx, mr: MR, status: "COMPLETED" | "CANCELLED") {
  await tx
    .update(assignments)
    .set({ status, updatedAt: new Date(), completedAt: status === "COMPLETED" ? new Date() : null })
    .where(and(eq(assignments.type, "MAINTENANCE_REQUEST"), eq(assignments.referenceId, mr.id), inArray(assignments.status, ["PENDING", "IN_PROGRESS"])));
}

// ---------------------------------------------------------------- notifications

/** Project managers of the request's project (manager + PROJECT-scoped handover holders). */
export async function projectManagersOf(tx: DbOrTx, mr: MR): Promise<string[]> {
  const ids = new Set(await permissionHolders(tx, mr.organizationId, "maintenance.handover", mr.projectId, { includeAllScope: false }));
  if (mr.projectId) {
    const [p] = await tx.select({ managerId: projects.managerId }).from(projects).where(eq(projects.id, mr.projectId));
    if (p?.managerId) ids.add(p.managerId);
  }
  return [...ids];
}

/**
 * Sends a maintenance notification. Recipients are filtered to active users of
 * the same org, minus the actor; project-scoped messages additionally pass the
 * project visibility guard in notifyUsers (no cross-project leakage).
 * Assigned technicians are always members of the project (enforced on assign).
 */
export async function notifyMaintenance(tx: DbOrTx, actorId: string, mr: MR, userIds: (string | null | undefined)[], type: string, title: string) {
  const recipients = [...new Set(userIds.filter((u): u is string => !!u && u !== actorId))];
  if (!recipients.length) return [];
  return notifyUsers(tx, {
    orgId: mr.organizationId,
    userIds: recipients,
    type,
    title,
    link: `/maintenance/${mr.id}`,
    entityType: "maintenance_request",
    entityId: mr.id,
    projectId: mr.projectId,
  });
}

/** SUPER_ADMIN-level recipients for exceptions (ALL-scoped approvers). */
export function exceptionRecipients(tx: DbOrTx, mr: MR) {
  return permissionHolders(tx, mr.organizationId, "maintenance.approve", mr.projectId, { includeAllScope: true, onlyAllScope: true });
}
