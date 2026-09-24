import { and, desc, eq, isNotNull, isNull, sql } from "drizzle-orm";
import { Router } from "express";
import { z } from "zod";
import { db } from "../../db/client.js";
import { notificationCategory, notificationPreferences, notifications, projectUsers, projects, users } from "../../db/schema/index.js";
import { ctx } from "../../http/context.js";
import { badRequest, forbidden, notFound } from "../../http/errors.js";
import { requirePermission } from "../../http/middleware.js";
import { audit } from "../../services/audit.js";
import { notifyUsers } from "../../services/notifications.js";
import { idParam, optionalText, paged, pagination, trimmed, uuid } from "../../http/validate.js";

/** Every query here is pinned to the session's user id — no cross-user access is possible. */
export const notificationsRouter = Router();

const mine = (userId: string, orgId: string) => and(eq(notifications.userId, userId), eq(notifications.organizationId, orgId));

notificationsRouter.use(requirePermission("notifications.read"));

notificationsRouter.get("/", async (req, res) => {
  const { access } = ctx(req);
  const q = pagination
    .extend({
      unreadOnly: z.enum(["true", "false"]).optional(),
      state: z.enum(["unread", "read"]).optional(),
      category: z.enum(notificationCategory.enumValues).optional(),
    })
    .parse(req.query);
  const cond = and(
    mine(access.userId, access.orgId),
    q.unreadOnly === "true" || q.state === "unread" ? isNull(notifications.readAt) : q.state === "read" ? isNotNull(notifications.readAt) : undefined,
    q.category ? eq(notifications.category, q.category) : undefined,
  );
  const [rows, [count]] = await Promise.all([
    db
      .select({
        id: notifications.id,
        type: notifications.type,
        category: notifications.category,
        title: notifications.title,
        body: notifications.body,
        link: notifications.link,
        readAt: notifications.readAt,
        createdAt: notifications.createdAt,
      })
      .from(notifications)
      .where(cond)
      .orderBy(desc(notifications.createdAt))
      .limit(q.pageSize)
      .offset((q.page - 1) * q.pageSize),
    db.select({ n: sql<number>`count(*)::int` }).from(notifications).where(cond),
  ]);
  res.json(paged(rows, count?.n ?? 0, q.page, q.pageSize));
});

notificationsRouter.get("/unread-count", async (req, res) => {
  const { access } = ctx(req);
  const [row] = await db
    .select({ n: sql<number>`count(*)::int` })
    .from(notifications)
    .where(and(mine(access.userId, access.orgId), isNull(notifications.readAt)));
  res.json({ data: { count: row?.n ?? 0 } });
});

notificationsRouter.post("/read-all", async (req, res) => {
  const { access } = ctx(req);
  await db
    .update(notifications)
    .set({ readAt: new Date() })
    .where(and(mine(access.userId, access.orgId), isNull(notifications.readAt)));
  res.status(204).end();
});

notificationsRouter.post("/:id/read", async (req, res) => {
  const { access } = ctx(req);
  const { id } = idParam.parse(req.params);
  const updated = await db
    .update(notifications)
    .set({ readAt: sql`coalesce(${notifications.readAt}, now())` })
    .where(and(eq(notifications.id, id), mine(access.userId, access.orgId)))
    .returning({ id: notifications.id });
  if (updated.length === 0) throw notFound("الإشعار غير موجود");
  res.status(204).end();
});

// ---------------------------------------------------------------- preferences (own only)

const CATEGORIES = notificationCategory.enumValues;

notificationsRouter.get("/preferences", async (req, res) => {
  const { access } = ctx(req);
  const rows = await db.select().from(notificationPreferences).where(eq(notificationPreferences.userId, access.userId));
  const map = Object.fromEntries(rows.map((r) => [r.category, r.enabled]));
  res.json({ data: CATEGORIES.map((c) => ({ category: c, enabled: c === "SYSTEM" ? true : (map[c] ?? true), locked: c === "SYSTEM" })) });
});

const PrefsBody = z.object({ preferences: z.array(z.object({ category: z.enum(CATEGORIES), enabled: z.boolean() }).strict()).max(20) }).strict();

notificationsRouter.put("/preferences", async (req, res) => {
  const { access } = ctx(req);
  const { preferences } = PrefsBody.parse(req.body);
  for (const p of preferences) {
    if (p.category === "SYSTEM") continue; // cannot be disabled
    await db
      .insert(notificationPreferences)
      .values({ userId: access.userId, category: p.category, enabled: p.enabled })
      .onConflictDoUpdate({ target: [notificationPreferences.userId, notificationPreferences.category], set: { enabled: p.enabled, updatedAt: new Date() } });
  }
  res.status(204).end();
});

// ---------------------------------------------------------------- broadcast (notifications.manage)

const BroadcastBody = z
  .object({
    title: trimmed(3, 200),
    body: optionalText(1000),
    projectId: uuid.optional(),
  })
  .strict();

notificationsRouter.post("/broadcast", requirePermission("notifications.manage"), async (req, res) => {
  const { access } = ctx(req);
  const b = BroadcastBody.parse(req.body);
  const scope = access.require("notifications.manage");
  let userIds: string[];
  if (b.projectId) {
    const [p] = await db.select().from(projects).where(and(eq(projects.id, b.projectId), eq(projects.organizationId, access.orgId)));
    if (!p) throw notFound("المشروع غير موجود");
    if (scope !== "ALL" && !access.isMemberOf(p.id)) throw forbidden();
    const members = await db.select({ id: projectUsers.userId }).from(projectUsers).where(eq(projectUsers.projectId, p.id));
    userIds = [...new Set([...members.map((m) => m.id), ...(p.managerId ? [p.managerId] : [])])];
  } else {
    if (scope !== "ALL") throw forbidden("الإرسال لكل المستخدمين يتطلب صلاحية على مستوى الشركة");
    userIds = (await db.select({ id: users.id }).from(users).where(and(eq(users.organizationId, access.orgId), eq(users.status, "ACTIVE")))).map((u) => u.id);
  }
  if (!userIds.length) throw badRequest("لا يوجد مستلمون");
  const sent = await notifyUsers(db, { orgId: access.orgId, userIds, type: "SYSTEM_BROADCAST", title: b.title, body: b.body ?? undefined, projectId: b.projectId ?? null, category: "SYSTEM" });
  await audit(db, req, { action: "NOTIFICATION_BROADCAST", entity: "notification", projectId: b.projectId ?? null, metadata: { title: b.title, recipients: sent.length } });
  res.status(201).json({ data: { recipients: sent.length } });
});

