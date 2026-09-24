import { and, desc, eq, gte, inArray, lte, sql } from "drizzle-orm";
import { Router } from "express";
import { z } from "zod";
import { db } from "../../db/client.js";
import { auditLogs, users } from "../../db/schema/index.js";
import { ctx } from "../../http/context.js";
import { requirePermission } from "../../http/middleware.js";
import { isoDate, paged, pagination, uuid } from "../../http/validate.js";

/** Read-only. There is intentionally no update/delete endpoint, and the DB rejects both. */
export const auditRouter = Router();

const Query = pagination.extend({
  action: z.string().trim().max(60).optional(),
  entity: z.string().trim().max(60).optional(),
  entityId: z.string().trim().max(60).optional(),
  userId: uuid.optional(),
  from: isoDate.optional(),
  to: isoDate.optional(),
});

auditRouter.get("/", requirePermission("audit.read"), async (req, res) => {
  const { access } = ctx(req);
  const scope = access.require("audit.read");
  const q = Query.parse(req.query);
  const where = [eq(auditLogs.organizationId, access.orgId)];
  if (scope !== "ALL") {
    where.push(access.memberProjectIds.length ? inArray(auditLogs.projectId, access.memberProjectIds) : sql`false`);
  }
  if (q.action) where.push(eq(auditLogs.action, q.action));
  if (q.entity) where.push(eq(auditLogs.entity, q.entity));
  if (q.entityId) where.push(eq(auditLogs.entityId, q.entityId));
  if (q.userId) where.push(eq(auditLogs.userId, q.userId));
  if (q.from) where.push(gte(auditLogs.createdAt, new Date(`${q.from}T00:00:00Z`)));
  if (q.to) where.push(lte(auditLogs.createdAt, new Date(`${q.to}T23:59:59.999Z`)));
  const cond = and(...where);
  const [rows, [count]] = await Promise.all([
    db
      .select({
        id: auditLogs.id,
        action: auditLogs.action,
        entity: auditLogs.entity,
        entityId: auditLogs.entityId,
        projectId: auditLogs.projectId,
        metadata: auditLogs.metadata,
        ip: auditLogs.ip,
        createdAt: auditLogs.createdAt,
        userId: auditLogs.userId,
        userName: users.name,
      })
      .from(auditLogs)
      .leftJoin(users, eq(users.id, auditLogs.userId))
      .where(cond)
      .orderBy(desc(auditLogs.id))
      .limit(q.pageSize)
      .offset((q.page - 1) * q.pageSize),
    db.select({ n: sql<number>`count(*)::int` }).from(auditLogs).where(cond),
  ]);
  res.json(paged(rows, count?.n ?? 0, q.page, q.pageSize));
});
