import "./_script-env.js";
import { eq, isNull, sql } from "drizzle-orm";
import { ALL_PERMISSION_KEYS, ROLE_KEYS, ROLES } from "../auth/permissions.js";
import type { Scope } from "../auth/permissions.js";
import { db, pool } from "../db/client.js";
import { permissions, rolePermissions, roles } from "../db/schema/index.js";
import { diffCatalog, renderCatalogDiff } from "../services/catalog-diff.js";

/**
 * READ-ONLY: shows what `db:bootstrap` (syncCatalog) would change in permissions, roles and grants.
 * Runs inside a READ ONLY transaction, so the database itself rejects any write.
 * Prints only permission/role keys and scopes: never connection details or user data.
 */
const result = await db.transaction(async (tx) => {
  await tx.execute(sql`set transaction read only`);
  const permRows = await tx.select({ key: permissions.key }).from(permissions);
  const roleRows = await tx.select({ id: roles.id, key: roles.key }).from(roles).where(isNull(roles.organizationId));
  const grantRows = await tx
    .select({ roleId: rolePermissions.roleId, key: permissions.key, scope: rolePermissions.scope })
    .from(rolePermissions)
    .innerJoin(permissions, eq(permissions.id, rolePermissions.permissionId));
  const dbRoles = roleRows.map((r) => ({
    key: r.key,
    grants: Object.fromEntries(grantRows.filter((g) => g.roleId === r.id).map((g) => [g.key, g.scope as Scope])),
  }));
  return diffCatalog(
    { permissions: permRows.map((p) => p.key), roles: dbRoles },
    { permissions: [...ALL_PERMISSION_KEYS], roles: ROLE_KEYS.map((k) => ({ key: k, grants: ROLES[k].grants as Record<string, Scope> })) },
  );
});

console.log(renderCatalogDiff(result));
console.log("\n[preview-catalog] read-only: nothing was written.");
await pool.end();
