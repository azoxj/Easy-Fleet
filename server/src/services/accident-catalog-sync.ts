import { createHash } from "node:crypto";
import { and, eq, inArray, isNull } from "drizzle-orm";
import type { DbOrTx } from "../db/client.js";
import { PERMISSIONS, ROLES, type PermissionKey, type RoleKey, type Scope } from "../auth/permissions.js";
import { permissions, rolePermissions, roles } from "../db/schema/index.js";

/**
 * Targeted, additive catalog sync for the accident roles. It exists because the general `syncCatalog`
 * rewrites the grants of EVERY system role (including the pending PROJECT_MANAGER changes).
 *
 * Scope, enforced by `planAccidentCatalog` and re-verified after writing:
 *  - may create the six accident permissions and the two accident roles with their grants;
 *  - with `includeTechnical`, may add exactly two grants to TECHNICAL;
 *  - with `includeProjectManagerSensitive`, may add exactly one grant to PROJECT_MANAGER (accidents.documents.sensitive, PROJECT):
 *    what the project manager needs to see the documents a driver filed in their project. Nothing else about that role is read or written,
 *    so the pending PROJECT_MANAGER differences stay exactly as they are;
 *  - always adds SUPER_ADMIN's ALL grant for the accident permissions it does not hold yet (the administrator must reach the screens);
 *  - never deletes anything, never changes an existing grant, never touches any other role.
 */
export const ACCIDENT_PERMISSIONS: readonly PermissionKey[] = [
  "accidents.review.technical",
  "accidents.claims.manage",
  "accidents.assign",
  "accidents.close",
  "accidents.reopen",
  "accidents.documents.sensitive",
  "accidents.settings.manage",
];
export const MANAGED_ROLES: readonly RoleKey[] = ["ACCIDENT_MANAGER", "INSURANCE_OFFICER"];
/** The one grant this tool may add to PROJECT_MANAGER, and only on request. */
export const PM_SENSITIVE: { permission: PermissionKey; scope: Scope } = { permission: "accidents.documents.sensitive", scope: "PROJECT" };
export const TECHNICAL_ADDITIONS: readonly PermissionKey[] = ["accidents.review.technical", "accidents.documents.sensitive"];

export type CatalogState = { permissions: string[]; roles: { key: string; grants: Record<string, Scope> }[] };
export type GrantAdd = { role: string; permission: string; scope: Scope };
export type AccidentCatalogPlan = {
  permissionsToCreate: string[];
  rolesToCreate: string[];
  grantsToAdd: GrantAdd[];
  /** Reported only: a managed role already has this grant with another scope, or a grant the code does not declare. Never changed. */
  leftAsIs: string[];
  includeTechnical: boolean;
  includeProjectManagerSensitive: boolean;
  hash: string;
};

const grantsOf = (r: RoleKey) => ROLES[r].grants as Record<string, Scope>;

export function planAccidentCatalog(state: CatalogState, opts: { includeTechnical?: boolean; includeProjectManagerSensitive?: boolean } = {}): AccidentCatalogPlan {
  const have = new Set(state.permissions);
  const dbRoles = new Map(state.roles.map((r) => [r.key, r.grants]));
  const permissionsToCreate = ACCIDENT_PERMISSIONS.filter((p) => !have.has(p)).sort();
  const rolesToCreate = MANAGED_ROLES.filter((r) => !dbRoles.has(r)).slice().sort();
  const grantsToAdd: GrantAdd[] = [];
  const leftAsIs: string[] = [];
  for (const role of MANAGED_ROLES) {
    const cur = dbRoles.get(role) ?? {};
    for (const [permission, scope] of Object.entries(grantsOf(role))) {
      if (!(permission in cur)) grantsToAdd.push({ role, permission, scope });
      else if (cur[permission] !== scope) leftAsIs.push(`${role}: ${permission} is ${cur[permission]} in the database, ${scope} in code (not changed)`);
    }
    for (const permission of Object.keys(cur)) if (!(permission in grantsOf(role))) leftAsIs.push(`${role}: ${permission} is in the database but not in code (not removed)`);
  }
  // SUPER_ADMIN holds every permission in code, but the database only learns it from the (opt-in) general bootstrap:
  // without these rows the administrator would not see the accident screens either. Only the accident permissions, scope ALL.
  const sa = dbRoles.get("SUPER_ADMIN");
  if (sa) for (const permission of ACCIDENT_PERMISSIONS) if (!(permission in sa)) grantsToAdd.push({ role: "SUPER_ADMIN", permission, scope: "ALL" });
  if (opts.includeTechnical) {
    const cur = dbRoles.get("TECHNICAL");
    if (cur) {
      for (const permission of TECHNICAL_ADDITIONS) if (!(permission in cur)) grantsToAdd.push({ role: "TECHNICAL", permission, scope: grantsOf("TECHNICAL")[permission]! });
    }
  }
  if (opts.includeProjectManagerSensitive) {
    const cur = dbRoles.get("PROJECT_MANAGER");
    if (cur) {
      if (!(PM_SENSITIVE.permission in cur)) grantsToAdd.push({ role: "PROJECT_MANAGER", permission: PM_SENSITIVE.permission, scope: PM_SENSITIVE.scope });
      else if (cur[PM_SENSITIVE.permission] !== PM_SENSITIVE.scope) leftAsIs.push(`PROJECT_MANAGER: ${PM_SENSITIVE.permission} is ${cur[PM_SENSITIVE.permission]} in the database, ${PM_SENSITIVE.scope} intended (not changed)`);
    }
  }
  grantsToAdd.sort((a, b) => `${a.role}|${a.permission}`.localeCompare(`${b.role}|${b.permission}`));
  const body = { permissionsToCreate, rolesToCreate, grantsToAdd, includeTechnical: !!opts.includeTechnical, includeProjectManagerSensitive: !!opts.includeProjectManagerSensitive };
  return { ...body, leftAsIs, hash: createHash("sha256").update(JSON.stringify(body)).digest("hex").slice(0, 16) };
}

