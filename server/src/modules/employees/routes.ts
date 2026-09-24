import { and, asc, eq, ilike, isNull, ne, or, sql } from "drizzle-orm";
import { Router } from "express";
import { z } from "zod";
import { assertCanUseProject, employeeScope } from "../../auth/access.js";
import { db } from "../../db/client.js";
import { drivers, employees, employeeStatus, projects, users, vehicles } from "../../db/schema/index.js";
import { ctx } from "../../http/context.js";
import { badRequest, conflict, forbidden } from "../../http/errors.js";
import { requirePermission } from "../../http/middleware.js";
import { idParam, isoDate, optionalText, paged, pagination, trimmed, uuid } from "../../http/validate.js";
import { audit, diff } from "../../services/audit.js";
import { employeeRowInScope, getEmployeeInScope, maskNationalId } from "./service.js";

export const employeesRouter = Router();

/** Public list columns — deliberately WITHOUT national_id. */
const listColumns = {
  id: employees.id,
  employeeNumber: employees.employeeNumber,
  fullName: employees.fullName,
  phone: employees.phone,
  email: employees.email,
  jobTitle: employees.jobTitle,
  projectId: employees.projectId,
  projectName: projects.name,
  status: employees.status,
  hireDate: employees.hireDate,
  driverId: drivers.id,
  createdAt: employees.createdAt,
};

const EDITABLE_STATUSES = ["ACTIVE", "INACTIVE", "SUSPENDED"] as const;

const ListQuery = pagination.extend({
  q: z.string().trim().max(100).optional(),
  projectId: uuid.optional(),
  status: z.enum(employeeStatus.enumValues).optional(),
});

employeesRouter.get("/", requirePermission("employees.read"), async (req, res) => {
  const { access } = ctx(req);
  const q = ListQuery.parse(req.query);
  const where = [employeeScope(access, "employees.read")];
  if (q.q) {
    const like = `%${q.q}%`;
    // National ID is intentionally NOT searchable here.
    where.push(or(ilike(employees.fullName, like), ilike(employees.employeeNumber, like), ilike(employees.phone, like), ilike(employees.email, like))!);
  }
  if (q.projectId) where.push(eq(employees.projectId, q.projectId));
  if (q.status) where.push(eq(employees.status, q.status));
  else where.push(ne(employees.status, "ARCHIVED"));
  const cond = and(...where);
  const [rows, [count]] = await Promise.all([
    db
      .select(listColumns)
      .from(employees)
      .leftJoin(projects, eq(projects.id, employees.projectId))
      .leftJoin(drivers, eq(drivers.employeeId, employees.id))
      .where(cond)
      .orderBy(asc(employees.fullName))
      .limit(q.pageSize)
      .offset((q.page - 1) * q.pageSize),
    db.select({ n: sql<number>`count(*)::int` }).from(employees).where(cond),
  ]);
  res.json(paged(rows, count?.n ?? 0, q.page, q.pageSize));
});

employeesRouter.get("/:id", requirePermission("employees.read"), async (req, res) => {
  const { access } = ctx(req);
  const { id } = idParam.parse(req.params);
  const e = await getEmployeeInScope(db, access, id, "employees.read");
  const [project] = e.projectId
    ? await db.select({ name: projects.name }).from(projects).where(eq(projects.id, e.projectId))
    : [];
  const [driver] = await db
    .select({ id: drivers.id, licenseExpiryDate: drivers.licenseExpiryDate, status: drivers.status, currentVehiclePlate: vehicles.plateNumber })
    .from(drivers)
    .leftJoin(vehicles, eq(vehicles.assignedDriverId, drivers.id))
    .where(eq(drivers.employeeId, e.id));
  const [linkedUser] = e.userId ? await db.select({ id: users.id, name: users.name, email: users.email }).from(users).where(eq(users.id, e.userId)) : [];
  const canUpdate = employeeRowInScope(access, e, "employees.update") && e.status !== "ARCHIVED";
  res.json({
    data: {
      id: e.id,
      employeeNumber: e.employeeNumber,
      fullName: e.fullName,
      nationalIdOrIqama: maskNationalId(e.nationalId, canUpdate),
      nationalIdMasked: !!e.nationalId && !canUpdate,
      phone: e.phone,
      email: e.email,
      jobTitle: e.jobTitle,
      projectId: e.projectId,
      projectName: project?.name ?? null,
      status: e.status,
      hireDate: e.hireDate,
      notes: e.notes,
      linkedUser: linkedUser ?? null,
      driver: driver ?? null,
      createdAt: e.createdAt,
      updatedAt: e.updatedAt,
      capabilities: {
        update: canUpdate,
        archive: employeeRowInScope(access, e, "employees.archive") && e.status !== "ARCHIVED",
        createDriver: !driver && e.status === "ACTIVE" && employeeRowInScope(access, e, "drivers.create") && access.scopeOf("drivers.create") !== "ASSIGNED",
      },
    },
  });
});

