import { and, desc, eq, ilike, inArray, isNull, ne, or, sql } from "drizzle-orm";
import { Router } from "express";
import { z } from "zod";
import { assertCanUseProject, driverScope, getVehicleInScope, vehicleScope, type Access } from "../../auth/access.js";
import { db } from "../../db/client.js";
import { auditLogs, drivers, employees, maintenanceRequests, projects, users, vehicleDriverHistory, vehicles, vehicleStatus } from "../../db/schema/index.js";
import { ctx } from "../../http/context.js";
import { badRequest, conflict, forbidden, notFound } from "../../http/errors.js";
import { requirePermission } from "../../http/middleware.js";
import { idParam, isoDate, money, optionalText, paged, pagination, trimmed, uuid } from "../../http/validate.js";
import { audit, diff } from "../../services/audit.js";
import { driverEffectiveStatus } from "../../services/expiry.js";
import { notifyUsers } from "../../services/notifications.js";
import { describeEvent, TIMELINE_ENTITY_LABEL } from "../../services/timeline.js";

export const vehiclesRouter = Router();

/** Statuses a user may set by hand. The rest are driven by workflows (maintenance, handover, accidents). */
const MANUAL_STATUSES = ["AVAILABLE", "OUT_OF_SERVICE", "SOLD"] as const;
/** Fields a user with only ASSIGNED scope on vehicles.update may change. */
const ASSIGNED_EDITABLE = new Set(["currentOdometer", "notes"]);

const vehicleColumns = {
  id: vehicles.id,
  plateNumber: vehicles.plateNumber,
  vehicleNumber: vehicles.vehicleNumber,
  make: vehicles.make,
  model: vehicles.model,
  year: vehicles.year,
  color: vehicles.color,
  vin: vehicles.vin,
  currentOdometer: vehicles.currentOdometer,
  status: vehicles.status,
  projectId: vehicles.projectId,
  projectName: projects.name,
  assignedDriverId: vehicles.assignedDriverId,
  purchaseDate: vehicles.purchaseDate,
  purchasePrice: vehicles.purchasePrice,
  warrantyStart: vehicles.warrantyStart,
  warrantyEnd: vehicles.warrantyEnd,
  notes: vehicles.notes,
  archivedAt: vehicles.archivedAt,
  createdAt: vehicles.createdAt,
  updatedAt: vehicles.updatedAt,
};

const thisYear = new Date().getFullYear();

const VehicleBody = z.object({
  plateNumber: trimmed(2, 20),
  vehicleNumber: optionalText(30),
  make: trimmed(1, 60),
  model: trimmed(1, 60),
  year: z.coerce.number().int().min(1980).max(thisYear + 1).nullable().optional(),
  color: optionalText(30),
  vin: z
    .string()
    .trim()
    .toUpperCase()
    .regex(/^[A-HJ-NPR-Z0-9]{17}$/, "رقم الهيكل (VIN) يجب أن يكون 17 خانة")
    .nullable()
    .optional()
    .or(z.literal("").transform(() => null)),
  currentOdometer: z.coerce.number().int().min(0).max(5_000_000).optional(),
  status: z.enum(MANUAL_STATUSES).optional(),
  projectId: uuid.nullable().optional(),
  purchaseDate: isoDate.nullable().optional(),
  purchasePrice: money.nullable().optional(),
  warrantyStart: isoDate.nullable().optional(),
  warrantyEnd: isoDate.nullable().optional(),
  notes: optionalText(2000),
});

function checkWarranty(b: { warrantyStart?: string | null; warrantyEnd?: string | null }) {
  if (b.warrantyStart && b.warrantyEnd && b.warrantyEnd < b.warrantyStart) {
    throw badRequest("نهاية الضمان يجب أن تكون بعد بدايته");
  }
}

function capabilities(access: Access, v: { id: string; projectId: string | null; status: string }, inAssigned: boolean) {
  const reach = (perm: "vehicles.update" | "vehicles.archive") => {
    const s = access.scopeOf(perm);
    if (!s) return false;
    if (s === "ALL") return true;
    if (s === "PROJECT") return access.isMemberOf(v.projectId) || inAssigned;
    return inAssigned;
  };
  const archived = v.status === "ARCHIVED";
  return { update: !archived && reach("vehicles.update"), archive: !archived && reach("vehicles.archive") };
}

