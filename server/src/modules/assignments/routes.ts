import { and, desc, eq, isNull, sql } from "drizzle-orm";
import { alias } from "drizzle-orm/pg-core";
import { Router } from "express";
import { z } from "zod";
import { assertCanUseProject, assignmentScope, canOnMaintenance, getVehicleInScope, isAssignedToMaintenance, maintenanceScope, vehicleScope, type Access } from "../../auth/access.js";
import { db, type DbOrTx } from "../../db/client.js";
import {
  accidents,
  insurancePolicies,
  invoices,
  vehicleDocuments,
  violations,
  assignments,
  assignmentStatus,
  maintenanceRequests,
  assignmentType,
  priority,
  projects,
  projectUsers,
  users,
  vehicles,
} from "../../db/schema/index.js";
import { ctx } from "../../http/context.js";
import { badRequest, forbidden, notFound } from "../../http/errors.js";
import { requirePermission } from "../../http/middleware.js";
import { idParam, isoDate, optionalText, paged, pagination, trimmed, uuid } from "../../http/validate.js";
import { audit, diff } from "../../services/audit.js";
import { invoiceScope } from "../finance/invoices.js";
import { accidentScope } from "../operations/accidents.js";
import { violationScope } from "../operations/violations.js";
import { notifyUsers } from "../../services/notifications.js";

export const assignmentsRouter = Router();

/** Every assignment type is backed by a real record the server resolves and scopes. */
const SUPPORTED_TYPES = new Set(assignmentType.enumValues);

const assignee = alias(users, "assignee");
const assigner = alias(users, "assigner");

const columns = {
  id: assignments.id,
  type: assignments.type,
  title: assignments.title,
  description: assignments.description,
  priority: assignments.priority,
  status: assignments.status,
  dueDate: assignments.dueDate,
  referenceId: assignments.referenceId,
  projectId: assignments.projectId,
  projectName: projects.name,
  vehicleId: assignments.vehicleId,
  vehiclePlate: vehicles.plateNumber,
  assignedTo: assignments.assignedTo,
  assignedToName: assignee.name,
  assignedBy: assignments.assignedBy,
  assignedByName: assigner.name,
  createdAt: assignments.createdAt,
  completedAt: assignments.completedAt,
};

function baseQuery() {
  return db
    .select(columns)
    .from(assignments)
    .leftJoin(projects, eq(projects.id, assignments.projectId))
    .leftJoin(vehicles, eq(vehicles.id, assignments.vehicleId))
    .innerJoin(assignee, eq(assignee.id, assignments.assignedTo))
    .innerJoin(assigner, eq(assigner.id, assignments.assignedBy));
}

const ListQuery = pagination.extend({
  status: z.enum(assignmentStatus.enumValues).optional(),
  type: z.enum(assignmentType.enumValues).optional(),
});

/** "إسناداتي" — everything assigned to the caller. No permission needed: strictly self-scoped. */
assignmentsRouter.get("/mine", async (req, res) => {
  const { access } = ctx(req);
  const q = ListQuery.parse(req.query);
  const where = [eq(assignments.assignedTo, access.userId), eq(assignments.organizationId, access.orgId)];
  if (q.status) where.push(eq(assignments.status, q.status));
  if (q.type) where.push(eq(assignments.type, q.type));
  const cond = and(...where);
  const [rows, [count], summary] = await Promise.all([
    baseQuery().where(cond).orderBy(desc(assignments.createdAt)).limit(q.pageSize).offset((q.page - 1) * q.pageSize),
    db.select({ n: sql<number>`count(*)::int` }).from(assignments).where(cond),
    db
      .select({ status: assignments.status, n: sql<number>`count(*)::int` })
      .from(assignments)
      .where(and(eq(assignments.assignedTo, access.userId), eq(assignments.organizationId, access.orgId)))
      .groupBy(assignments.status),
  ]);
  res.json({ ...paged(rows, count?.n ?? 0, q.page, q.pageSize), summary: Object.fromEntries(summary.map((s) => [s.status, s.n])) });
});