const nationalId = z
  .string()
  .trim()
  .regex(/^[0-9]{10}$/, "رقم الهوية/الإقامة يجب أن يكون 10 أرقام")
  .nullable()
  .optional()
  .or(z.literal("").transform(() => null));

const EmployeeBody = z.object({
  employeeNumber: z.string().trim().min(1).max(30).regex(/^[A-Za-z0-9-]+$/, "رقم الموظف: أحرف إنجليزية وأرقام وشرطة فقط"),
  fullName: trimmed(2, 150),
  nationalIdOrIqama: nationalId,
  phone: z.string().trim().regex(/^\+?[0-9 ]{7,20}$/, "رقم جوال غير صالح").nullable().optional().or(z.literal("").transform(() => null)),
  email: z.string().trim().toLowerCase().email("بريد إلكتروني غير صالح").max(254).nullable().optional().or(z.literal("").transform(() => null)),
  jobTitle: optionalText(100),
  projectId: uuid.nullable().optional(),
  status: z.enum(EDITABLE_STATUSES).optional(),
  hireDate: isoDate.nullable().optional(),
  notes: optionalText(2000),
  /** Link to a login account — admins (users.manage ALL) only. */
  userId: uuid.nullable().optional(),
});

async function assertLinkableUser(orgId: string, userId: string, exceptEmployeeId?: string) {
  const [u] = await db.select({ id: users.id }).from(users).where(and(eq(users.id, userId), eq(users.organizationId, orgId)));
  if (!u) throw badRequest("المستخدم المرتبط غير موجود");
  const [taken] = await db
    .select({ id: employees.id })
    .from(employees)
    .where(and(eq(employees.userId, userId), exceptEmployeeId ? ne(employees.id, exceptEmployeeId) : sql`true`));
  if (taken) throw conflict("هذا المستخدم مرتبط بموظف آخر");
}

employeesRouter.post("/", requirePermission("employees.create"), async (req, res) => {
  const { access } = ctx(req);
  const body = EmployeeBody.parse(req.body);
  if (body.projectId) await assertCanUseProject(db, access, body.projectId, "employees.create");
  else if (access.require("employees.create") !== "ALL") throw forbidden("يجب اختيار مشروع من مشاريعك");
  if (body.userId !== undefined && body.userId !== null) {
    if (access.scopeOf("users.manage") !== "ALL") throw forbidden("ربط حساب مستخدم يتطلب صلاحية إدارة المستخدمين");
    await assertLinkableUser(access.orgId, body.userId);
  }

  const created = await db.transaction(async (tx) => {
    const [e] = await tx
      .insert(employees)
      .values({
        organizationId: access.orgId,
        employeeNumber: body.employeeNumber,
        fullName: body.fullName,
        nationalId: body.nationalIdOrIqama ?? null,
        phone: body.phone ?? null,
        email: body.email ?? null,
        jobTitle: body.jobTitle ?? null,
        projectId: body.projectId ?? null,
        status: body.status ?? "ACTIVE",
        hireDate: body.hireDate ?? null,
        notes: body.notes ?? null,
        userId: body.userId ?? null,
        createdBy: access.userId,
      })
      .returning();
    await audit(tx, req, {
      action: "EMPLOYEE_CREATED",
      entity: "employee",
      entityId: e!.id,
      projectId: e!.projectId,
      metadata: { employeeNumber: e!.employeeNumber, fullName: e!.fullName },
    });
    return e!;
  });
  res.status(201).json({ data: { id: created.id, employeeNumber: created.employeeNumber, fullName: created.fullName, projectId: created.projectId, status: created.status } });
});

