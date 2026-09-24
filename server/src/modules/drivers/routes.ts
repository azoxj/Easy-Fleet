import { and, asc, desc, eq, ilike, isNull, or, sql, type SQL } from "drizzle-orm";
import { Router } from "express";
import { z } from "zod";
import { driverScope, employeeScope, vehicleScope, type Access } from "../../auth/access.js";
import { db } from "../../db/client.js";
import { drivers, driverStatus, employees, licenseType, projects, vehicleDriverHistory, vehicles } from "../../db/schema/index.js";
import { ctx } from "../../http/context.js";
import { badRequest, conflict, forbidden, notFound } from "../../http/errors.js";
import { requirePermission } from "../../http/middleware.js";
import { idParam, isoDate, optionalText, paged, pagination, uuid } from "../../http/validate.js";
import { audit, diff } from "../../services/audit.js";
import { daysUntil, driverEffectiveStatus, expiryStatus, expiryWindow } from "../../services/expiry.js";
import { employeeRowInScope } from "../employees/service.js";

export const driversRouter = Router();

const columns = {
  id: drivers.id,
  employeeId: drivers.employeeId,
  fullName: employees.fullName,
  employeeNumber: employees.employeeNumber,
  employeeStatus: employees.status,
  employeeUserId: employees.userId,
  phone: employees.phone,
  projectId: employees.projectId,
  projectName: projects.name,
  licenseNumber: drivers.licenseNumber,
  licenseType: drivers.licenseType,
  licenseIssueDate: drivers.licenseIssueDate,
  licenseExpiryDate: drivers.licenseExpiryDate,
  storedStatus: drivers.status,
  notes: drivers.notes,
  archivedAt: drivers.archivedAt,
  currentVehicleId: vehicles.id,
  currentVehiclePlate: vehicles.plateNumber,
  createdAt: drivers.createdAt,
  updatedAt: drivers.updatedAt,
};

type Row = { [K in keyof typeof columns]: unknown } & {
  storedStatus: "ACTIVE" | "SUSPENDED" | "INACTIVE";
  licenseExpiryDate: string | null;
  employeeStatus: string;
  projectId: string | null;
  employeeUserId: string | null;
};

function present(r: Row) {
  const { employeeUserId: _u, ...rest } = r;
  return {
    ...rest,
    status: driverEffectiveStatus(r.storedStatus, r.licenseExpiryDate, r.employeeStatus),
    licenseStatus: r.licenseExpiryDate ? expiryStatus(r.licenseExpiryDate) : null,
    licenseDaysLeft: r.licenseExpiryDate ? daysUntil(r.licenseExpiryDate) : null,
  };
}

function baseQuery() {
  return db
    .select(columns)
    .from(drivers)
    .innerJoin(employees, eq(employees.id, drivers.employeeId))
    .leftJoin(projects, eq(projects.id, employees.projectId))
    .leftJoin(vehicles, eq(vehicles.assignedDriverId, drivers.id));
}

/** SQL mirror of driverEffectiveStatus() so the list can be filtered by the computed status. */
function effectiveStatusFilter(status: string): SQL {
  const { today } = expiryWindow();
  const expired = sql`(${drivers.licenseExpiryDate} is not null and ${drivers.licenseExpiryDate} < ${today})`;
  const empActive = sql`${employees.status} = 'ACTIVE'`;
  switch (status) {
    case "INACTIVE":
      return sql`(not ${empActive} or ${drivers.status} = 'INACTIVE')`;
    case "SUSPENDED":
      return sql`(${empActive} and ${drivers.status} = 'SUSPENDED')`;
    case "EXPIRED":
      return sql`(${empActive} and ${drivers.status} = 'ACTIVE' and ${expired})`;
    default:
      return sql`(${empActive} and ${drivers.status} = 'ACTIVE' and not ${expired})`;
  }
}

const ListQuery = pagination.extend({
  q: z.string().trim().max(100).optional(),
  projectId: uuid.optional(),
  status: z.enum(["ACTIVE", "EXPIRED", "SUSPENDED", "INACTIVE"]).optional(),
  licenseStatus: z.enum(["EXPIRING_SOON", "EXPIRED"]).optional(),
  includeArchived: z.enum(["true", "false"]).optional(),
});