/** Assignments the caller may oversee (own + created by them + project scope). */
assignmentsRouter.get("/", async (req, res) => {
  const { access } = ctx(req);
  const q = ListQuery.extend({ projectId: uuid.optional(), assignedTo: uuid.optional() }).parse(req.query);
  const where = [assignmentScope(access)];
  if (q.status) where.push(eq(assignments.status, q.status));
  if (q.type) where.push(eq(assignments.type, q.type));
  if (q.projectId) where.push(eq(assignments.projectId, q.projectId));
  if (q.assignedTo) where.push(eq(assignments.assignedTo, q.assignedTo));
  const cond = and(...where);
  const [rows, [count]] = await Promise.all([
    baseQuery().where(cond).orderBy(desc(assignments.createdAt)).limit(q.pageSize).offset((q.page - 1) * q.pageSize),
    db.select({ n: sql<number>`count(*)::int` }).from(assignments).where(cond),
  ]);
  res.json(paged(rows, count?.n ?? 0, q.page, q.pageSize));
});

const CreateBody = z
  .object({
    type: z.enum(assignmentType.enumValues),
    assignedTo: uuid,
    referenceId: uuid.optional(),
    projectId: uuid.optional(),
    vehicleId: uuid.optional(),
    title: trimmed(2, 200),
    description: optionalText(2000),
    priority: z.enum(priority.enumValues).default("MEDIUM"),
    dueDate: isoDate.nullable().optional(),
  })
  .strict();

async function assertActiveOrgUser(tx: DbOrTx, access: Access, userId: string) {
  const [u] = await tx
    .select({ id: users.id })
    .from(users)
    .where(and(eq(users.id, userId), eq(users.organizationId, access.orgId), eq(users.status, "ACTIVE")))
    .limit(1);
  if (!u) throw badRequest("المستخدم المسند إليه غير موجود أو غير نشط");
}

async function assertProjectMember(tx: DbOrTx, projectId: string, userId: string) {
  const [m] = await tx.execute<{ ok: boolean }>(sql`
    select exists (select 1 from ${projectUsers} where project_id = ${projectId} and user_id = ${userId})
        or exists (select 1 from ${projects} where id = ${projectId} and manager_id = ${userId}) as ok`).then((r) => r.rows);
  if (!m?.ok) throw badRequest("المستخدم المسند إليه ليس عضوًا في المشروع");
}

/**
 * Loads the record behind a typed assignment inside the caller's scope for the
 * record's own read permission (404 otherwise) and returns its project/vehicle.
 */
async function resolveReference(access: Access, type: string, id: string): Promise<{ projectId: string | null; vehicleId: string | null }> {
  const miss = () => notFound("السجل المرتبط غير موجود");
  if (type === "ACCIDENT") {
    if (!access.has("accidents.read")) throw forbidden();
    const [r] = await db.select({ projectId: accidents.projectId, vehicleId: accidents.vehicleId }).from(accidents).where(and(eq(accidents.id, id), accidentScope(access))).limit(1);
    if (!r) throw miss();
    return r;
  }
  if (type === "VIOLATION") {
    if (!access.has("violations.read")) throw forbidden();
    const [r] = await db.select({ projectId: violations.projectId, vehicleId: violations.vehicleId }).from(violations).where(and(eq(violations.id, id), violationScope(access))).limit(1);
    if (!r) throw miss();
    return r;
  }
  if (type === "INVOICE") {
    if (!access.has("invoices.read")) throw forbidden();
    const [r] = await db.select({ projectId: invoices.projectId, vehicleId: invoices.vehicleId }).from(invoices).where(and(eq(invoices.id, id), invoiceScope(access))).limit(1);
    if (!r) throw miss();
    return r;
  }
  if (type === "INSURANCE") {
    if (!access.has("insurance.read")) throw forbidden();
    const [r] = await db.select({ projectId: vehicles.projectId, vehicleId: vehicles.id }).from(insurancePolicies).innerJoin(vehicles, eq(vehicles.id, insurancePolicies.vehicleId)).where(and(eq(insurancePolicies.id, id), vehicleScope(access, "insurance.read"))).limit(1);
    if (!r) throw miss();
    return r;
  }
  // REGISTRATION / DOCUMENT → vehicle documents
  const perm = type === "REGISTRATION" ? "registration.read" : "vehicle_documents.read";
  if (!access.has(perm)) throw forbidden();
  const [r] = await db
    .select({ projectId: vehicles.projectId, vehicleId: vehicles.id, documentType: vehicleDocuments.documentType })
    .from(vehicleDocuments)
    .innerJoin(vehicles, eq(vehicles.id, vehicleDocuments.vehicleId))
    .where(and(eq(vehicleDocuments.id, id), isNull(vehicleDocuments.deletedAt), vehicleScope(access, perm)))
    .limit(1);
  if (!r || (type === "REGISTRATION" && r.documentType !== "REGISTRATION")) throw miss();
  return { projectId: r.projectId, vehicleId: r.vehicleId };
}

