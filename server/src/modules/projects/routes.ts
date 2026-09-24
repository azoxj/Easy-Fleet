import { and, asc, desc, eq, ilike, or, sql } from "drizzle-orm";
import { alias } from "drizzle-orm/pg-core";
import { Router } from "express";
import { z } from "zod";
import { getProjectInScope, projectScope, type Access } from "../../auth/access.js";
import { db, type DbOrTx } from "../../db/client.js";
import { projects, projectStatus, projectUsers, users, vehicles } from "../../db/schema/index.js";
import { ctx } from "../../http/context.js";
import { badRequest, forbidden, notFound } from "../../http/errors.js";
import { requirePermission } from "../../http/middleware.js";
import { idParam, isoDate, money, optionalText, paged, pagination, trimmed, uuid } from "../../http/validate.js";
import { audit, diff } from "../../services/audit.js";
import { notifyUsers } from "../../services/notifications.js";

export const projectsRouter = Router();

const manager = alias(users, "manager");

const projectColumns = {
  id: projects.id,
  name: projects.name,
  code: projects.code,
  description: projects.description,
  status: projects.status,
  startDate: projects.startDate,
  endDate: projects.endDate,
  budget: projects.budget,
  managerId: projects.managerId,
  managerName: manager.name,
  createdAt: projects.createdAt,
  updatedAt: projects.updatedAt,
  vehicleCount: sql<number>`(select count(*)::int from ${vehicles} v where v.project_id = ${projects.id} and v.status <> 'ARCHIVED')`,
  memberCount: sql<number>`(select count(*)::int from ${projectUsers} pu where pu.project_id = ${projects.id})`,
};

async function assertActiveOrgUser(db: DbOrTx, orgId: string, userId: string) {
  const [u] = await db
    .select({ id: users.id, name: users.name })
    .from(users)
    .where(and(eq(users.id, userId), eq(users.organizationId, orgId), eq(users.status, "ACTIVE")))
    .limit(1);
  if (!u) throw badRequest("المستخدم المحدد غير موجود أو غير نشط");
  return u;
}

/** Can the caller change this (already in-scope) project with `perm`? ASSIGNED scope never may. */
function assertProjectWrite(access: Access, projectId: string, perm: "projects.update" | "projects.members.manage") {
  const scope = access.require(perm);
  if (scope === "ALL") return scope;
  if (scope === "PROJECT" && access.isMemberOf(projectId)) return scope;
  throw forbidden();
}

const ListQuery = pagination.extend({
  q: z.string().trim().max(100).optional(),
  status: z.enum(projectStatus.enumValues).optional(),
});

projectsRouter.get("/", requirePermission("projects.read"), async (req, res) => {
  const { access } = ctx(req);
  const q = ListQuery.parse(req.query);
  const where = [projectScope(access, "projects.read")];
  if (q.q) where.push(or(ilike(projects.name, `%${q.q}%`), ilike(projects.code, `%${q.q}%`))!);
  if (q.status) where.push(eq(projects.status, q.status));
  const cond = and(...where);
  const [rows, [count]] = await Promise.all([
    db
      .select(projectColumns)
      .from(projects)
      .leftJoin(manager, eq(manager.id, projects.managerId))
      .where(cond)
      .orderBy(desc(projects.createdAt))
      .limit(q.pageSize)
      .offset((q.page - 1) * q.pageSize),
    db.select({ n: sql<number>`count(*)::int` }).from(projects).where(cond),
  ]);
  res.json(paged(rows, count?.n ?? 0, q.page, q.pageSize));
});

