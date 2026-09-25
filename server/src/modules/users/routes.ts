import { and, asc, eq, ilike, or, sql, type SQL } from "drizzle-orm";
import { Router } from "express";
import { z } from "zod";
import type { Access } from "../../auth/access.js";
import { generateTemporaryPassword, hashPassword, passwordPolicyError } from "../../auth/password.js";
import { revokeAllUserSessions } from "../../auth/session.js";
import { db } from "../../db/client.js";
import { assignments, projectUsers, projects, roles, userRoles, users } from "../../db/schema/index.js";
import { ctx } from "../../http/context.js";
import { badRequest, forbidden, notFound } from "../../http/errors.js";
import { requireAnyPermission, requirePermission } from "../../http/middleware.js";
import { idParam, optionalText, paged, pagination, trimmed } from "../../http/validate.js";
import { audit, diff } from "../../services/audit.js";
import { isLastActiveSuperAdmin, resolveGrantableRoles, rolesForUsers } from "./service.js";

export const usersRouter = Router();

const publicUser = {
  id: users.id,
  name: users.name,
  email: users.email,
  phone: users.phone,
  status: users.status,
  mustChangePassword: users.mustChangePassword,
  lastLoginAt: users.lastLoginAt,
  createdAt: users.createdAt,
};

/** Users visible under users.read: ALL = whole org; PROJECT = co-members of my projects. */
function userScope(access: Access): SQL {
  const scope = access.require("users.read");
  const org = eq(users.organizationId, access.orgId);
  if (scope === "ALL") return org;
  if (scope === "PROJECT" && access.memberProjectIds.length) {
    return and(
      org,
      or(
        eq(users.id, access.userId),
        sql`exists (select 1 from ${projectUsers} pu where pu.user_id = ${users.id} and pu.project_id in ${access.memberProjectIds})`,
        sql`exists (select 1 from ${projects} p where p.manager_id = ${users.id} and p.id in ${access.memberProjectIds})`,
      ),
    )!;
  }
  return and(org, eq(users.id, access.userId))!;
}

/** User administration is org-wide: one of `perms` must be held with ALL scope. users.manage implies every alias. */
function requireManageAll(access: Access, alias?: "users.create" | "users.update" | "users.delete") {
  const ok = [access.scopeOf("users.manage"), alias ? access.scopeOf(alias) : null].includes("ALL");
  if (!ok) throw forbidden();
}

const ListQuery = pagination.extend({
  q: z.string().trim().max(100).optional(),
  status: z.enum(["ACTIVE", "DISABLED"]).optional(),
  role: z.string().trim().max(50).optional(),
});

usersRouter.get("/", requirePermission("users.read"), async (req, res) => {
  const { access } = ctx(req);
  const q = ListQuery.parse(req.query);
  const where = [userScope(access)];
  if (q.q) where.push(or(ilike(users.name, `%${q.q}%`), ilike(users.email, `%${q.q}%`))!);
  if (q.status) where.push(eq(users.status, q.status));
  if (q.role) {
    where.push(
      sql`exists (select 1 from ${userRoles} ur join ${roles} r on r.id = ur.role_id where ur.user_id = ${users.id} and r.key = ${q.role})`,
    );
  }
  const cond = and(...where);
  const [rows, [count]] = await Promise.all([
    db.select(publicUser).from(users).where(cond).orderBy(asc(users.name)).limit(q.pageSize).offset((q.page - 1) * q.pageSize),
    db.select({ n: sql<number>`count(*)::int` }).from(users).where(cond),
  ]);
  const roleMap = await rolesForUsers(db, rows.map((r) => r.id));
  res.json(paged(rows.map((r) => ({ ...r, roles: roleMap.get(r.id) ?? [] })), count?.n ?? 0, q.page, q.pageSize));
});

usersRouter.get("/:id", requirePermission("users.read"), async (req, res) => {
  const { access } = ctx(req);
  const { id } = idParam.parse(req.params);
  const [row] = await db.select(publicUser).from(users).where(and(eq(users.id, id), userScope(access))).limit(1);
  if (!row) throw notFound("المستخدم غير موجود");
  const roleMap = await rolesForUsers(db, [row.id]);
  const memberships = await db
    .select({ id: projects.id, name: projects.name, code: projects.code })
    .from(projectUsers)
    .innerJoin(projects, eq(projects.id, projectUsers.projectId))
    .where(and(eq(projectUsers.userId, id), eq(projects.organizationId, access.orgId)));
  res.json({ data: { ...row, roles: roleMap.get(row.id) ?? [], projects: memberships } });
});

const CreateUser = z.object({
  name: trimmed(2, 120),
  email: z.string().trim().toLowerCase().email().max(254),
  phone: optionalText(30),
  roleKeys: z.array(z.string().max(50)).min(1).max(10),
  /** Optional initial password; when omitted a temporary one is generated. */
  password: z.string().max(256).optional(),
});