assignmentsRouter.post("/", requirePermission("assignments.create"), async (req, res) => {
  const { access } = ctx(req);
  const body = CreateBody.parse(req.body);
  if (!SUPPORTED_TYPES.has(body.type)) throw badRequest("هذا النوع من الإسناد سيتوفر مع الوحدة الخاصة به");
  await assertActiveOrgUser(db, access, body.assignedTo);

  // Server derives project/vehicle linkage; client-provided ids are only lookup keys.
  let projectId: string | null = null;
  let vehicleId: string | null = null;
  let referenceId: string | null = null;
  let notifyScopeProject: string | null = null;

  if (body.type === "PROJECT") {
    if (!body.referenceId) throw badRequest("يجب تحديد المشروع");
    await assertCanUseProject(db, access, body.referenceId, "assignments.create");
    await assertProjectMember(db, body.referenceId, body.assignedTo);
    projectId = referenceId = body.referenceId;
    notifyScopeProject = projectId;
  } else if (body.type === "VEHICLE") {
    const vid = body.referenceId ?? body.vehicleId;
    if (!vid) throw badRequest("يجب تحديد المركبة");
    const vehicle = await getVehicleInScope(db, access, vid, "vehicles.read");
    if (vehicle.status === "ARCHIVED") throw badRequest("لا يمكن الإسناد على مركبة مؤرشفة");
    // The project always comes from the vehicle; a conflicting client value is rejected, never trusted.
    if (body.projectId && body.projectId !== vehicle.projectId) throw badRequest("المشروع لا يطابق مشروع المركبة");
    if (vehicle.projectId) await assertCanUseProject(db, access, vehicle.projectId, "assignments.create");
    else if (access.require("assignments.create") !== "ALL") throw forbidden();
    projectId = vehicle.projectId;
    vehicleId = referenceId = vehicle.id;
  } else if (body.type === "MAINTENANCE_REQUEST") {
    // Extra access path to one request for users whose role ALREADY holds maintenance
    // permissions with ASSIGNED scope. It never grants a permission by itself.
    if (!body.referenceId) throw badRequest("يجب تحديد طلب الصيانة");
    if (!access.has("maintenance.read")) throw forbidden();
    const [mr] = await db.select().from(maintenanceRequests).where(and(eq(maintenanceRequests.id, body.referenceId), maintenanceScope(access, "maintenance.read"))).limit(1);
    if (!mr) throw notFound("طلب الصيانة غير موجود");
    if (!canOnMaintenance(access, "maintenance.assign", mr, await isAssignedToMaintenance(db, access, mr.id), "act")) throw forbidden();
    if (mr.projectId) await assertProjectMember(db, mr.projectId, body.assignedTo);
    projectId = mr.projectId;
    vehicleId = mr.vehicleId;
    referenceId = mr.id;
    notifyScopeProject = projectId;
  } else if (body.type === "ACCIDENT" || body.type === "VIOLATION" || body.type === "INVOICE" || body.type === "REGISTRATION" || body.type === "INSURANCE" || body.type === "DOCUMENT") {
    if (!body.referenceId) throw badRequest("يجب تحديد السجل المرتبط بالإسناد");
    const rec = await resolveReference(access, body.type, body.referenceId);
    if (rec.projectId) {
      await assertCanUseProject(db, access, rec.projectId, "assignments.create");
      await assertProjectMember(db, rec.projectId, body.assignedTo);
    } else if (access.require("assignments.create") !== "ALL") throw forbidden();
    projectId = rec.projectId;
    vehicleId = rec.vehicleId;
    referenceId = body.referenceId;
    notifyScopeProject = projectId;
  } else if (body.type === "TASK") {
    if (!body.projectId) throw badRequest("يجب تحديد المشروع للمهمة");
    await assertCanUseProject(db, access, body.projectId, "assignments.create");
    await assertProjectMember(db, body.projectId, body.assignedTo);
    projectId = body.projectId;
    notifyScopeProject = projectId;
    if (body.vehicleId) {
      const vehicle = await getVehicleInScope(db, access, body.vehicleId, "vehicles.read");
      if (vehicle.projectId !== projectId) throw badRequest("المركبة لا تتبع هذا المشروع");
      vehicleId = vehicle.id;
    }
  }

  const created = await db.transaction(async (tx) => {
    const [a] = await tx
      .insert(assignments)
      .values({
        organizationId: access.orgId,
        type: body.type,
        assignedTo: body.assignedTo,
        assignedBy: access.userId,
        projectId,
        vehicleId,
        referenceId,
        title: body.title,
        description: body.description ?? null,
        priority: body.priority,
        dueDate: body.dueDate ?? null,
      })
      .returning();
    await audit(tx, req, {
      action: "ASSIGNMENT_CREATED",
      entity: "assignment",
      entityId: a!.id,
      projectId,
      vehicleId,
      metadata: { type: a!.type, assignedTo: a!.assignedTo, referenceId },
    });
    if (a!.assignedTo !== access.userId) {
      await notifyUsers(tx, {
        orgId: access.orgId,
        userIds: [a!.assignedTo],
        type: "ASSIGNMENT_CREATED",
        title: `إسناد جديد: ${a!.title}`,
        link: "/my-assignments",
        entityType: "assignment",
        entityId: a!.id,
        projectId: notifyScopeProject,
      });
    }
    return a!;
  });
  res.status(201).json({ data: created });
});