const ListQuery = pagination.extend({
  q: z.string().trim().max(100).optional(),
  status: z.enum(vehicleStatus.enumValues).optional(),
  projectId: uuid.optional(),
  includeArchived: z.enum(["true", "false"]).optional(),
});

vehiclesRouter.get("/", requirePermission("vehicles.read"), async (req, res) => {
  const { access } = ctx(req);
  const q = ListQuery.parse(req.query);
  const where = [vehicleScope(access, "vehicles.read")];
  if (q.q) {
    const like = `%${q.q}%`;
    where.push(or(ilike(vehicles.plateNumber, like), ilike(vehicles.vehicleNumber, like), ilike(vehicles.make, like), ilike(vehicles.model, like), ilike(vehicles.vin, like))!);
  }
  if (q.status) where.push(eq(vehicles.status, q.status));
  else if (q.includeArchived !== "true") where.push(ne(vehicles.status, "ARCHIVED"));
  if (q.projectId) where.push(eq(vehicles.projectId, q.projectId));
  const cond = and(...where);
  const [rows, [count]] = await Promise.all([
    db
      .select(vehicleColumns)
      .from(vehicles)
      .leftJoin(projects, eq(projects.id, vehicles.projectId))
      .where(cond)
      .orderBy(desc(vehicles.createdAt))
      .limit(q.pageSize)
      .offset((q.page - 1) * q.pageSize),
    db.select({ n: sql<number>`count(*)::int` }).from(vehicles).where(cond),
  ]);
  res.json(paged(rows, count?.n ?? 0, q.page, q.pageSize));
});

vehiclesRouter.get("/:id", requirePermission("vehicles.read"), async (req, res) => {
  const { access } = ctx(req);
  const { id } = idParam.parse(req.params);
  const [row] = await db
    .select(vehicleColumns)
    .from(vehicles)
    .leftJoin(projects, eq(projects.id, vehicles.projectId))
    .where(and(eq(vehicles.id, id), vehicleScope(access, "vehicles.read")))
    .limit(1);
  if (!row) throw notFound("المركبة غير موجودة");
  const inAssigned = await isAssignedToCaller(access, id);
  const [currentDriver] = row.assignedDriverId
    ? await db
        .select({ id: drivers.id, fullName: employees.fullName, licenseExpiryDate: drivers.licenseExpiryDate })
        .from(drivers)
        .innerJoin(employees, eq(employees.id, drivers.employeeId))
        .where(eq(drivers.id, row.assignedDriverId))
    : [];
  const caps = capabilities(access, row, inAssigned);
  const updateScope = access.scopeOf("vehicles.update");
  const canChangeDriver =
    caps.update && access.has("drivers.read") && (updateScope === "ALL" || (updateScope === "PROJECT" && access.isMemberOf(row.projectId)));
  res.json({ data: { ...row, currentDriver: currentDriver ?? null, capabilities: { ...caps, changeDriver: canChangeDriver } } });
});

async function isAssignedToCaller(access: Access, vehicleId: string): Promise<boolean> {
  // Reuse the ASSIGNED predicate by evaluating it with an ASSIGNED-only view of the permission.
  const [r] = await db.execute<{ ok: boolean }>(sql`
    select exists (
      select 1 from assignments asg join vehicles av on av.id = asg.vehicle_id
       where asg.vehicle_id = ${vehicleId} and asg.assigned_to = ${access.userId}
         and asg.organization_id = ${access.orgId} and asg.type = 'VEHICLE'
         and asg.status in ('PENDING','IN_PROGRESS')
         and asg.project_id is not distinct from av.project_id
      union all
      select 1 from vehicles dv join drivers d on d.id = dv.assigned_driver_id and d.status = 'ACTIVE'
        join employees e on e.id = d.employee_id
       where dv.id = ${vehicleId} and e.user_id = ${access.userId} and dv.organization_id = ${access.orgId}
    ) as ok`).then((r) => r.rows);
  return !!r?.ok;
}

