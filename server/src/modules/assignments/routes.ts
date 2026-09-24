import { and, desc, eq, sql } from "drizzle-orm";
import { alias } from "drizzle-orm/pg-core";
import { Router } from "express";
import { z } from "zod";
import { assertCanUseProject, assignmentScope, getVehicleInScope, type Access } from "../../auth/access.js";
import { db, type DbOrTx } from "../../db/client.js";
import {
  assignments,
  assignmentStatus,
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
import { audit } from "../../services/audit.js";
import { notifyUsers } from "../../services/notifications.js";

export const assignmentsRouter = Router();

/** Types that can be created in Sprint 1; the rest arrive with their modules. */
const SUPPORTED_TYPES = new Set(["PROJECT", "VEHICLE", "TASK"]);

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