usersRouter.post("/", requireAnyPermission("users.manage", "users.create"), async (req, res) => {
  const { access } = ctx(req);
  requireManageAll(access, "users.create");
  const body = CreateUser.parse(req.body);
  const roleRows = await resolveGrantableRoles(db, access, body.roleKeys);

  const generated = !body.password;
  const password = body.password ?? generateTemporaryPassword();
  const policy = passwordPolicyError(password);
  if (policy) throw badRequest(policy);
  const passwordHash = await hashPassword(password);

  const created = await db.transaction(async (tx) => {
    const [u] = await tx
      .insert(users)
      .values({
        organizationId: access.orgId,
        name: body.name,
        email: body.email,
        phone: body.phone ?? null,
        passwordHash,
        mustChangePassword: true,
        createdBy: access.userId,
      })
      .returning(publicUser);
    await tx.insert(userRoles).values(roleRows.map((r) => ({ userId: u!.id, roleId: r.id, assignedBy: access.userId })));
    await audit(tx, req, {
      action: "USER_CREATED",
      entity: "user",
      entityId: u!.id,
      metadata: { email: u!.email, roles: roleRows.map((r) => r.key) },
    });
    return u!;
  });

  res.status(201).json({
    data: { ...created, roles: roleRows.map((r) => ({ key: r.key })) },
    // Returned exactly once so the admin can hand it over; never stored in plain text.
    ...(generated ? { temporaryPassword: password } : {}),
  });
});

const UpdateUser = z
  .object({
    name: trimmed(2, 120).optional(),
    phone: optionalText(30),
    status: z.enum(["ACTIVE", "DISABLED"]).optional(),
  })
  .strict();

usersRouter.patch("/:id", requireAnyPermission("users.manage", "users.update"), async (req, res) => {
  const { access } = ctx(req);
  requireManageAll(access, "users.update");
  const { id } = idParam.parse(req.params);
  const patch = UpdateUser.parse(req.body);

  const [before] = await db.select().from(users).where(and(eq(users.id, id), eq(users.organizationId, access.orgId))).limit(1);
  if (!before) throw notFound("المستخدم غير موجود");
  if (patch.status === "DISABLED" && id === access.userId) throw badRequest("لا يمكنك تعطيل حسابك");
  if (patch.status === "DISABLED" && before.status === "ACTIVE" && (await isLastActiveSuperAdmin(db, access.orgId, id))) {
    const r = await rolesForUsers(db, [id]);
    if (r.get(id)?.some((x) => x.key === "SUPER_ADMIN")) throw badRequest("لا يمكن تعطيل آخر مدير نظام نشط");
  }

  const updated = await db.transaction(async (tx) => {
    const [u] = await tx
      .update(users)
      .set({ ...patch, updatedAt: new Date() })
      .where(eq(users.id, id))
      .returning(publicUser);
    const changes = diff(before, patch);
    if (patch.status && patch.status !== before.status) {
      if (patch.status === "DISABLED") await revokeAllUserSessions(tx, id);
      await audit(tx, req, { action: patch.status === "DISABLED" ? "USER_DISABLED" : "USER_ENABLED", entity: "user", entityId: id });
    }
    if (Object.keys(changes).length) {
      await audit(tx, req, { action: "USER_UPDATED", entity: "user", entityId: id, metadata: { changes } });
    }
    return u!;
  });
  res.json({ data: updated });
});

const SetRoles = z.object({ roleKeys: z.array(z.string().max(50)).min(1).max(10) }).strict();

usersRouter.put("/:id/roles", requireAnyPermission("users.manage", "users.update"), async (req, res) => {
  const { access } = ctx(req);
  requireManageAll(access, "users.update");
  const { id } = idParam.parse(req.params);
  const { roleKeys } = SetRoles.parse(req.body);
  if (id === access.userId) throw badRequest("لا يمكنك تعديل أدوارك بنفسك");

  const [target] = await db.select({ id: users.id }).from(users).where(and(eq(users.id, id), eq(users.organizationId, access.orgId))).limit(1);
  if (!target) throw notFound("المستخدم غير موجود");
  const roleRows = await resolveGrantableRoles(db, access, roleKeys);
  const beforeRoles = (await rolesForUsers(db, [id])).get(id) ?? [];

  // The target's current roles must also be within the caller's authority (cannot strip a higher role).
  if (beforeRoles.length) await resolveGrantableRoles(db, access, beforeRoles.map((r) => r.key));
  if (beforeRoles.some((r) => r.key === "SUPER_ADMIN") && !roleKeys.includes("SUPER_ADMIN") && (await isLastActiveSuperAdmin(db, access.orgId, id))) {
    throw badRequest("لا يمكن إزالة دور آخر مدير نظام نشط");
  }

  await db.transaction(async (tx) => {
    await tx.delete(userRoles).where(eq(userRoles.userId, id));
    await tx.insert(userRoles).values(roleRows.map((r) => ({ userId: id, roleId: r.id, assignedBy: access.userId })));
    await audit(tx, req, {
      action: "USER_ROLES_CHANGED",
      entity: "user",
      entityId: id,
      metadata: { from: beforeRoles.map((r) => r.key), to: roleRows.map((r) => r.key) },
    });
  });
  res.json({ data: { roles: roleRows.map((r) => r.key) } });
});