vehiclesRouter.post("/", requirePermission("vehicles.create"), async (req, res) => {
  const { access } = ctx(req);
  const body = VehicleBody.parse(req.body);
  checkWarranty(body);
  if (body.projectId) await assertCanUseProject(db, access, body.projectId, "vehicles.create");
  else if (access.require("vehicles.create") !== "ALL") throw forbidden("يجب اختيار مشروع من مشاريعك");

  const created = await db.transaction(async (tx) => {
    const [v] = await tx
      .insert(vehicles)
      .values({
        organizationId: access.orgId,
        plateNumber: body.plateNumber,
        vehicleNumber: body.vehicleNumber ?? null,
        make: body.make,
        model: body.model,
        year: body.year ?? null,
        color: body.color ?? null,
        vin: body.vin ?? null,
        currentOdometer: body.currentOdometer ?? 0,
        status: body.status ?? "AVAILABLE",
        projectId: body.projectId ?? null,
        purchaseDate: body.purchaseDate ?? null,
        purchasePrice: body.purchasePrice ?? null,
        warrantyStart: body.warrantyStart ?? null,
        warrantyEnd: body.warrantyEnd ?? null,
        notes: body.notes ?? null,
        createdBy: access.userId,
      })
      .returning();
    await audit(tx, req, {
      action: "VEHICLE_CREATED",
      entity: "vehicle",
      entityId: v!.id,
      projectId: v!.projectId,
      vehicleId: v!.id,
      metadata: { plateNumber: v!.plateNumber, projectId: v!.projectId },
    });
    if (v!.projectId) await notifyProjectManager(tx, access, v!.projectId, v!.id, `تمت إضافة المركبة ${v!.plateNumber} إلى مشروعك`);
    return v!;
  });
  res.status(201).json({ data: created });
});

async function notifyProjectManager(tx: Parameters<typeof notifyUsers>[0], access: Access, projectId: string, vehicleId: string, title: string) {
  const [p] = await tx
    .select({ managerId: projects.managerId })
    .from(projects)
    .where(and(eq(projects.id, projectId), eq(projects.organizationId, access.orgId)));
  if (!p?.managerId || p.managerId === access.userId) return;
  await notifyUsers(tx, {
    orgId: access.orgId,
    userIds: [p.managerId],
    type: "VEHICLE_ADDED_TO_PROJECT",
    title,
    link: `/vehicles/${vehicleId}`,
    entityType: "vehicle",
    entityId: vehicleId,
    projectId,
  });
}

const UpdateVehicle = VehicleBody.partial().strict();

vehiclesRouter.patch("/:id", requirePermission("vehicles.update"), async (req, res) => {
  const { access } = ctx(req);
  const { id } = idParam.parse(req.params);
  const before = await getVehicleInScope(db, access, id, "vehicles.read");
  // Second, independent check: the record must also be inside the *update* scope.
  await getVehicleInScope(db, access, id, "vehicles.update");
  if (before.status === "ARCHIVED") throw badRequest("لا يمكن تعديل مركبة مؤرشفة");

  const patch = UpdateVehicle.parse(req.body);
  const scope = access.require("vehicles.update");
  if (scope === "ASSIGNED" && Object.keys(patch).some((k) => !ASSIGNED_EDITABLE.has(k))) {
    throw forbidden("يمكنك تعديل العداد والملاحظات فقط لهذه المركبة");
  }
  if (scope === "PROJECT" && !access.isMemberOf(before.projectId) && Object.keys(patch).some((k) => !ASSIGNED_EDITABLE.has(k))) {
    throw forbidden("يمكنك تعديل العداد والملاحظات فقط لهذه المركبة");
  }
  if (patch.status !== undefined && before.status === "IN_MAINTENANCE") {
    throw conflict("حالة المركبة تُدار من سير عمل الصيانة ولا يمكن تغييرها يدويًا");
  }
  checkWarranty({ warrantyStart: patch.warrantyStart ?? before.warrantyStart, warrantyEnd: patch.warrantyEnd ?? before.warrantyEnd });
  if (patch.currentOdometer !== undefined && patch.currentOdometer < before.currentOdometer && scope !== "ALL") {
    throw badRequest("لا يمكن إنقاص قراءة العداد");
  }
  if (patch.projectId !== undefined && patch.projectId !== before.projectId) {
    if (patch.projectId === null) {
      if (scope !== "ALL") throw forbidden("إزالة المركبة من المشروع تتطلب صلاحية الإدارة");
    } else {
      await assertCanUseProject(db, access, patch.projectId, "vehicles.update");
    }
  }

  const updated = await db.transaction(async (tx) => {
    const [v] = await tx
      .update(vehicles)
      .set({ ...patch, updatedAt: new Date() })
      .where(and(eq(vehicles.id, id), eq(vehicles.organizationId, access.orgId)))
      .returning();
    const changes = diff(before, patch);
    if (Object.keys(changes).length) {
      const metadata: Record<string, unknown> = { changes };
      if (changes.projectId) metadata.projectNames = await projectNames(tx, [before.projectId, v!.projectId]);
      await audit(tx, req, { action: "VEHICLE_UPDATED", entity: "vehicle", entityId: id, projectId: v!.projectId, vehicleId: id, metadata });
    }
    if (patch.projectId && patch.projectId !== before.projectId) {
      await notifyProjectManager(tx, access, patch.projectId, id, `تم نقل المركبة ${v!.plateNumber} إلى مشروعك`);
    }
    return v!;
  });
  res.json({ data: updated });
});

