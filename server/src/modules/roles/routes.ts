import { asc, eq, sql } from "drizzle-orm";
import { Router } from "express";
import { db } from "../../db/client.js";
import { permissions, rolePermissions, roles } from "../../db/schema/index.js";
import { ctx } from "../../http/context.js";
import { requirePermission } from "../../http/middleware.js";

export const rolesRouter = Router();

rolesRouter.get("/", requirePermission("roles.read"), async (req, res) => {
  const { access } = ctx(req);
  const roleRows = await db
    .select()
    .from(roles)
    .where(sql`${roles.organizationId} is null or ${roles.organizationId} = ${access.orgId}`)
    .orderBy(asc(roles.createdAt));
  const grants = await db
    .select({ roleId: rolePermissions.roleId, key: permissions.key, scope: rolePermissions.scope })
    .from(rolePermissions)
    .innerJoin(permissions, eq(permissions.id, rolePermissions.permissionId));
  res.json({
    data: roleRows.map((r) => ({
      id: r.id,
      key: r.key,
      nameAr: r.nameAr,
      description: r.description,
      isSystem: r.isSystem,
      permissions: Object.fromEntries(grants.filter((g) => g.roleId === r.id).map((g) => [g.key, g.scope])),
    })),
  });
});

rolesRouter.get("/permissions", requirePermission("roles.read"), async (_req, res) => {
  const rows = await db.select().from(permissions).orderBy(asc(permissions.module), asc(permissions.key));
  res.json({ data: rows.map((p) => ({ key: p.key, module: p.module, descriptionAr: p.descriptionAr })) });
});