usersRouter.post("/:id/reset-password", requireAnyPermission("users.manage", "users.update"), async (req, res) => {
  const { access } = ctx(req);
  requireManageAll(access, "users.update");
  const { id } = idParam.parse(req.params);
  if (id === access.userId) throw badRequest("استخدم صفحة تغيير كلمة المرور لحسابك");
  const [target] = await db.select({ id: users.id }).from(users).where(and(eq(users.id, id), eq(users.organizationId, access.orgId))).limit(1);
  if (!target) throw notFound("المستخدم غير موجود");
  const beforeRoles = (await rolesForUsers(db, [id])).get(id) ?? [];
  if (beforeRoles.length) await resolveGrantableRoles(db, access, beforeRoles.map((r) => r.key));

  const temporaryPassword = generateTemporaryPassword();
  const passwordHash = await hashPassword(temporaryPassword);
  await db.transaction(async (tx) => {
    await tx.update(users).set({ passwordHash, mustChangePassword: true, updatedAt: new Date() }).where(eq(users.id, id));
    await revokeAllUserSessions(tx, id);
    await audit(tx, req, { action: "USER_PASSWORD_RESET", entity: "user", entityId: id });
  });
  res.json({ data: { temporaryPassword } });
});

/** Lightweight picker for forms (active users only), still scope-filtered. */
usersRouter.get("/lookup/active", requirePermission("users.read"), async (req, res) => {
  const { access } = ctx(req);
  const q = z.object({ projectId: z.uuid().optional() }).parse(req.query);
  const where = [userScope(access), eq(users.status, "ACTIVE")];
  if (q.projectId) {
    where.push(
      or(
        sql`exists (select 1 from ${projectUsers} pu where pu.user_id = ${users.id} and pu.project_id = ${q.projectId})`,
        sql`exists (select 1 from ${projects} p where p.manager_id = ${users.id} and p.id = ${q.projectId})`,
      )!,
    );
  }
  const rows = await db.select({ id: users.id, name: users.name, email: users.email }).from(users).where(and(...where)).orderBy(asc(users.name)).limit(500);
  const roleMap = await rolesForUsers(db, rows.map((r) => r.id));
  res.json({ data: rows.map((r) => ({ ...r, roles: (roleMap.get(r.id) ?? []).map((x) => x.key) })) });
});


/**
 * "Delete" = permanent deactivation. Users are referenced by audit logs,
 * approvals and financial records, so the row is kept (status DISABLED),
 * all sessions are revoked, memberships removed and open assignments cancelled.
 */
usersRouter.delete("/:id", requireAnyPermission("users.manage", "users.delete"), async (req, res) => {
  const { access } = ctx(req);
  requireManageAll(access, "users.delete");
  const { id } = idParam.parse(req.params);
  if (id === access.userId) throw badRequest("لا يمكنك حذف حسابك");
  const [before] = await db.select().from(users).where(and(eq(users.id, id), eq(users.organizationId, access.orgId))).limit(1);
  if (!before) throw notFound("المستخدم غير موجود");
  const r = await rolesForUsers(db, [id]);
  if (r.get(id)?.some((x) => x.key === "SUPER_ADMIN") && (await isLastActiveSuperAdmin(db, access.orgId, id))) throw badRequest("لا يمكن حذف آخر مدير نظام نشط");
  const [managed] = await db.select({ n: sql<number>`count(*)::int` }).from(projects).where(and(eq(projects.managerId, id), sql`${projects.status} <> 'ARCHIVED'`));
  if ((managed?.n ?? 0) > 0) throw badRequest("المستخدم مدير لمشروع نشط؛ غيّر مدير المشروع أولًا");
  await db.transaction(async (tx) => {
    await tx.update(users).set({ status: "DISABLED", updatedAt: new Date() }).where(eq(users.id, id));
    await revokeAllUserSessions(tx, id);
    const removed = await tx.delete(projectUsers).where(eq(projectUsers.userId, id)).returning({ projectId: projectUsers.projectId });
    const cancelled = await tx
      .update(assignments)
      .set({ status: "CANCELLED", updatedAt: new Date() })
      .where(and(eq(assignments.assignedTo, id), sql`${assignments.status} in ('PENDING','IN_PROGRESS')`))
      .returning({ id: assignments.id });
    await audit(tx, req, { action: "USER_DELETED", entity: "user", entityId: id, oldValue: { status: before.status, email: before.email }, newValue: { status: "DISABLED" }, metadata: { removedFromProjects: removed.length, cancelledAssignments: cancelled.length } });
  });
  res.status(204).end();
});