vehiclesRouter.post("/:id/archive", requirePermission("vehicles.archive"), async (req, res) => {
  const { access } = ctx(req);
  const { id } = idParam.parse(req.params);
  const before = await getVehicleInScope(db, access, id, "vehicles.archive");
  if (before.status === "ARCHIVED") throw badRequest("المركبة مؤرشفة مسبقًا");
  if (before.assignedDriverId) throw conflict("ألغِ إسناد السائق قبل أرشفة المركبة");
  const [openMr] = await db
    .select({ n: maintenanceRequests.number })
    .from(maintenanceRequests)
    .where(and(eq(maintenanceRequests.vehicleId, id), inArray(maintenanceRequests.status, ["REQUESTED", "INSPECTION", "QUOTE_PENDING", "PENDING_APPROVAL", "APPROVED", "IN_REPAIR", "READY_FOR_HANDOVER", "ACCEPTED"])))
    .limit(1);
  if (openMr) throw conflict(`للمركبة طلب صيانة مفتوح MR-${openMr.n}؛ أغلقه قبل الأرشفة`);
  const reason = z.object({ reason: optionalText(500) }).parse(req.body ?? {}).reason ?? null;
  const updated = await db.transaction(async (tx) => {
    const [v] = await tx
      .update(vehicles)
      .set({ status: "ARCHIVED", archivedAt: new Date(), updatedAt: new Date() })
      .where(eq(vehicles.id, id))
      .returning();
    await audit(tx, req, { action: "VEHICLE_ARCHIVED", entity: "vehicle", entityId: id, projectId: v!.projectId, vehicleId: id, metadata: { previousStatus: before.status, reason } });
    return v!;
  });
  res.json({ data: updated });
});

/**
 * Vehicle timeline built from the append-only audit trail: every event tagged
 * with this vehicle (documents, insurance, driver changes, assignments...) plus
 * legacy rows keyed by entity. Read-only — there is no endpoint to add or edit entries.
 */
vehiclesRouter.get("/:id/timeline", requirePermission("vehicles.read"), async (req, res) => {
  const { access } = ctx(req);
  const { id } = idParam.parse(req.params);
  await getVehicleInScope(db, access, id, "vehicles.read");
  const rows = await db
    .select({
      id: auditLogs.id,
      action: auditLogs.action,
      entity: auditLogs.entity,
      metadata: auditLogs.metadata,
      createdAt: auditLogs.createdAt,
      actor: users.name,
    })
    .from(auditLogs)
    .leftJoin(users, eq(users.id, auditLogs.userId))
    .where(
      and(
        eq(auditLogs.organizationId, access.orgId),
        or(eq(auditLogs.vehicleId, id), and(eq(auditLogs.entity, "vehicle"), eq(auditLogs.entityId, id))),
        ne(auditLogs.action, "FILE_DOWNLOADED"),
      ),
    )
    .orderBy(desc(auditLogs.id))
    .limit(300);
  res.json({
    data: rows.map((r) => ({
      id: r.id,
      action: r.action,
      entity: r.entity,
      entityLabel: TIMELINE_ENTITY_LABEL[r.entity] ?? r.entity,
      actor: r.actor ?? "النظام",
      timestamp: r.createdAt,
      description: describeEvent(r.action, r.metadata ?? null),
      changes: (r.metadata as { changes?: unknown } | null)?.changes ?? null,
    })),
  });
});

