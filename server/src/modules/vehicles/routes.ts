import { and, desc, eq, ilike, ne, or, sql } from "drizzle-orm";
import { Router } from "express";
import { z } from "zod";
import { assertCanUseProject, getVehicleInScope, vehicleScope, type Access } from "../../auth/access.js";
import { db } from "../../db/client.js";
import { auditLogs, projects, users, vehicles, vehicleStatus } from "../../db/schema/index.js";
import { ctx } from "../../http/context.js";
import { badRequest, forbidden, notFound } from "../../http/errors.js";
import { requirePermission } from "../../http/middleware.js";
import { idParam, isoDate, money, optionalText, paged, pagination, trimmed, uuid } from "../../http/validate.js";
import { audit, diff } from "../../services/audit.js";
import { notifyUsers } from "../../services/notifications.js";

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
  res.json({ data: { ...row, capabilities: capabilities(access, row, inAssigned) } });
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
      await audit(tx, req, { action: "VEHICLE_UPDATED", entity: "vehicle", entityId: id, projectId: v!.projectId, metadata: { changes } });
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
  const reason = z.object({ reason: optionalText(500) }).parse(req.body ?? {}).reason ?? null;
  const updated = await db.transaction(async (tx) => {
    const [v] = await tx
      .update(vehicles)
      .set({ status: "ARCHIVED", archivedAt: new Date(), updatedAt: new Date() })
      .where(eq(vehicles.id, id))
      .returning();
    await audit(tx, req, { action: "VEHICLE_ARCHIVED", entity: "vehicle", entityId: id, projectId: v!.projectId, metadata: { previousStatus: before.status, reason } });
    return v!;
  });
  res.json({ data: updated });
});

/** Vehicle history from the audit trail — visible to anyone who may read the vehicle. */
vehiclesRouter.get("/:id/timeline", requirePermission("vehicles.read"), async (req, res) => {
  const { access } = ctx(req);
  const { id } = idParam.parse(req.params);
  await getVehicleInScope(db, access, id, "vehicles.read");
  const rows = await db
    .select({
      id: auditLogs.id,
      action: auditLogs.action,
      metadata: auditLogs.metadata,
      createdAt: auditLogs.createdAt,
      userName: users.name,
    })
    .from(auditLogs)
    .leftJoin(users, eq(users.id, auditLogs.userId))
    .where(and(eq(auditLogs.entity, "vehicle"), eq(auditLogs.entityId, id), eq(auditLogs.organizationId, access.orgId)))
    .orderBy(desc(auditLogs.createdAt))
    .limit(200);
  res.json({ data: rows });
});
