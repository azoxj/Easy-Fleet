import { and, eq, inArray, or, sql, type SQL } from "drizzle-orm";
import type { DbOrTx } from "../db/client.js";
import {
  assignments,
  drivers,
  employees,
  maintenanceRequests,
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

/**
 * Employees: ALL = org; PROJECT = employees whose project is one of the user's
 * projects (plus the user's own employee record); ASSIGNED = own record only.
 * The project always comes from the stored employee row, never from the request.
 */
export function employeeScope(a: Access, perm: PermissionKey): SQL {
  const scope = a.require(perm);
  const org = eq(employees.organizationId, a.orgId);
  if (scope === "ALL") return org;
  const own = eq(employees.userId, a.userId);
  if (scope === "ASSIGNED") return and(org, own)!;
  const inProjects = a.memberProjectIds.length ? inArray(employees.projectId, a.memberProjectIds) : sql`false`;
  return and(org, or(inProjects, own))!;
}

/**
 * Maintenance requests explicitly assigned to the user: the assigned technician,
 * or an active MAINTENANCE_REQUEST assignment that still matches the request's project.
 * An assignment never grants a permission — it only widens ASSIGNED/PROJECT record sets.
 */
function assignedMaintenanceIds(a: Access): SQL {
  return sql`(
    select mr.id from maintenance_requests mr
     where mr.organization_id = ${a.orgId} and mr.assigned_to = ${a.userId}
    union
    select asg.reference_id from assignments asg
      join maintenance_requests amr on amr.id = asg.reference_id
     where asg.assigned_to = ${a.userId}
       and asg.organization_id = ${a.orgId}
       and asg.type = 'MAINTENANCE_REQUEST'
       and asg.status in ${ACTIVE_ASSIGNMENT}
       and asg.project_id is not distinct from amr.project_id
  )`;
}

export function maintenanceScope(a: Access, perm: PermissionKey): SQL {
  const scope = a.require(perm);
  const org = eq(maintenanceRequests.organizationId, a.orgId);
  if (scope === "ALL") return org;
  const assigned = sql`${maintenanceRequests.id} in ${assignedMaintenanceIds(a)}`;
  if (scope === "ASSIGNED") return and(org, assigned)!;
  const inProjects = a.memberProjectIds.length ? inArray(maintenanceRequests.projectId, a.memberProjectIds) : sql`false`;
  return and(org, or(inProjects, assigned))!;
}

/**
 * Point check for an already-loaded request.
 *  - "read":  ALL | PROJECT (member or assigned) | ASSIGNED (assigned)
 *  - "act":   ALL | PROJECT (member of the request's project) | ASSIGNED (assigned)
 * Acting with PROJECT scope requires real project membership; an assignment
 * alone does not let a project-scoped user approve or reject another project's work.
 */
export function canOnMaintenance(a: Access, perm: PermissionKey, mr: { projectId: string | null }, isAssigned: boolean, mode: "read" | "act"): boolean {
  const s = a.scopeOf(perm);
  if (!s) return false;
  if (s === "ALL") return true;
  if (s === "ASSIGNED") return isAssigned;
  return a.isMemberOf(mr.projectId) || (mode === "read" && isAssigned);
}

export async function isAssignedToMaintenance(db: DbOrTx, a: Access, mrId: string): Promise<boolean> {
  const [r] = await db.execute<{ ok: boolean }>(sql`select ${mrId}::uuid in ${assignedMaintenanceIds(a)} as ok`).then((x) => x.rows);
  return !!r?.ok;
}

/**
 * Users (active, same org) holding `perm` that reaches `projectId`:
 * ALL scope (optional) or PROJECT scope + membership/management of the project.
 */
export async function permissionHolders(
  db: DbOrTx,
  orgId: string,
  perm: PermissionKey,
  projectId: string | null,
  opts: { includeAllScope: boolean; onlyAllScope?: boolean; includeAssignedScope?: boolean } = { includeAllScope: true },
): Promise<string[]> {
  // includeAssignedScope: also count ASSIGNED-scoped holders who are members of the project
  // (e.g. technicians eligible to be assigned). Membership is still required.
  const scopes = opts.includeAssignedScope ? sql`rp.scope in ('PROJECT', 'ASSIGNED')` : sql`rp.scope = 'PROJECT'`;
  const projectClause = projectId
    ? sql`(${scopes} and (
          exists (select 1 from project_users pu where pu.project_id = ${projectId} and pu.user_id = u.id)
          or exists (select 1 from projects p where p.id = ${projectId} and p.manager_id = u.id)))`
    : sql`false`;
  const clause = opts.onlyAllScope ? sql`rp.scope = 'ALL'` : opts.includeAllScope ? sql`(rp.scope = 'ALL' or ${projectClause})` : projectClause;
  const rows = await db.execute<{ id: string }>(sql`
    select distinct u.id from users u
      join user_roles ur on ur.user_id = u.id
      join roles r on r.id = ur.role_id and (r.organization_id is null or r.organization_id = ${orgId})
      join role_permissions rp on rp.role_id = r.id
      join permissions pm on pm.id = rp.permission_id
     where u.organization_id = ${orgId} and u.status = 'ACTIVE' and pm.key = ${perm} and ${clause}`);
  return rows.rows.map((r) => r.id);
}

/** Drivers are scoped through their employee (callers must join employees). */
export function driverScope(a: Access, perm: PermissionKey): SQL {
  return and(eq(drivers.organizationId, a.orgId), employeeScope(a, perm))!;
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
