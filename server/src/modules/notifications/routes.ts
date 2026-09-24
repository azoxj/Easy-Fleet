import { and, desc, eq, isNull, sql } from "drizzle-orm";
import { Router } from "express";
import { z } from "zod";
import { db } from "../../db/client.js";
import { notifications } from "../../db/schema/index.js";
import { ctx } from "../../http/context.js";
import { notFound } from "../../http/errors.js";
import { idParam, paged, pagination } from "../../http/validate.js";

/** Every query here is pinned to the session's user id — no cross-user access is possible. */
export const notificationsRouter = Router();

const mine = (userId: string, orgId: string) => and(eq(notifications.userId, userId), eq(notifications.organizationId, orgId));

notificationsRouter.get("/", async (req, res) => {
  const { access } = ctx(req);
  const q = pagination.extend({ unreadOnly: z.enum(["true", "false"]).optional() }).parse(req.query);
  const cond = and(mine(access.userId, access.orgId), q.unreadOnly === "true" ? isNull(notifications.readAt) : undefined);
  const [rows, [count]] = await Promise.all([
    db
      .select({
        id: notifications.id,
        type: notifications.type,
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
