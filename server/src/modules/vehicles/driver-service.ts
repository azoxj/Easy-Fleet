import { and, eq, isNull } from "drizzle-orm";
import type { Request } from "express";
import { driverScope, type Access } from "../../auth/access.js";
import type { DbOrTx } from "../../db/client.js";
import { drivers, employees, vehicleDriverHistory, vehicles } from "../../db/schema/index.js";
import { badRequest, conflict, notFound } from "../../http/errors.js";
import { audit } from "../../services/audit.js";
import { driverEffectiveStatus } from "../../services/expiry.js";
import { notifyUsers } from "../../services/notifications.js";

type Vehicle = typeof vehicles.$inferSelect;
export type DriverTarget = { id: string; userId: string | null; fullName: string };

/**
 * Validates that `driverId` may take `vehicle`: visible to the caller, not
 * archived, effectively ACTIVE (valid license), same project as the vehicle,
 * and not currently holding another vehicle (`allowVehicleId` excepted).
 */
export async function eligibleDriver(db: DbOrTx, access: Access, vehicle: Vehicle, driverId: string, opts: { allowCurrentHolding?: boolean } = {}): Promise<DriverTarget> {
  const [d] = await db
    .select({
      id: drivers.id,
      status: drivers.status,
      archivedAt: drivers.archivedAt,
      licenseExpiryDate: drivers.licenseExpiryDate,
      employeeStatus: employees.status,
      projectId: employees.projectId,
      userId: employees.userId,
      fullName: employees.fullName,
    })
    .from(drivers)
    .innerJoin(employees, eq(employees.id, drivers.employeeId))
    .where(and(eq(drivers.id, driverId), driverScope(access, "drivers.read")))
    .limit(1);
  if (!d) throw notFound("السائق غير موجود");
  if (d.archivedAt) throw badRequest("السائق مؤرشف");
  const eff = driverEffectiveStatus(d.status, d.licenseExpiryDate, d.employeeStatus);
  if (eff === "EXPIRED") throw badRequest("رخصة السائق منتهية؛ لا يمكن إسناد مركبة إليه");
  if (eff !== "ACTIVE") throw badRequest("السائق غير نشط");
  if (d.projectId !== vehicle.projectId) throw badRequest("السائق لا يتبع مشروع المركبة");
  const [holding] = await db
    .select({ plate: vehicles.plateNumber, vehicleId: vehicles.id })
    .from(vehicleDriverHistory)
    .innerJoin(vehicles, eq(vehicles.id, vehicleDriverHistory.vehicleId))
    .where(and(eq(vehicleDriverHistory.driverId, d.id), isNull(vehicleDriverHistory.unassignedAt)));
  if (holding && !(opts.allowCurrentHolding && holding.vehicleId === vehicle.id)) throw conflict(`السائق مسند إليه المركبة ${holding.plate} حاليًا`);
  return { id: d.id, userId: d.userId, fullName: d.fullName };
}

async function driverName(db: DbOrTx, did: string | null) {
  if (!did) return null;
  const [r] = await db.select({ n: employees.fullName }).from(drivers).innerJoin(employees, eq(employees.id, drivers.employeeId)).where(eq(drivers.id, did));
  return r?.n ?? null;
}

/**
 * Sets (or clears) the vehicle's current driver inside `tx`: closes the open
 * history row, opens a new one, flips AVAILABLE⇄ASSIGNED, audits and notifies.
 * `access.userId` is null when the change comes from a public handover link.
 */
export type DriverActor = { orgId: string; userId: string | null };

export async function setVehicleDriver(tx: DbOrTx, req: Request, access: DriverActor, vehicle: Vehicle, target: DriverTarget | null, source?: string) {
  const fromName = await driverName(tx, vehicle.assignedDriverId);
  await tx
    .update(vehicleDriverHistory)
    .set({ unassignedAt: new Date(), unassignedBy: access.userId })
    .where(and(eq(vehicleDriverHistory.vehicleId, vehicle.id), isNull(vehicleDriverHistory.unassignedAt)));
  if (target) {
    await tx.insert(vehicleDriverHistory).values({ organizationId: access.orgId, vehicleId: vehicle.id, driverId: target.id, assignedBy: access.userId });
  }
  const status = target ? (vehicle.status === "AVAILABLE" ? "ASSIGNED" : vehicle.status) : vehicle.status === "ASSIGNED" ? "AVAILABLE" : vehicle.status;
  const [v] = await tx.update(vehicles).set({ assignedDriverId: target?.id ?? null, status, updatedAt: new Date() }).where(eq(vehicles.id, vehicle.id)).returning();
  await audit(tx, req, {
    action: "VEHICLE_DRIVER_CHANGED",
    entity: "vehicle",
    entityId: vehicle.id,
    projectId: v!.projectId,
    vehicleId: vehicle.id,
    metadata: {
      fromDriverId: vehicle.assignedDriverId,
      fromDriverName: fromName,
      toDriverId: target?.id ?? null,
      toDriverName: target?.fullName ?? null,
      ...(status !== vehicle.status ? { statusChange: { from: vehicle.status, to: status } } : {}),
      ...(source ? { source } : {}),
    },
    orgId: access.orgId,
    userId: access.userId,
    oldValue: { assignedDriverId: vehicle.assignedDriverId, status: vehicle.status },
    newValue: { assignedDriverId: target?.id ?? null, status },
  });
  if (target?.userId && target.userId !== access.userId) {
    await notifyUsers(tx, {
      orgId: access.orgId,
      userIds: [target.userId],
      type: "VEHICLE_DRIVER_ASSIGNED",
      title: `تم إسناد المركبة ${v!.plateNumber} إليك`,
      link: `/vehicles/${vehicle.id}`,
      entityType: "vehicle",
      entityId: vehicle.id,
    });
  }
  return v!;
}