const UpdateEmployee = EmployeeBody.partial().strict();

employeesRouter.patch("/:id", requirePermission("employees.update"), async (req, res) => {
  const { access } = ctx(req);
  const { id } = idParam.parse(req.params);
  const before = await getEmployeeInScope(db, access, id, "employees.read");
  if (!employeeRowInScope(access, before, "employees.update")) throw forbidden();
  if (access.scopeOf("employees.update") === "ASSIGNED") throw forbidden();
  if (before.status === "ARCHIVED") throw badRequest("لا يمكن تعديل موظف مؤرشف");
  const patch = UpdateEmployee.parse(req.body);

  if (patch.projectId !== undefined && patch.projectId !== before.projectId) {
    if (patch.projectId === null) {
      if (access.scopeOf("employees.update") !== "ALL") throw forbidden("إزالة الموظف من المشروع تتطلب صلاحية الإدارة");
    } else {
      await assertCanUseProject(db, access, patch.projectId, "employees.update");
    }
    const [holding] = await db
      .select({ plate: vehicles.plateNumber })
      .from(drivers)
      .innerJoin(vehicles, eq(vehicles.assignedDriverId, drivers.id))
      .where(eq(drivers.employeeId, id));
    if (holding) throw conflict(`الموظف سائق للمركبة ${holding.plate}؛ ألغِ إسناد المركبة قبل نقله لمشروع آخر`);
  }
  if (patch.userId !== undefined && patch.userId !== before.userId) {
    if (access.scopeOf("users.manage") !== "ALL") throw forbidden("ربط حساب مستخدم يتطلب صلاحية إدارة المستخدمين");
    if (patch.userId) await assertLinkableUser(access.orgId, patch.userId, id);
  }

  const { nationalIdOrIqama, ...rest } = patch;
  const values = { ...rest, ...(nationalIdOrIqama !== undefined ? { nationalId: nationalIdOrIqama } : {}) };
  const updated = await db.transaction(async (tx) => {
    const [e] = await tx.update(employees).set({ ...values, updatedAt: new Date() }).where(eq(employees.id, id)).returning();
    const changes = diff(before, values);
    if (changes.nationalId) changes.nationalId = { from: "[REDACTED]", to: "[REDACTED]" };
    if (Object.keys(changes).length) {
      await audit(tx, req, { action: "EMPLOYEE_UPDATED", entity: "employee", entityId: id, projectId: e!.projectId, metadata: { changes } });
    }
    return e!;
  });
  res.json({ data: { id: updated.id, status: updated.status, projectId: updated.projectId } });
});

employeesRouter.post("/:id/archive", requirePermission("employees.archive"), async (req, res) => {
  const { access } = ctx(req);
  const { id } = idParam.parse(req.params);
  const e = await getEmployeeInScope(db, access, id, "employees.archive");
  if (e.status === "ARCHIVED") throw badRequest("الموظف مؤرشف مسبقًا");
  const [driver] = await db.select().from(drivers).where(eq(drivers.employeeId, id));
  if (driver) {
    const [holding] = await db.select({ plate: vehicles.plateNumber }).from(vehicles).where(eq(vehicles.assignedDriverId, driver.id));
    if (holding) throw conflict(`الموظف سائق للمركبة ${holding.plate}؛ ألغِ الإسناد أولًا`);
  }
  await db.transaction(async (tx) => {
    await tx.update(employees).set({ status: "ARCHIVED", updatedAt: new Date() }).where(eq(employees.id, id));
    await audit(tx, req, { action: "EMPLOYEE_ARCHIVED", entity: "employee", entityId: id, projectId: e.projectId, metadata: { previousStatus: e.status } });
    if (driver && !driver.archivedAt) {
      await tx.update(drivers).set({ status: "INACTIVE", archivedAt: new Date(), updatedAt: new Date() }).where(and(eq(drivers.id, driver.id), isNull(drivers.archivedAt)));
      await audit(tx, req, { action: "DRIVER_ARCHIVED", entity: "driver", entityId: driver.id, projectId: e.projectId, metadata: { reason: "employee_archived" } });
    }
  });
  res.json({ data: { id, status: "ARCHIVED" } });
});