export const isEmptyPlan = (p: AccidentCatalogPlan) => !p.permissionsToCreate.length && !p.rolesToCreate.length && !p.grantsToAdd.length;

/** The plan may only ever name the managed roles, plus TECHNICAL's two additions when asked. Anything else is a bug. */
export function assertPlanScope(p: AccidentCatalogPlan): void {
  for (const g of p.grantsToAdd) {
    const managed = MANAGED_ROLES.includes(g.role as RoleKey);
    const technical = p.includeTechnical && g.role === "TECHNICAL" && (TECHNICAL_ADDITIONS as readonly string[]).includes(g.permission);
    const pm = p.includeProjectManagerSensitive && g.role === "PROJECT_MANAGER" && g.permission === PM_SENSITIVE.permission && g.scope === PM_SENSITIVE.scope;
    const admin = g.role === "SUPER_ADMIN" && g.scope === "ALL" && (ACCIDENT_PERMISSIONS as readonly string[]).includes(g.permission);
    if (!managed && !technical && !pm && !admin) throw new Error(`plan touches ${g.role}/${g.permission}, which this tool never changes`);
  }
  for (const r of p.rolesToCreate) if (!MANAGED_ROLES.includes(r as RoleKey)) throw new Error(`plan creates role ${r}`);
  for (const k of p.permissionsToCreate) if (!(ACCIDENT_PERMISSIONS as readonly string[]).includes(k)) throw new Error(`plan creates permission ${k}`);
}

export async function readCatalogState(db: DbOrTx): Promise<CatalogState> {
  const perms = await db.select({ key: permissions.key }).from(permissions);
  const roleRows = await db.select({ id: roles.id, key: roles.key }).from(roles).where(isNull(roles.organizationId));
  const grants = await db.select({ roleId: rolePermissions.roleId, key: permissions.key, scope: rolePermissions.scope }).from(rolePermissions).innerJoin(permissions, eq(permissions.id, rolePermissions.permissionId));
  return {
    permissions: perms.map((p) => p.key),
    roles: roleRows.map((r) => ({ key: r.key, grants: Object.fromEntries(grants.filter((g) => g.roleId === r.id).map((g) => [g.key, g.scope as Scope])) })),
  };
}

const fingerprint = (s: CatalogState) => JSON.stringify({ p: [...s.permissions].sort(), r: s.roles.map((r) => [r.key, Object.entries(r.grants).sort()]).sort() });

/** Writes the plan (insert-only) inside the caller's transaction, then proves nothing outside the plan changed. Throws to roll back. */
export async function applyAccidentCatalogPlan(tx: DbOrTx, plan: AccidentCatalogPlan): Promise<void> {
  assertPlanScope(plan);
  const before = await readCatalogState(tx);
  for (const key of plan.permissionsToCreate) {
    const p = PERMISSIONS[key as PermissionKey];
    await tx.insert(permissions).values({ key, module: p.module, descriptionAr: p.descriptionAr }).onConflictDoNothing({ target: permissions.key });
  }
  for (const key of plan.rolesToCreate) {
    const def = ROLES[key as RoleKey];
    const [exists] = await tx.select({ id: roles.id }).from(roles).where(and(eq(roles.key, key), isNull(roles.organizationId)));
    if (!exists) await tx.insert(roles).values({ key, nameAr: def.nameAr, description: def.description, isSystem: true });
  }
  const permRows = await tx.select({ id: permissions.id, key: permissions.key }).from(permissions).where(inArray(permissions.key, [...new Set(plan.grantsToAdd.map((g) => g.permission))]));
  const roleRows = await tx.select({ id: roles.id, key: roles.key }).from(roles).where(and(isNull(roles.organizationId), inArray(roles.key, [...new Set(plan.grantsToAdd.map((g) => g.role))])));
  for (const g of plan.grantsToAdd) {
    const roleId = roleRows.find((r) => r.key === g.role)?.id;
    const permissionId = permRows.find((p) => p.key === g.permission)?.id;
    if (!roleId || !permissionId) throw new Error(`cannot resolve ${g.role}/${g.permission}`);
    await tx.insert(rolePermissions).values({ roleId, permissionId, scope: g.scope }).onConflictDoNothing();
  }

  // Proof: the new state equals the old state plus exactly the planned additions.
  const expected = structuredClone(before);
  for (const k of plan.permissionsToCreate) expected.permissions.push(k);
  for (const k of plan.rolesToCreate) expected.roles.push({ key: k, grants: {} });
  for (const g of plan.grantsToAdd) expected.roles.find((r) => r.key === g.role)!.grants[g.permission] = g.scope;
  if (fingerprint(await readCatalogState(tx)) !== fingerprint(expected)) throw new Error("verification failed: the catalog changed beyond the plan; rolled back");
}