driversRouter.get("/", requirePermission("drivers.read"), async (req, res) => {
  const { access } = ctx(req);
  const q = ListQuery.parse(req.query);
  const where: SQL[] = [driverScope(access, "drivers.read")];
  if (q.q) {
    const like = `%${q.q}%`;
    where.push(or(ilike(employees.fullName, like), ilike(employees.employeeNumber, like), ilike(drivers.licenseNumber, like))!);
  }
  if (q.projectId) where.push(eq(employees.projectId, q.projectId));
  if (q.status) where.push(effectiveStatusFilter(q.status));
  if (q.licenseStatus) {
    const w = expiryWindow();
    where.push(
      q.licenseStatus === "EXPIRED"
        ? sql`${drivers.licenseExpiryDate} < ${w.today}`
        : sql`${drivers.licenseExpiryDate} between ${w.today} and ${w.soonUntil}`,
    );
  }
  if (q.includeArchived !== "true") where.push(isNull(drivers.archivedAt));
  const cond = and(...where);
  const [rows, [count]] = await Promise.all([
    baseQuery().where(cond).orderBy(asc(employees.fullName)).limit(q.pageSize).offset((q.page - 1) * q.pageSize),
    db.select({ n: sql<number>`count(*)::int` }).from(drivers).innerJoin(employees, eq(employees.id, drivers.employeeId)).where(cond),
  ]);
  res.json(paged(rows.map((r) => present(r as Row)), count?.n ?? 0, q.page, q.pageSize));
});

async function getDriverInScope(a: Access, id: string, perm: "drivers.read" | "drivers.update" | "drivers.archive") {
  const [row] = await baseQuery()
    .where(and(eq(drivers.id, id), driverScope(a, perm)))
    .limit(1);
  if (!row) throw notFound("السائق غير موجود");
  return row as Row & { archivedAt: Date | null; currentVehicleId: string | null; currentVehiclePlate: string | null };
}

driversRouter.get("/:id", requirePermission("drivers.read"), async (req, res) => {
  const { access } = ctx(req);
  const { id } = idParam.parse(req.params);
  const d = await getDriverInScope(access, id, "drivers.read");

  // Vehicle history: vehicles outside the caller's vehicle scope are listed without identifying details.
  const readable = access.has("vehicles.read") ? vehicleScope(access, "vehicles.read") : sql`false`;
  const history = await db
    .select({
      id: vehicleDriverHistory.id,
      vehicleId: vehicleDriverHistory.vehicleId,
      plateNumber: vehicles.plateNumber,
      assignedAt: vehicleDriverHistory.assignedAt,
      unassignedAt: vehicleDriverHistory.unassignedAt,
      readable: sql<boolean>`(${readable})`,
    })
    .from(vehicleDriverHistory)
    .innerJoin(vehicles, eq(vehicles.id, vehicleDriverHistory.vehicleId))
    .where(and(eq(vehicleDriverHistory.driverId, id), eq(vehicleDriverHistory.organizationId, access.orgId)))
    .orderBy(desc(vehicleDriverHistory.assignedAt))
    .limit(100);

  const p = present(d);
  const alerts: { level: "warning" | "danger"; message: string }[] = [];
  if (p.licenseStatus === "EXPIRED") alerts.push({ level: "danger", message: "رخصة القيادة منتهية" });
  else if (p.licenseStatus === "EXPIRING_SOON") alerts.push({ level: "warning", message: `رخصة القيادة تنتهي خلال ${p.licenseDaysLeft} يوم` });
  if (!d.licenseNumber) alerts.push({ level: "warning", message: "لم يتم إدخال رقم الرخصة" });

  const canUpdate = !d.archivedAt && access.scopeOf("drivers.update") !== "ASSIGNED" && employeeRowInScope(access, { projectId: d.projectId, userId: d.employeeUserId }, "drivers.update");
  res.json({
    data: {
      ...p,
      history: history.map((h) => (h.readable ? h : { ...h, vehicleId: null, plateNumber: null })),
      alerts,
      capabilities: {
        update: canUpdate,
        archive: !d.archivedAt && employeeRowInScope(access, { projectId: d.projectId, userId: d.employeeUserId }, "drivers.archive"),
      },
    },
  });
});

const DriverBody = z.object({
  licenseNumber: z.string().trim().min(3).max(30).regex(/^[A-Za-z0-9-]+$/, "رقم الرخصة غير صالح").nullable().optional().or(z.literal("").transform(() => null)),
  licenseType: z.enum(licenseType.enumValues).nullable().optional(),
  licenseIssueDate: isoDate.nullable().optional(),
  licenseExpiryDate: isoDate.nullable().optional(),
  notes: optionalText(2000),
});