async function projectNames(tx: Parameters<typeof notifyUsers>[0], ids: (string | null)[]) {
  const [from, to] = ids;
  const lookup = async (pid: string | null) =>
    pid ? ((await tx.select({ name: projects.name }).from(projects).where(eq(projects.id, pid)))[0]?.name ?? null) : null;
  return { from: await lookup(from ?? null), to: await lookup(to ?? null) };
}

// ------------------------------------------------------------ driver assignment

const SetDriver = z.object({ driverId: uuid.nullable() }).strict();

/**
 * Assigns (or clears) the vehicle's current driver and records history.
 * Rules: caller must be able to update the vehicle with PROJECT/ALL scope and
 * see the driver; the driver must belong to the vehicle's project, be
 * effectively ACTIVE (valid license) and not already hold another vehicle.
 */
vehiclesRouter.put("/:id/driver", requirePermission("vehicles.update"), requirePermission("drivers.read"), async (req, res) => {
  const { access } = ctx(req);
  const { id } = idParam.parse(req.params);
  const vehicle = await getVehicleInScope(db, access, id, "vehicles.update");
  const scope = access.require("vehicles.update");
  if (scope === "ASSIGNED" || (scope === "PROJECT" && !access.isMemberOf(vehicle.projectId))) throw forbidden();
  if (vehicle.status === "ARCHIVED") throw badRequest("لا يمكن تعديل مركبة مؤرشفة");
  const { driverId } = SetDriver.parse(req.body);
  if (driverId === vehicle.assignedDriverId) throw badRequest("لا يوجد تغيير");

  const nameOf = async (did: string | null) =>
    did
      ? ((await db.select({ n: employees.fullName }).from(drivers).innerJoin(employees, eq(employees.id, drivers.employeeId)).where(eq(drivers.id, did)))[0]?.n ?? null)
      : null;

  let target: { id: string; userId: string | null; fullName: string } | null = null;
  if (driverId) {
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
      .select({ plate: vehicles.plateNumber })
      .from(vehicleDriverHistory)
      .innerJoin(vehicles, eq(vehicles.id, vehicleDriverHistory.vehicleId))
      .where(and(eq(vehicleDriverHistory.driverId, d.id), isNull(vehicleDriverHistory.unassignedAt)));
    if (holding) throw conflict(`السائق مسند إليه المركبة ${holding.plate} حاليًا`);
    target = d;
  }

  const fromName = await nameOf(vehicle.assignedDriverId);
  const updated = await db.transaction(async (tx) => {
    await tx
      .update(vehicleDriverHistory)
      .set({ unassignedAt: new Date(), unassignedBy: access.userId })
      .where(and(eq(vehicleDriverHistory.vehicleId, id), isNull(vehicleDriverHistory.unassignedAt)));
    if (target) {
      await tx.insert(vehicleDriverHistory).values({ organizationId: access.orgId, vehicleId: id, driverId: target.id, assignedBy: access.userId });
    }
    const status = target ? (vehicle.status === "AVAILABLE" ? "ASSIGNED" : vehicle.status) : vehicle.status === "ASSIGNED" ? "AVAILABLE" : vehicle.status;
    const [v] = await tx
      .update(vehicles)
      .set({ assignedDriverId: target?.id ?? null, status, updatedAt: new Date() })
      .where(eq(vehicles.id, id))
      .returning();
    await audit(tx, req, {
      action: "VEHICLE_DRIVER_CHANGED",
      entity: "vehicle",
      entityId: id,
      projectId: v!.projectId,
      vehicleId: id,
      metadata: {
        fromDriverId: vehicle.assignedDriverId,
        fromDriverName: fromName,
        toDriverId: target?.id ?? null,
        toDriverName: target?.fullName ?? null,
        ...(status !== vehicle.status ? { statusChange: { from: vehicle.status, to: status } } : {}),
      },
    });
    if (target?.userId && target.userId !== access.userId) {
      await notifyUsers(tx, {
        orgId: access.orgId,
        userIds: [target.userId],
        type: "VEHICLE_DRIVER_ASSIGNED",
        title: `تم إسناد المركبة ${v!.plateNumber} إليك`,
        link: `/vehicles/${id}`,
        entityType: "vehicle",
        entityId: id,
      });
    }
    return v!;
  });
  res.json({ data: { id: updated.id, assignedDriverId: updated.assignedDriverId, status: updated.status } });
});
