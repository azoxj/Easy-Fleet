import { and, eq } from "drizzle-orm";
import { employeeScope, type Access } from "../../auth/access.js";
import type { PermissionKey } from "../../auth/permissions.js";
import type { DbOrTx } from "../../db/client.js";
import { employees } from "../../db/schema/index.js";
import { notFound } from "../../http/errors.js";

/** Loads an employee only when inside the caller's scope for `perm`; otherwise 404. */
export async function getEmployeeInScope(db: DbOrTx, a: Access, id: string, perm: PermissionKey) {
  const [row] = await db
    .select()
    .from(employees)
    .where(and(eq(employees.id, id), employeeScope(a, perm)))
    .limit(1);
  if (!row) throw notFound("الموظف غير موجود");
  return row;
}

/** True when the employee row is inside the caller's scope for `perm` (false if the permission is missing). */
export function employeeRowInScope(a: Access, e: { projectId: string | null; userId: string | null }, perm: PermissionKey) {
  const s = a.scopeOf(perm);
  if (!s) return false;
  if (s === "ALL") return true;
  if (e.userId && e.userId === a.userId) return true;
  return s === "PROJECT" && a.isMemberOf(e.projectId);
}

/** National ID / Iqama shown only to users who may edit the record; everyone else gets the last 4 digits. */
export function maskNationalId(value: string | null, canSeeFull: boolean): string | null {
  if (!value) return null;
  if (canSeeFull) return value;
  return value.length <= 4 ? "••••" : `••••${value.slice(-4)}`;
}
