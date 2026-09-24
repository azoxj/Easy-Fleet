import { and, eq, inArray, or, sql, type SQL } from "drizzle-orm";
import type { DbOrTx } from "../db/client.js";
import {
  assignments,
  permissions,
  projects,
  projectUsers,
  rolePermissions,
  roles,
  userRoles,
  vehicles,
} from "../db/schema/index.js";
import { forbidden, notFound } from "../http/errors.js";
import { widerScope, type PermissionKey, type Scope } from "./permissions.js";

const ACTIVE_ASSIGNMENT = sql`('PENDING', 'IN_PROGRESS')`;

/**
 * Everything the server needs to authorize a request, computed server-side
 * from the session only. Nothing here is ever taken from the client.
 */
export class Access {
  constructor(
    readonly userId: string,
    readonly orgId: string,
    readonly roleKeys: string[],
    private readonly perms: Map<string, Scope>,
    /** Projects the user is a member or manager of (org-restricted). */
    readonly memberProjectIds: string[],
  ) {}

  scopeOf(perm: PermissionKey): Scope | null {
    return this.perms.get(perm) ?? null;
  }

  has(perm: PermissionKey): boolean {
    return this.perms.has(perm);
  }

  /** Throws 403 when the permission is missing entirely; returns its scope. */
  require(perm: PermissionKey): Scope {
    const s = this.perms.get(perm);
    if (!s) throw forbidden();
    return s;
  }

  isMemberOf(projectId: string | null | undefined): boolean {
    return !!projectId && this.memberProjectIds.includes(projectId);
  }

  permissionMap(): Record<string, Scope> {
    return Object.fromEntries(this.perms);
  }
}

export async function loadAccess(db: DbOrTx, userId: string, orgId: string): Promise<Access> {
  const rows = await db
    .select({ roleKey: roles.key, perm: permissions.key, scope: rolePermissions.scope })
    .from(userRoles)
    .innerJoin(roles, eq(roles.id, userRoles.roleId))
    .leftJoin(rolePermissions, eq(rolePermissions.roleId, roles.id))
    .leftJoin(permissions, eq(permissions.id, rolePermissions.permissionId))
    .where(and(eq(userRoles.userId, userId), or(sql`${roles.organizationId} is null`, eq(roles.organizationId, orgId))));

  const perms = new Map<string, Scope>();
  const roleKeys = new Set<string>();
  for (const r of rows) {
    roleKeys.add(r.roleKey);
    if (r.perm && r.scope) perms.set(r.perm, widerScope(perms.get(r.perm), r.scope));
  }

  const projectRows = await db
    .select({ id: projects.id })
    .from(projects)
    .where(
      and(
        eq(projects.organizationId, orgId),
        or(
          eq(projects.managerId, userId),
          sql`exists (select 1 from ${projectUsers} pu where pu.project_id = ${projects.id} and pu.user_id = ${userId})`,
        ),
      ),
    );

  return new Access(userId, orgId, [...roleKeys], perms, projectRows.map((p) => p.id));
}

// ---------------------------------------------------------------------------
// Scoped record-set conditions. Each returns a SQL predicate that MUST be
// included in every query touching the table for the given permission.
// ---------------------------------------------------------------------------

function uuidArray(ids: string[]): SQL {
  return sql`array[${sql.join(
    ids.map((id) => sql`${id}::uuid`),
    sql`, `,
  )}]::uuid[]`;
}

/**
 * Vehicles explicitly assigned to the user. An assignment only counts while
 * the vehicle is still inside the assignment's project, so moving a vehicle to
 * another project silently invalidates stale assignments.
 */
function assignedVehicleIds(a: Access): SQL {
  return sql`(
    select asg.vehicle_id from assignments asg
      join vehicles av on av.id = asg.vehicle_id
     where asg.assigned_to = ${a.userId}
       and asg.organization_id = ${a.orgId}
       and asg.type = 'VEHICLE'
       and asg.status in ${ACTIVE_ASSIGNMENT}
       and asg.project_id is not distinct from av.project_id
    union
    select dv.id from vehicles dv
      join drivers d on d.id = dv.assigned_driver_id and d.status = 'ACTIVE'
      join employees e on e.id = d.employee_id
     where e.user_id = ${a.userId} and dv.organization_id = ${a.orgId}
  )`;
}