projectsRouter.get("/:id", requirePermission("projects.read"), async (req, res) => {
  const { access } = ctx(req);
  const { id } = idParam.parse(req.params);
  const [row] = await db
    .select(projectColumns)
    .from(projects)
    .leftJoin(manager, eq(manager.id, projects.managerId))
    .where(and(eq(projects.id, id), projectScope(access, "projects.read")))
    .limit(1);
  if (!row) throw notFound("المشروع غير موجود");

  const vehicleStats = await db
    .select({ status: vehicles.status, n: sql<number>`count(*)::int` })
    .from(vehicles)
    .where(and(eq(vehicles.projectId, id), eq(vehicles.organizationId, access.orgId)))
    .groupBy(vehicles.status);

  const can = (perm: "projects.update" | "projects.members.manage") => {
    const s = access.scopeOf(perm);
    return s === "ALL" || (s === "PROJECT" && access.isMemberOf(id));
  };
  res.json({
    data: {
      ...row,
      vehicleStats: Object.fromEntries(vehicleStats.map((s) => [s.status, s.n])),
      capabilities: {
        update: can("projects.update"),
        updateSensitive: access.scopeOf("projects.update") === "ALL",
        manageMembers: can("projects.members.manage"),
      },
    },
  });
});

const ProjectBody = z.object({
  name: trimmed(2, 200),
  code: z.string().trim().toUpperCase().regex(/^[A-Z0-9][A-Z0-9-]{1,29}$/, "الرمز يجب أن يكون أحرفًا إنجليزية/أرقامًا (2-30)"),
  description: optionalText(2000),
  managerId: uuid.nullable().optional(),
  status: z.enum(projectStatus.enumValues).optional(),
  startDate: isoDate.nullable().optional(),
  endDate: isoDate.nullable().optional(),
  budget: money.nullable().optional(),
});

function checkDates(b: { startDate?: string | null; endDate?: string | null }) {
  if (b.startDate && b.endDate && b.endDate < b.startDate) throw badRequest("تاريخ النهاية يجب أن يكون بعد تاريخ البداية");
}

projectsRouter.post("/", requirePermission("projects.create"), async (req, res) => {
  const { access } = ctx(req);
  if (access.require("projects.create") !== "ALL") throw forbidden();
  const body = ProjectBody.parse(req.body);
  checkDates(body);
  const mgr = body.managerId ? await assertActiveOrgUser(db, access.orgId, body.managerId) : null;

  const created = await db.transaction(async (tx) => {
    const [p] = await tx
      .insert(projects)
      .values({
        organizationId: access.orgId,
        name: body.name,
        code: body.code,
        description: body.description ?? null,
        managerId: mgr?.id ?? null,
        status: body.status ?? "PLANNED",
        startDate: body.startDate ?? null,
        endDate: body.endDate ?? null,
        budget: body.budget ?? null,
        createdBy: access.userId,
      })
      .returning();
    if (mgr) {
      await tx.insert(projectUsers).values({ projectId: p!.id, userId: mgr.id, addedBy: access.userId }).onConflictDoNothing();
    }
    await audit(tx, req, { action: "PROJECT_CREATED", entity: "project", entityId: p!.id, projectId: p!.id, metadata: { code: p!.code, name: p!.name } });
    if (mgr && mgr.id !== access.userId) {
      await notifyUsers(tx, {
        orgId: access.orgId,
        userIds: [mgr.id],
        type: "PROJECT_MANAGER_ASSIGNED",
        title: `تم تعيينك مديرًا لمشروع ${p!.name}`,
        link: `/projects/${p!.id}`,
        entityType: "project",
        entityId: p!.id,
        projectId: p!.id,
      });
    }
    return p!;
  });
  res.status(201).json({ data: created });
});

const UpdateProject = ProjectBody.partial().strict();
const SENSITIVE_FIELDS = ["code", "budget", "managerId"] as const;