const StatusBody = z.object({ status: z.enum(assignmentStatus.enumValues), note: optionalText(500) }).strict();

const ASSIGNEE_TRANSITIONS: Record<string, string[]> = {
  PENDING: ["IN_PROGRESS", "COMPLETED"],
  IN_PROGRESS: ["COMPLETED"],
};

assignmentsRouter.patch("/:id/status", async (req, res) => {
  const { access } = ctx(req);
  const { id } = idParam.parse(req.params);
  const { status, note } = StatusBody.parse(req.body);
  const [a] = await db.select().from(assignments).where(and(eq(assignments.id, id), assignmentScope(access))).limit(1);
  if (!a) throw notFound("الإسناد غير موجود");
  if (a.status === "COMPLETED" || a.status === "CANCELLED") throw badRequest("لا يمكن تعديل إسناد منتهٍ");

  if (status === "CANCELLED") {
    const manageScope = access.scopeOf("assignments.manage");
    const canManage =
      a.assignedBy === access.userId ||
      manageScope === "ALL" ||
      (manageScope === "PROJECT" && access.isMemberOf(a.projectId));
    if (!canManage) throw forbidden("لا يمكنك إلغاء هذا الإسناد");
  } else {
    if (a.assignedTo !== access.userId) throw forbidden("فقط المسند إليه يمكنه تحديث حالة التنفيذ");
    if (!ASSIGNEE_TRANSITIONS[a.status]?.includes(status)) throw badRequest("انتقال الحالة غير مسموح");
  }

  const updated = await db.transaction(async (tx) => {
    const [u] = await tx
      .update(assignments)
      .set({ status, updatedAt: new Date(), completedAt: status === "COMPLETED" ? new Date() : null })
      .where(and(eq(assignments.id, id), eq(assignments.status, a.status)))
      .returning();
    if (!u) throw badRequest("تم تعديل الإسناد من مستخدم آخر، أعد المحاولة");
    await audit(tx, req, {
      action: "ASSIGNMENT_STATUS_CHANGED",
      entity: "assignment",
      entityId: id,
      projectId: a.projectId,
      metadata: { from: a.status, to: status, note },
    });
    const target = status === "CANCELLED" ? a.assignedTo : a.assignedBy;
    if (target !== access.userId && (status === "COMPLETED" || status === "CANCELLED")) {
      await notifyUsers(tx, {
        orgId: access.orgId,
        userIds: [target],
        type: status === "COMPLETED" ? "ASSIGNMENT_COMPLETED" : "ASSIGNMENT_CANCELLED",
        title: status === "COMPLETED" ? `تم إنجاز الإسناد: ${a.title}` : `تم إلغاء الإسناد: ${a.title}`,
        link: status === "COMPLETED" ? "/assignments" : "/my-assignments",
        entityType: "assignment",
        entityId: id,
      });
    }
    return u;
  });
  res.json({ data: updated });
});

