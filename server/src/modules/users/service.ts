import { and, eq, inArray, isNull, ne, sql } from "drizzle-orm";
import type { Access } from "../../auth/access.js";
import { SCOPE_RANK, type Scope } from "../../auth/permissions.js";
import type { DbOrTx } from "../../db/client.js";
import { permissions, rolePermissions, roles, userRoles, users } from "../../db/schema/index.js";
import { badRequest, forbidden } from "../../http/errors.js";

export async function rolesForUsers(db: DbOrTx, userIds: string[]) {
  const map = new Map<string, { key: string; nameAr: string }[]>();
  if (userIds.length === 0) return map;
  const rows = await db
    .select({ userId: userRoles.userId, key: roles.key, nameAr: roles.nameAr })
    .from(userRoles)
    .innerJoin(roles, eq(roles.id, userRoles.roleId))
    .where(inArray(userRoles.userId, userIds));
  for (const r of rows) {
    const list = map.get(r.userId) ?? [];
    list.push({ key: r.key, nameAr: r.nameAr });
    map.set(r.userId, list);
  }
  return map;
}

/**
 * Resolves role keys to role rows available to the organization and enforces
 * the anti-escalation rule: the caller may only grant a role whose every
 * permission they already hold with an equal or wider scope.
 */
export async function resolveGrantableRoles(db: DbOrTx, access: Access, roleKeys: string[]) {
  const unique = [...new Set(roleKeys)];
  if (unique.length === 0) throw badRequest("يجب اختيار دور واحد على الأقل");
  const found = await db
    .select({ id: roles.id, key: roles.key })
    .from(roles)
    .where(and(inArray(roles.key, unique), sql`(${roles.organizationId} is null or ${roles.organizationId} = ${access.orgId})`));
  if (found.length !== unique.length) throw badRequest("دور غير معروف");

  const grants = await db
    .select({ roleKey: roles.key, perm: permissions.key, scope: rolePermissions.scope })
    .from(rolePermissions)
    .innerJoin(roles, eq(roles.id, rolePermissions.roleId))
    .innerJoin(permissions, eq(permissions.id, rolePermissions.permissionId))
    .where(inArray(rolePermissions.roleId, found.map((f) => f.id)));
  for (const g of grants) {
    const mine = access.permissionMap()[g.perm] as Scope | undefined;
    if (!mine || SCOPE_RANK[mine] < SCOPE_RANK[g.scope]) {
      throw forbidden(`لا يمكنك منح الدور ${g.roleKey} لأنه يتجاوز صلاحياتك`);
    }
  }
  return found;
}

/** True when `userId` is the last active SUPER_ADMIN of the organization. */
export async function isLastActiveSuperAdmin(db: DbOrTx, orgId: string, userId: string) {
  const [row] = await db
    .select({ n: sql<number>`count(*)::int` })
    .from(userRoles)
    .innerJoin(roles, eq(roles.id, userRoles.roleId))
    .innerJoin(users, eq(users.id, userRoles.userId))
    .where(
      and(
        eq(roles.key, "SUPER_ADMIN"),
        isNull(roles.organizationId),
        eq(users.organizationId, orgId),
        eq(users.status, "ACTIVE"),
        ne(users.id, userId),
      ),
    );
  return (row?.n ?? 0) === 0;
}
