import { and, eq, inArray, or, sql, type SQL } from "drizzle-orm";
import type { Access } from "../../auth/access.js";
import type { PermissionKey } from "../../auth/permissions.js";
import { accidents } from "../../db/schema/index.js";
import { accidentScope } from "../operations/accidents.js";

type CaseRow = { projectId: string | null; createdBy: string; reportedBy: string | null; assignedTo: string | null; workflowStage: string | null };

/** The permission reaches this project: ALL, or PROJECT scope and a member. (ASSIGNED never counts as project-wide.) */
export function holdsScoped(a: Access, perm: PermissionKey, projectId: string | null): boolean {
  const s = a.scopeOf(perm);
  return s === "ALL" || (s === "PROJECT" && a.isMemberOf(projectId));
}

/** SQL form of holdsScoped for a project column. */
export function holdsScopedSql(a: Access, perm: PermissionKey): SQL {
  const s = a.scopeOf(perm);
  if (s === "ALL") return sql`true`;
  if (s === "PROJECT" && a.memberProjectIds.length > 0) return sql`${inArray(accidents.projectId, a.memberProjectIds)}`;
  return sql`false`;
}

/** Completes cases of the project (the project manager): accidents.update reaching it. */
export const handlesProject = (a: Access, acc: Pick<CaseRow, "projectId">) => holdsScoped(a, "accidents.update", acc.projectId);

/** Manages the queue and closure: accidents.assign or accidents.close reaching the project. */
export const isManager = (a: Access, acc: Pick<CaseRow, "projectId">) => holdsScoped(a, "accidents.assign", acc.projectId) || holdsScoped(a, "accidents.close", acc.projectId);

/** A draft is private to its creator/reporter, the project's case handlers and the managers. */
export function canSeeDraft(a: Access, acc: CaseRow): boolean {
  return acc.createdBy === a.userId || acc.reportedBy === a.userId || handlesProject(a, acc) || isManager(a, acc);
}

/** Case work belongs to the assignee; the holder of accidents.assign may act for them. */
export const isAssigneeOrAssigner = (a: Access, acc: Pick<CaseRow, "projectId" | "assignedTo">) =>
  acc.assignedTo === a.userId || holdsScoped(a, "accidents.assign", acc.projectId);

/**
 * What the finance office sees: the cases forwarded to it in the projects its permission reaches, and the ones it reviewed before.
 * (Finance has no assignee: the stage itself is the hand-over.)
 */
export function financeWindow(a: Access): SQL {
  if (!a.has("accidents.finance.review")) return sql`false`;
  const reviewed = sql`exists (select 1 from accident_finance_reviews fr where fr.accident_id = ${accidents.id} and fr.reviewed_by = ${a.userId})`;
  return and(holdsScopedSql(a, "accidents.finance.review"), or(sql`${accidents.workflowStage} = 'AWAITING_FINANCE_REVIEW'`, reviewed))!;
}

/**
 * What the central insurance account sees: every case, in any project, that is with insurance or has a claim (now or before).
 * Cases that never reached insurance stay invisible to it.
 */
export function insuranceWindow(a: Access): SQL {
  if (!a.has("accidents.claims.manage") || a.scopeOf("accidents.claims.manage") !== "ALL") return sql`false`;
  return or(
    sql`${accidents.workflowStage} in ('AWAITING_INSURANCE', 'CLAIM_IN_PROGRESS', 'AWAITING_COMPENSATION_PROOF')`,
    sql`exists (select 1 from accident_claims c where c.accident_id = ${accidents.id})`,
  )!;
}

/** Rows the user may see: the legacy read scope, plus cases assigned to them now or before and the finance window, minus drafts they may not see. */
export function caseVisibility(a: Access): SQL {
  const assignedNowOrBefore = sql`(${accidents.assignedTo} = ${a.userId} or exists (select 1 from accident_assignments aa where aa.accident_id = ${accidents.id} and aa.assigned_to = ${a.userId}))`;
  const readable = or(accidentScope(a, "accidents.read"), assignedNowOrBefore, financeWindow(a), insuranceWindow(a))!;
  const draftOk = or(
    sql`${accidents.workflowStage} is distinct from 'DRAFT'`,
    eq(accidents.createdBy, a.userId),
    eq(accidents.reportedBy, a.userId),
    holdsScopedSql(a, "accidents.update"),
    holdsScopedSql(a, "accidents.assign"),
    holdsScopedSql(a, "accidents.close"),
  )!;
  return and(readable, draftOk)!;
}

/** Only the draft rule, for the legacy routes (their own read scope stays as it is). */
export function draftVisibility(a: Access): SQL {
  return or(
    sql`${accidents.workflowStage} is distinct from 'DRAFT'`,
    eq(accidents.createdBy, a.userId),
    eq(accidents.reportedBy, a.userId),
    holdsScopedSql(a, "accidents.update"),
    holdsScopedSql(a, "accidents.assign"),
    holdsScopedSql(a, "accidents.close"),
  )!;
}