// ---------------------------------------------------------------- edit / delete

/** Who may edit or delete an assignment: its creator, or a manager of its project (scope ALL/PROJECT). */
function canManage(access: Access, a: { assignedBy: string; projectId: string | null }, perm: "assignments.update" | "assignments.delete") {
  const s = access.scopeOf(perm);
  if (!s) return false;
  if (s === "ALL") return true;
  if (a.assignedBy === access.userId) return true;
  return s === "PROJECT" && access.isMemberOf(a.projectId);
}

const PatchBody = z
  .object({
    title: trimmed(2, 200).optional(),
    description: optionalText(2000),
    priority: z.enum(priority.enumValues).optional(),
    dueDate: isoDate.nullable().optional(),
    assignedTo: uuid.optional(),
  })
  .strict();

assignmentsRouter.patch("/:id", requirePermission("assignments.update"), async (req, res) => {
  const { access } = ctx(req);
  const { id } = idParam.parse(req.params);
  const [a] = await db.select().from(assignments).where(and(eq(assignments.id, id), assignmentScope(access))).limit(1);
  if (!a) throw notFound("الإسناد غير موجود");
  if (!canManage(access, a, "assignments.update")) throw forbidden("لا يمكنك تعديل هذا الإسناد");
  if (a.status === "COMPLETED" || a.status === "CANCELLED") throw badRequest("لا يمكن تعديل إسناد منتهٍ");
  const b = PatchBody.parse(req.body);
  if (b.assignedTo && b.assignedTo !== a.assignedTo) {
    await assertActiveOrgUser(db, access, b.assignedTo);
    if (a.projectId) await assertProjectMember(db, a.projectId, b.assignedTo);
  }
  const patch = Object.fromEntries(Object.entries(b).filter(([, v]) => v !== undefined)) as Partial<typeof assignments.$inferSelect>;
  const changes = diff(a as unknown as Record<string, unknown>, patch as Record<string, unknown>);
  if (!Object.keys(changes).length) throw badRequest("لا يوجد تغيير");
  const updated = await db.transaction(async (tx) => {
    const [u] = await tx.update(assignments).set({ ...patch, updatedAt: new Date() }).where(and(eq(assignments.id, id), eq(assignments.status, a.status))).returning();
    if (!u) throw badRequest("تم تعديل الإسناد من مستخدم آخر، أعد المحاولة");
    await audit(tx, req, { action: "ASSIGNMENT_UPDATED", entity: "assignment", entityId: id, projectId: a.projectId, vehicleId: a.vehicleId, metadata: { changes } });
    if (b.assignedTo && b.assignedTo !== a.assignedTo && b.assignedTo !== access.userId) {
      await notifyUsers(tx, { orgId: access.orgId, userIds: [b.assignedTo], type: "ASSIGNMENT_CREATED", title: `إسناد جديد: ${u.title}`, link: "/my-assignments", entityType: "assignment", entityId: id, projectId: a.projectId });
    }
    return u;
  });
  res.json({ data: updated });
});

assignmentsRouter.delete("/:id", requirePermission("assignments.delete"), async (req, res) => {
  const { access } = ctx(req);
  const { id } = idParam.parse(req.params);
  const [a] = await db.select().from(assignments).where(and(eq(assignments.id, id), assignmentScope(access))).limit(1);
  if (!a) throw notFound("الإسناد غير موجود");
  if (!canManage(access, a, "assignments.delete")) throw forbidden("لا يمكنك حذف هذا الإسناد");
  if (a.status === "COMPLETED") throw badRequest("لا يمكن حذف إسناد منجز؛ يبقى ضمن السجل");
  await db.transaction(async (tx) => {
    await tx.delete(assignments).where(eq(assignments.id, id));
    // The full row is preserved in the append-only audit log.
    await audit(tx, req, { action: "ASSIGNMENT_DELETED", entity: "assignment", entityId: id, projectId: a.projectId, vehicleId: a.vehicleId, oldValue: { ...a }, metadata: { type: a.type, title: a.title } });
  });
  res.status(204).end();
});