function assignedProjectIds(a: Access): SQL {
  return sql`(
    select asg.project_id from assignments asg
     where asg.assigned_to = ${a.userId}
       and asg.organization_id = ${a.orgId}
       and asg.type = 'PROJECT'
       and asg.status in ${ACTIVE_ASSIGNMENT}
       and asg.project_id is not null
  )`;
}

export function vehicleScope(a: Access, perm: PermissionKey): SQL {
  const scope = a.require(perm);
  const org = eq(vehicles.organizationId, a.orgId);
  if (scope === "ALL") return org;
  const assigned = sql`${vehicles.id} in ${assignedVehicleIds(a)}`;
  if (scope === "ASSIGNED") return and(org, assigned)!;
  const inProjects = a.memberProjectIds.length
    ? sql`${vehicles.projectId} = any(${uuidArray(a.memberProjectIds)})`
    : sql`false`;
  return and(org, or(inProjects, assigned))!;
}

export function projectScope(a: Access, perm: PermissionKey): SQL {
  const scope = a.require(perm);
  const org = eq(projects.organizationId, a.orgId);
  if (scope === "ALL") return org;
  const assigned = sql`${projects.id} in ${assignedProjectIds(a)}`;
  if (scope === "ASSIGNED") return and(org, assigned)!;
  const member = a.memberProjectIds.length ? inArray(projects.id, a.memberProjectIds) : sql`false`;
  return and(org, or(member, assigned))!;
}

/** Assignments of *other* users visible to the caller (own ones are always visible). */
export function assignmentScope(a: Access): SQL {
  const own = or(eq(assignments.assignedTo, a.userId), eq(assignments.assignedBy, a.userId))!;
  const org = eq(assignments.organizationId, a.orgId);
  const scope = a.scopeOf("assignments.read");
  if (scope === "ALL") return org;
  if (scope === "PROJECT" && a.memberProjectIds.length) {
    return and(org, or(own, inArray(assignments.projectId, a.memberProjectIds)))!;
  }
  return and(org, own)!;
}

// ---------------------------------------------------------------------------
// Point checks used before mutating a single record.
// ---------------------------------------------------------------------------

/**
 * Loads a vehicle only if it lies inside the caller's scope for `perm`.
 * Out-of-scope and non-existent records both yield 404 (no existence oracle).
 */
export async function getVehicleInScope(db: DbOrTx, a: Access, vehicleId: string, perm: PermissionKey) {
  const [row] = await db
    .select()
    .from(vehicles)
    .where(and(eq(vehicles.id, vehicleId), vehicleScope(a, perm)))
    .limit(1);
  if (!row) throw notFound("المركبة غير موجودة");
  return row;
}

export async function getProjectInScope(db: DbOrTx, a: Access, projectId: string, perm: PermissionKey) {
  const [row] = await db
    .select()
    .from(projects)
    .where(and(eq(projects.id, projectId), projectScope(a, perm)))
    .limit(1);
  if (!row) throw notFound("المشروع غير موجود");
  return row;
}

/**
 * Checks the caller may act on a *target project* with `perm` (used when a
 * record is created in / moved to a project). ASSIGNED scope never allows
 * placing records into a project.
 */
export async function assertCanUseProject(db: DbOrTx, a: Access, projectId: string, perm: PermissionKey) {
  const scope = a.require(perm);
  const [row] = await db
    .select({ id: projects.id, status: projects.status })
    .from(projects)
    .where(and(eq(projects.id, projectId), eq(projects.organizationId, a.orgId)))
    .limit(1);
  if (!row) throw notFound("المشروع غير موجود");
  if (scope === "ALL") return row;
  if (scope === "PROJECT" && a.isMemberOf(projectId)) return row;
  throw forbidden("لا تملك صلاحية على هذا المشروع");
}
