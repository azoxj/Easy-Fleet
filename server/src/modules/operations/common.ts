import { and, desc, eq, or, sql, type AnyColumn, type SQL } from "drizzle-orm";
import type { PgTable } from "drizzle-orm/pg-core";
import express from "express";
import { driverIsUser, getVehicleInScope, hasAssignment, ownDriverId, recordScope, vehicleAssignedTo, type Access } from "../../auth/access.js";
import type { PermissionKey } from "../../auth/permissions.js";
import { db, type DbOrTx } from "../../db/client.js";
import { auditLogs, drivers, employees, users } from "../../db/schema/index.js";
import { badRequest, forbidden, notFound } from "../../http/errors.js";
import { now } from "../../lib/clock.js";
import { MAX_UPLOAD_BYTES } from "../../services/storage.js";

export const rawUpload = express.raw({ type: () => true, limit: MAX_UPLOAD_BYTES });

/**
 * Scope for records that belong to a vehicle (fuel, accidents, violations):
 *  ALL → org · PROJECT → member projects or "assigned" · ASSIGNED → assigned only.
 * "Assigned" = the vehicle is assigned to / driven by the user, the record's
 * driver is the user, the user created it, or an explicit assignment points at it.
 */
type VehicleRecordTable = PgTable & { organizationId: AnyColumn; projectId: AnyColumn; vehicleId: AnyColumn; driverId: AnyColumn; createdBy: AnyColumn; id: AnyColumn };

/** Boolean SQL: the record is "assigned" to the user (see vehicleRecordScope). */
export function vehicleRecordAssigned(a: Access, t: VehicleRecordTable, assignmentType?: string): SQL {
  const parts: SQL[] = [vehicleAssignedTo(a, t.vehicleId), driverIsUser(a, t.driverId), sql`${t.createdBy} = ${a.userId}`];
  if (assignmentType) parts.push(hasAssignment(a, assignmentType, t.id));
  return sql`(${or(...parts)})`;
}

export function vehicleRecordScope(a: Access, perm: PermissionKey, t: VehicleRecordTable, assignmentType?: string): SQL {
  return recordScope(a, perm, { orgCol: t.organizationId, projectCol: t.projectId, assigned: vehicleRecordAssigned(a, t, assignmentType) });
}

export async function isVehicleRecordAssigned(a: Access, t: VehicleRecordTable, id: string, assignmentType?: string): Promise<boolean> {
  const rows = await db
    .select({ ok: sql<number>`1` })
    .from(t as PgTable)
    .where(and(eq(t.id, id), vehicleRecordAssigned(a, t, assignmentType)))
    .limit(1);
  return rows.length > 0;
}

/**
 * Resolves the vehicle a new record is created for. The vehicle must be in the
 * caller's scope for `perm`; PROJECT scope requires membership of the vehicle's
 * project. The record's projectId always comes from the vehicle (never the client).
 */
export async function vehicleForCreate(tx: DbOrTx, a: Access, vehicleId: string, perm: PermissionKey) {
  const v = await getVehicleInScope(tx, a, vehicleId, perm);
  if (v.status === "ARCHIVED" || v.status === "SOLD") throw badRequest("المركبة مؤرشفة أو مباعة");
  return v;
}

/**
 * Picks the driver for a new record. Users with ASSIGNED scope may only record
 * for themselves (their own driver profile, when they have one). Others may
 * choose any driver of the vehicle's project, defaulting to the vehicle's driver.
 */
export async function resolveDriver(tx: DbOrTx, a: Access, perm: PermissionKey, vehicle: { projectId: string | null; assignedDriverId: string | null }, requested: string | null | undefined): Promise<string | null> {
  const scope = a.require(perm);
  if (scope === "ASSIGNED") {
    const own = await ownDriverId(tx, a);
    if (requested && requested !== own) throw forbidden("يمكنك التسجيل باسمك فقط");
    return own ?? vehicle.assignedDriverId;
  }
  if (requested === undefined) return vehicle.assignedDriverId;
  if (requested === null) return null;
  const [d] = await tx
    .select({ id: drivers.id, projectId: employees.projectId })
    .from(drivers)
    .innerJoin(employees, eq(employees.id, drivers.employeeId))
    .where(and(eq(drivers.id, requested), eq(drivers.organizationId, a.orgId)));
  if (!d) throw notFound("السائق غير موجود");
  if (d.projectId !== vehicle.projectId) throw badRequest("السائق لا يتبع مشروع المركبة");
  return d.id;
}

export function assertNotFuture(ts: Date, label: string) {
  if (ts.getTime() > now().getTime() + 5 * 60_000) throw badRequest(`${label} لا يمكن أن يكون في المستقبل`);
}

/** Point check before an action on a loaded record (PROJECT scope must be a member to act). */
export function assertCanAct(a: Access, perm: PermissionKey, rec: { projectId: string | null }, isAssigned: boolean) {
  const s = a.scopeOf(perm);
  if (!s) throw forbidden();
  if (s === "ALL") return;
  if (s === "PROJECT" && a.isMemberOf(rec.projectId)) return;
  if (s === "ASSIGNED" && isAssigned) return;
  throw forbidden();
}

/** Audit rows for one record → read-only timeline. */
export async function recordTimeline(orgId: string, entity: string, entityId: string) {
  return db
    .select({ id: auditLogs.id, action: auditLogs.action, metadata: auditLogs.metadata, oldValue: auditLogs.oldValue, newValue: auditLogs.newValue, createdAt: auditLogs.createdAt, userName: users.name })
    .from(auditLogs)
    .leftJoin(users, eq(users.id, auditLogs.userId))
    .where(and(eq(auditLogs.organizationId, orgId), eq(auditLogs.entity, entity), eq(auditLogs.entityId, entityId)))
    .orderBy(desc(auditLogs.createdAt))
    .limit(100);
}

/** Driver display name subquery. */
export const driverNameSql = (driverCol: AnyColumn) =>
  sql<string | null>`(select e.full_name from drivers d join employees e on e.id = d.employee_id where d.id = ${driverCol})`;
