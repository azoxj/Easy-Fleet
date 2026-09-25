import { and, asc, desc, eq, ilike, or, sql } from "drizzle-orm";
import { alias } from "drizzle-orm/pg-core";
import { Router } from "express";
import { z } from "zod";
import { getProjectInScope, projectScope, type Access } from "../../auth/access.js";
import { db, type DbOrTx } from "../../db/client.js";
import { projects, projectStatus, projectUsers, users, vehicles } from "../../db/schema/index.js";
import { ctx } from "../../http/context.js";
import { badRequest, forbidden, HttpError, notFound } from "../../http/errors.js";
import { requireAnyPermission, requirePermission } from "../../http/middleware.js";
import type { PermissionKey } from "../../auth/permissions.js";
import { config } from "../../config.js";
import { today } from "../../lib/clock.js";
import { costsCte, costsScope } from "../finance/costs.js";
import { monthStart } from "../finance/summary.js";
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
  contractValue: projects.contractValue,
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
function assertProjectWrite(access: Access, projectId: string, perm: PermissionKey | PermissionKey[]) {
  const perms = Array.isArray(perm) ? perm : [perm];
  const held = perms.map((p) => access.scopeOf(p)).filter((x): x is NonNullable<typeof x> => !!x);
  if (!held.length) throw forbidden();
  const scope = held.includes("ALL") ? "ALL" : held.includes("PROJECT") ? "PROJECT" : "ASSIGNED";
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

  const can = (perm: PermissionKey) => {
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
        manageMembers: can("projects.members.manage") || can("members.create"),
        removeMembers: can("projects.members.manage") || can("members.delete"),
        archive: can("projects.delete"),
        financials: access.has("finance.read"),
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
  contractValue: money.nullable().optional(),
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
        contractValue: body.contractValue ?? null,
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
const SENSITIVE_FIELDS = ["code", "budget", "managerId", "contractValue"] as const;

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

projectsRouter.get("/:id/members", requireAnyPermission("projects.read", "members.read"), async (req, res) => {
  const { access } = ctx(req);
  const { id } = idParam.parse(req.params);
  const project = await getProjectInScope(db, access, id, access.has("members.read") ? "members.read" : "projects.read");
  const rows = await db
    .select({ id: users.id, name: users.name, email: users.email, status: users.status, addedAt: projectUsers.addedAt })
    .from(projectUsers)
    .innerJoin(users, eq(users.id, projectUsers.userId))
    .where(and(eq(projectUsers.projectId, id), eq(users.organizationId, access.orgId)))
    .orderBy(asc(users.name));
  res.json({ data: rows.map((r) => ({ ...r, isManager: r.id === project.managerId })) });
});

const AddMember = z.object({ userId: uuid }).strict();

projectsRouter.post("/:id/members", requireAnyPermission("projects.members.manage", "members.create"), async (req, res) => {
  const { access } = ctx(req);
  const { id } = idParam.parse(req.params);
  const project = await getProjectInScope(db, access, id, "projects.read");
  assertProjectWrite(access, id, ["projects.members.manage", "members.create"]);
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

projectsRouter.delete("/:id/members/:userId", requireAnyPermission("projects.members.manage", "members.delete"), async (req, res) => {
  const { access } = ctx(req);
  const { id, userId } = z.object({ id: uuid, userId: uuid }).parse(req.params);
  const project = await getProjectInScope(db, access, id, "projects.read");
  assertProjectWrite(access, id, ["projects.members.manage", "members.delete"]);
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

// ---------------------------------------------------------------- archive ("delete")

/**
 * Projects are never hard-deleted (vehicles, costs and the audit trail reference
 * them). DELETE archives the project, and only when nothing active depends on it.
 */
projectsRouter.delete("/:id", requirePermission("projects.delete"), async (req, res) => {
  const { access } = ctx(req);
  const { id } = idParam.parse(req.params);
  const before = await getProjectInScope(db, access, id, "projects.read");
  assertProjectWrite(access, id, "projects.delete");
  if (before.status === "ARCHIVED") throw badRequest("المشروع مؤرشف مسبقًا");
  const [deps] = await db.execute<{ vehicles: number; maintenance: number; invoices: number }>(sql`
    select (select count(*)::int from vehicles where project_id = ${id} and status not in ('ARCHIVED','SOLD')) as vehicles,
           (select count(*)::int from maintenance_requests where project_id = ${id} and status not in ('CLOSED','REJECTED')) as maintenance,
           (select count(*)::int from invoices where project_id = ${id} and status in ('SUBMITTED','UNDER_REVIEW','APPROVED','TRANSFER_PENDING')) as invoices`).then((r) => r.rows);
  if (deps && (deps.vehicles || deps.maintenance || deps.invoices)) {
    throw new HttpError(409, "HAS_DEPENDENCIES", `لا يمكن أرشفة المشروع: ${deps.vehicles} مركبة نشطة، ${deps.maintenance} طلب صيانة مفتوح، ${deps.invoices} فاتورة قيد المعالجة`, deps);
  }
  const updated = await db.transaction(async (tx) => {
    const [p] = await tx.update(projects).set({ status: "ARCHIVED", updatedAt: new Date() }).where(eq(projects.id, id)).returning();
    await audit(tx, req, { action: "PROJECT_ARCHIVED", entity: "project", entityId: id, projectId: id, metadata: { changes: { status: { from: before.status, to: "ARCHIVED" } } } });
    return p!;
  });
  res.json({ data: updated });
});

// ---------------------------------------------------------------- project dashboard

/** Operational overview of one project (every number comes from the database). */
projectsRouter.get("/:id/dashboard", requirePermission("projects.read"), async (req, res) => {
  const { access } = ctx(req);
  const { id } = idParam.parse(req.params);
  const project = await getProjectInScope(db, access, id, "projects.read");
  const t = today();
  const [counts] = await db.execute<Record<string, number>>(sql`
    select
      (select count(*)::int from vehicles where project_id = ${id} and status <> 'ARCHIVED') as vehicles,
      (select count(*)::int from employees where project_id = ${id} and status <> 'ARCHIVED') as employees,
      (select count(*)::int from drivers d join employees e on e.id = d.employee_id where e.project_id = ${id} and d.archived_at is null) as drivers,
      (select count(*)::int from project_users where project_id = ${id}) as members,
      (select count(*)::int from maintenance_requests where project_id = ${id} and status not in ('CLOSED','REJECTED')) as "openMaintenance",
      (select count(*)::int from accidents where project_id = ${id} and status <> 'CLOSED') as "openAccidents",
      (select count(*)::int from violations where project_id = ${id} and status in ('OPEN','DISPUTED')) as "openViolations",
      (select count(*)::int from handover_sessions where project_id = ${id} and status in ('PENDING_HANDOVER','RETURN_PENDING')) as "activeHandovers",
      (select count(*)::int from vehicle_documents vd join vehicles v on v.id = vd.vehicle_id
         where v.project_id = ${id} and vd.deleted_at is null and vd.superseded_at is null and vd.expiry_date is not null and vd.expiry_date <= ${t}::date + 30) as "expiringDocuments",
      (select count(*)::int from insurance_policies ip join vehicles v on v.id = ip.vehicle_id
         where v.project_id = ${id} and ip.superseded_at is null and ip.expiry_date <= ${t}::date + 30) as "expiringInsurance"`).then((r) => r.rows);
  const vehicleStats = await db.select({ status: vehicles.status, n: sql<number>`count(*)::int` }).from(vehicles).where(eq(vehicles.projectId, id)).groupBy(vehicles.status);
  let costs = null;
  if (access.has("finance.read")) {
    const scope = costsScope(access);
    const cte = costsCte(access.orgId, config.APP_TIMEZONE);
    const m0 = monthStart(t);
    const from6 = monthStart(t, -5);
    const m1 = monthStart(t, 1);
    const series = await db.execute<{ month: string; total: string }>(sql`with ${cte}
      select to_char(date_trunc('month', day), 'YYYY-MM') as month, sum(amount)::numeric(16,2)::text as total
        from costs where project_id = ${id} and ${scope} and day >= ${from6}::date and day < ${m1}::date group by 1 order by 1`);
    const month = await db.execute<{ category: string; total: string }>(sql`with ${cte}
      select category, sum(amount)::numeric(16,2)::text as total from costs where project_id = ${id} and ${scope} and day >= ${m0}::date and day < ${m1}::date group by 1`);
    costs = { series: series.rows, month: Object.fromEntries(month.rows.map((r) => [r.category, r.total])) };
  }
  const recent = await db.execute<{ action: string; entity: string; created_at: string; user_name: string | null }>(sql`
    select a.action, a.entity, a.created_at, u.name as user_name from audit_logs a left join users u on u.id = a.user_id
     where a.organization_id = ${access.orgId} and a.project_id = ${id} and a.action not in ('FILE_DOWNLOADED')
     order by a.created_at desc limit 10`);
  res.json({
    data: {
      project: { id: project.id, name: project.name, code: project.code, status: project.status, budget: project.budget, contractValue: project.contractValue },
      counts,
      vehicleStats: Object.fromEntries(vehicleStats.map((s) => [s.status, s.n])),
      costs,
      recent: recent.rows.map((r) => ({ action: r.action, entity: r.entity, createdAt: r.created_at, userName: r.user_name })),
    },
  });
});
