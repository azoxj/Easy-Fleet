import { and, eq, inArray, isNull, notInArray, sql } from "drizzle-orm";
import { ALL_PERMISSION_KEYS, PERMISSIONS, ROLE_KEYS, ROLES } from "../auth/permissions.js";
import type { DbOrTx } from "./client.js";
import { organizations, permissions, rolePermissions, roles } from "./schema/index.js";

export const DEFAULT_ORG_SLUG = "default";

/**
 * Idempotently brings the database in line with the code-defined catalog:
 * the default organization, all permissions, the built-in roles and exactly
 * the grants declared in auth/permissions.ts. Safe to run on every deploy.
 */
export async function syncCatalog(db: DbOrTx, orgName = "Easy Fleet") {
  let [org] = await db.select().from(organizations).where(eq(organizations.slug, DEFAULT_ORG_SLUG));
  if (!org) {
    [org] = await db.insert(organizations).values({ name: orgName, slug: DEFAULT_ORG_SLUG }).returning();
  }

  for (const key of ALL_PERMISSION_KEYS) {
    const p = PERMISSIONS[key];
    await db
      .insert(permissions)
      .values({ key, module: p.module, descriptionAr: p.descriptionAr })
      .onConflictDoUpdate({ target: permissions.key, set: { module: p.module, descriptionAr: p.descriptionAr } });
  }
  await db.delete(permissions).where(notInArray(permissions.key, ALL_PERMISSION_KEYS));
  const permRows = await db.select().from(permissions);
  const permId = new Map(permRows.map((p) => [p.key, p.id]));

  for (const key of ROLE_KEYS) {
    const def = ROLES[key];
    let [role] = await db.select().from(roles).where(and(eq(roles.key, key), isNull(roles.organizationId)));
    if (!role) {
      [role] = await db.insert(roles).values({ key, nameAr: def.nameAr, description: def.description, isSystem: true }).returning();
    } else {
      await db.update(roles).set({ nameAr: def.nameAr, description: def.description, isSystem: true }).where(eq(roles.id, role.id));
    }
    await db.delete(rolePermissions).where(eq(rolePermissions.roleId, role!.id));
    const grants = Object.entries(def.grants);
    if (grants.length) {
      await db.insert(rolePermissions).values(grants.map(([perm, scope]) => ({ roleId: role!.id, permissionId: permId.get(perm)!, scope })));
    }
  }

  const count = await db
    .select({ n: sql<number>`count(*)::int` })
    .from(roles)
    .where(and(isNull(roles.organizationId), inArray(roles.key, ROLE_KEYS)));
  return { org: org!, roleCount: count[0]?.n ?? 0 };
}