function checkLicenseDates(issue?: string | null, expiry?: string | null) {
  if (issue && expiry && expiry < issue) throw badRequest("تاريخ انتهاء الرخصة يجب أن يكون بعد تاريخ الإصدار");
}

driversRouter.post("/", requirePermission("drivers.create"), async (req, res) => {
  const { access } = ctx(req);
  const body = DriverBody.extend({ employeeId: uuid }).strict().parse(req.body);
  if (access.require("drivers.create") === "ASSIGNED") throw forbidden();
  checkLicenseDates(body.licenseIssueDate, body.licenseExpiryDate);
  // The employee must be inside the caller's drivers.create scope; its project becomes the driver's project.
  const [emp] = await db
    .select()
    .from(employees)
    .where(and(eq(employees.id, body.employeeId), employeeScope(access, "drivers.create")))
    .limit(1);
  if (!emp) throw notFound("الموظف غير موجود");
  if (emp.status !== "ACTIVE") throw badRequest("لا يمكن إنشاء ملف سائق لموظف غير نشط");
  const [existing] = await db.select({ id: drivers.id }).from(drivers).where(eq(drivers.employeeId, emp.id));
  if (existing) throw conflict("لهذا الموظف ملف سائق مسبقًا");

  const created = await db.transaction(async (tx) => {
    const [d] = await tx
      .insert(drivers)
      .values({
        organizationId: access.orgId,
        employeeId: emp.id,
        licenseNumber: body.licenseNumber ?? null,
        licenseType: body.licenseType ?? null,
        licenseIssueDate: body.licenseIssueDate ?? null,
        licenseExpiryDate: body.licenseExpiryDate ?? null,
        notes: body.notes ?? null,
        createdBy: access.userId,
      })
      .returning();
    await audit(tx, req, { action: "DRIVER_CREATED", entity: "driver", entityId: d!.id, projectId: emp.projectId, metadata: { employeeId: emp.id, fullName: emp.fullName } });
    return d!;
  });
  res.status(201).json({ data: { id: created.id, employeeId: created.employeeId } });
});

const UpdateDriver = DriverBody.extend({ status: z.enum(driverStatus.enumValues).optional() }).strict();

driversRouter.patch("/:id", requirePermission("drivers.update"), async (req, res) => {
  const { access } = ctx(req);
  const { id } = idParam.parse(req.params);
  const d = await getDriverInScope(access, id, "drivers.read");
  if (access.scopeOf("drivers.update") === "ASSIGNED" || !employeeRowInScope(access, { projectId: d.projectId, userId: d.employeeUserId }, "drivers.update")) throw forbidden();
  if (d.archivedAt) throw badRequest("لا يمكن تعديل سائق مؤرشف");
  const patch = UpdateDriver.parse(req.body);
  checkLicenseDates(patch.licenseIssueDate ?? d.licenseIssueDate as string | null, patch.licenseExpiryDate ?? d.licenseExpiryDate);
  if (patch.status && patch.status !== "ACTIVE" && d.currentVehicleId) {
    throw conflict(`السائق مسند إليه المركبة ${d.currentVehiclePlate}؛ ألغِ الإسناد أولًا`);
  }
  const [before] = await db.select().from(drivers).where(eq(drivers.id, id));
  await db.transaction(async (tx) => {
    await tx.update(drivers).set({ ...patch, updatedAt: new Date() }).where(eq(drivers.id, id));
    const changes = diff(before!, patch);
    if (Object.keys(changes).length) await audit(tx, req, { action: "DRIVER_UPDATED", entity: "driver", entityId: id, projectId: d.projectId, metadata: { changes } });
  });
  res.json({ data: { id } });
});

driversRouter.post("/:id/archive", requirePermission("drivers.archive"), async (req, res) => {
  const { access } = ctx(req);
  const { id } = idParam.parse(req.params);
  const d = await getDriverInScope(access, id, "drivers.archive");
  if (d.archivedAt) throw badRequest("السائق مؤرشف مسبقًا");
  if (d.currentVehicleId) throw conflict(`السائق مسند إليه المركبة ${d.currentVehiclePlate}؛ ألغِ الإسناد أولًا`);
  await db.transaction(async (tx) => {
    await tx.update(drivers).set({ status: "INACTIVE", archivedAt: new Date(), updatedAt: new Date() }).where(eq(drivers.id, id));
    await audit(tx, req, { action: "DRIVER_ARCHIVED", entity: "driver", entityId: id, projectId: d.projectId });
  });
  res.json({ data: { id } });
});