projectsRouter.patch("/:id", requirePermission("projects.update"), async (req, res) => {
  const { access } = ctx(req);
  const { id } = idParam.parse(req.params);
  const before = await getProjectInScope(db, access, id, "projects.read");
  const scope = assertProjectWrite(access, id, "projects.update");
  const patch = UpdateProject.parse(req.body);
  if (scope !== "ALL" && SENSITIVE_FIELDS.some((f) => patch[f] !== undefined)) {
    throw forbidden("تعديل الرمز أو الميزانية أو المدير يتطلب صلاحية الإدارة");
  }
  checkDates({ startDate: patch.startDate ?? before.startDate, endDate: patch.endDate ?? before.endDate });
  const mgr = patch.managerId ? await assertActiveOrgUser(db, access.orgId, patch.managerId) : null;

  const updated = await db.transaction(async (tx) => {
    const [p] = await tx
      .update(projects)
      .set({ ...patch, updatedAt: new Date() })
      .where(and(eq(projects.id, id), eq(projects.organizationId, access.orgId)))
      .returning();
    if (mgr) {
      await tx.insert(projectUsers).values({ projectId: id, userId: mgr.id, addedBy: access.userId }).onConflictDoNothing();
    }
    const changes = diff(before, patch);
    if (Object.keys(changes).length) {
      await audit(tx, req, { action: "PROJECT_UPDATED", entity: "project", entityId: id, projectId: id, metadata: { changes } });
    }
    if (mgr && mgr.id !== before.managerId && mgr.id !== access.userId) {
      await notifyUsers(tx, {
        orgId: access.orgId,
        userIds: [mgr.id],
        type: "PROJECT_MANAGER_ASSIGNED",
        title: `تم تعيينك مديرًا لمشروع ${p!.name}`,
        link: `/projects/${id}`,
        entityType: "project",
        entityId: id,
        projectId: id,
      });
    }
    return p!;
  });
  res.json({ data: updated });
});

// ---------------------------------------------------------------- members

projectsRouter.get("/:id/members", requirePermission("projects.read"), async (req, res) => {
  const { access } = ctx(req);
  const { id } = idParam.parse(req.params);
  const project = await getProjectInScope(db, access, id, "projects.read");
  const rows = await db
    .select({ id: users.id, name: users.name, email: users.email, status: users.status, addedAt: projectUsers.addedAt })
    .from(projectUsers)
    .innerJoin(users, eq(users.id, projectUsers.userId))
    .where(and(eq(projectUsers.projectId, id), eq(users.organizationId, access.orgId)))
    .orderBy(asc(users.name));
  res.json({ data: rows.map((r) => ({ ...r, isManager: r.id === project.managerId })) });
});

const AddMember = z.object({ userId: uuid }).strict();

projectsRouter.post("/:id/members", requirePermission("projects.members.manage"), async (req, res) => {
  const { access } = ctx(req);
  const { id } = idParam.parse(req.params);
  const project = await getProjectInScope(db, access, id, "projects.read");
  assertProjectWrite(access, id, "projects.members.manage");
  const { userId } = AddMember.parse(req.body);
  const member = await assertActiveOrgUser(db, access.orgId, userId);

  await db.transaction(async (tx) => {
    const inserted = await tx
      .insert(projectUsers)
      .values({ projectId: id, userId: member.id, addedBy: access.userId })
      .onConflictDoNothing()
      .returning({ userId: projectUsers.userId });
    if (inserted.length === 0) throw badRequest("المستخدم عضو في المشروع مسبقًا");
    await audit(tx, req, { action: "PROJECT_MEMBER_ADDED", entity: "project", entityId: id, projectId: id, metadata: { userId: member.id } });
    await notifyUsers(tx, {
      orgId: access.orgId,
      userIds: [member.id],
      type: "PROJECT_MEMBER_ADDED",
      title: `تمت إضافتك إلى مشروع ${project.name}`,
      link: `/projects/${id}`,
      entityType: "project",
      entityId: id,
      projectId: id,
    });
  });
  res.status(201).json({ data: { projectId: id, userId: member.id } });
});

projectsRouter.delete("/:id/members/:userId", requirePermission("projects.members.manage"), async (req, res) => {
  const { access } = ctx(req);
  const { id, userId } = z.object({ id: uuid, userId: uuid }).parse(req.params);
  const project = await getProjectInScope(db, access, id, "projects.read");
  assertProjectWrite(access, id, "projects.members.manage");
  if (project.managerId === userId) throw badRequest("لا يمكن إزالة مدير المشروع، غيّر المدير أولًا");

  await db.transaction(async (tx) => {
    const removed = await tx
      .delete(projectUsers)
      .where(and(eq(projectUsers.projectId, id), eq(projectUsers.userId, userId)))
      .returning({ userId: projectUsers.userId });
    if (removed.length === 0) throw notFound("المستخدم ليس عضوًا في المشروع");
    await audit(tx, req, { action: "PROJECT_MEMBER_REMOVED", entity: "project", entityId: id, projectId: id, metadata: { userId } });
  });
  res.status(204).end();
});
