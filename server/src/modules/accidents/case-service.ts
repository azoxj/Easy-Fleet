import type { Request } from "express";
import { and, eq, isNull, or, sql } from "drizzle-orm";
import { loadAccess, permissionHolders, type Access } from "../../auth/access.js";
import type { PermissionKey } from "../../auth/permissions.js";
import type { DbOrTx } from "../../db/client.js";
import {
  accidentAssignments,
  accidentAttachments,
  accidentClaims,
  accidentEstimates,
  accidentStageOfficers,
  accidentTransitions,
  accidents,
  projects,
  users,
  vehicles,
} from "../../db/schema/index.js";
import { HttpError, notFound } from "../../http/errors.js";
import { tr } from "../../i18n/index.js";
import { now } from "../../lib/clock.js";
import { audit } from "../../services/audit.js";
import { notifyUsers } from "../../services/notifications.js";
import { FLAGGABLE, accLabel, accidentRecipients, restoreVehicle } from "../operations/accidents.js";
import { decideAssignment, type OfficerCandidate } from "./assignment.js";
import type { CaseFacts, ClaimStatus, RepairDecision } from "./requirements.js";
import { caseVisibility } from "./visibility.js";
import { evaluateTransition, legacyStatusFor, type TransitionKind, type WorkflowStage } from "./workflow.js";

export type Case = typeof accidents.$inferSelect;

/** Stage families that have a designated officer. Other stages are worked by the project manager or the closer. */
export type OfficerFamily = "TECHNICAL" | "INSURANCE";
export function stageFamily(stage: WorkflowStage): OfficerFamily | null {
  if (stage === "AWAITING_TECHNICAL") return "TECHNICAL";
  if (stage === "AWAITING_INSURANCE" || stage === "CLAIM_IN_PROGRESS" || stage === "AWAITING_COMPENSATION_PROOF") return "INSURANCE";
  return null;
}
export const FAMILY_PERMISSION: Record<OfficerFamily, PermissionKey> = { TECHNICAL: "accidents.review.technical", INSURANCE: "accidents.claims.manage" };

export const stageOf = (acc: Case): WorkflowStage => acc.workflowStage as WorkflowStage;

/** Loads a case the caller may see and locks the row for the rest of the transaction (serialises concurrent moves). */
export async function lockCase(tx: DbOrTx, access: Access, id: string): Promise<Case> {
  const [row] = await tx
    .select()
    .from(accidents)
    .where(and(eq(accidents.id, id), eq(accidents.organizationId, access.orgId), sql`${accidents.workflowStage} is not null`, caseVisibility(access)))
    .for("update");
  if (!row) throw notFound(tr("الحادث غير موجود"));
  return row;
}

export async function loadFacts(tx: DbOrTx, acc: Case): Promise<CaseFacts> {
  const [atts, estimates, [claim]] = await Promise.all([
    tx.select({ category: accidentAttachments.category }).from(accidentAttachments).where(and(eq(accidentAttachments.accidentId, acc.id), isNull(accidentAttachments.supersededAt))),
    tx.select({ selected: accidentEstimates.selected }).from(accidentEstimates).where(eq(accidentEstimates.accidentId, acc.id)),
    tx.select().from(accidentClaims).where(eq(accidentClaims.accidentId, acc.id)),
  ]);
  return {
    attachmentCategories: atts.map((a) => a.category),
    damageDescription: acc.damageDescription,
    technicalNotes: acc.technicalNotes,
    repairDecision: acc.repairDecision as RepairDecision | null,
    estimates,
    claim: claim ? { status: claim.status as ClaimStatus, insurerName: claim.insurerName, claimNumber: claim.claimNumber, filedAt: claim.filedAt, rejectionReason: claim.rejectionReason, receivedAmount: claim.receivedAmount } : null,
    resolution: acc.resolution,
  };
}

async function officerCandidates(tx: DbOrTx, orgId: string, family: OfficerFamily, projectId: string | null): Promise<OfficerCandidate[]> {
  const rows = await tx
    .select({ userId: accidentStageOfficers.userId, projectId: accidentStageOfficers.projectId, status: users.status })
    .from(accidentStageOfficers)
    .innerJoin(users, eq(users.id, accidentStageOfficers.userId))
    .where(and(eq(accidentStageOfficers.organizationId, orgId), eq(accidentStageOfficers.stage, family), or(isNull(accidentStageOfficers.projectId), projectId ? eq(accidentStageOfficers.projectId, projectId) : sql`false`)));
  const holds = new Map<string, boolean>();
  for (const r of rows) if (!holds.has(r.userId)) holds.set(r.userId, (await loadAccess(tx, r.userId, orgId)).has(FAMILY_PERMISSION[family]));
  return rows.map((r) => ({ userId: r.userId, projectId: r.projectId, active: r.status === "ACTIVE", holdsPermission: holds.get(r.userId) ?? false }));
}

/** Runs the assignment engine for the stage the case just entered and records the outcome. */
async function assignOnEntry(tx: DbOrTx, req: Request, acc: Case, stage: WorkflowStage, family: OfficerFamily): Promise<void> {
  const decision = decideAssignment(await officerCandidates(tx, acc.organizationId, family, acc.projectId), acc.projectId);
  const at = now();
  if (decision.mode === "AUTO") {
    await tx.update(accidents).set({ assignedTo: decision.userId, assignedAt: at, assignmentMode: "AUTO" }).where(eq(accidents.id, acc.id));
    await tx.insert(accidentAssignments).values({ organizationId: acc.organizationId, accidentId: acc.id, stage, assignedTo: decision.userId, assignedBy: null, mode: "AUTO", reason: decision.level });
    await audit(tx, req, { action: "ACCIDENT_CASE_ASSIGNED", entity: "accident", entityId: acc.id, projectId: acc.projectId, vehicleId: acc.vehicleId, metadata: { label: accLabel(acc.number), stage, mode: "AUTO", assignedTo: decision.userId } });
    await notifyUsers(tx, { orgId: acc.organizationId, userIds: [decision.userId], type: "ACCIDENT_CASE_ASSIGNED", title: tr("أُسند إليك الحادث {0}", accLabel(acc.number)), link: `/accidents/${acc.id}`, entityType: "accident", entityId: acc.id });
  } else {
    await tx.update(accidents).set({ assignedTo: null, assignedAt: at, assignmentMode: "QUEUE" }).where(eq(accidents.id, acc.id));
    await tx.insert(accidentAssignments).values({ organizationId: acc.organizationId, accidentId: acc.id, stage, assignedTo: null, assignedBy: null, mode: "QUEUE", reason: decision.reason });
    await audit(tx, req, { action: "ACCIDENT_CASE_ASSIGNED", entity: "accident", entityId: acc.id, projectId: acc.projectId, vehicleId: acc.vehicleId, metadata: { label: accLabel(acc.number), stage, mode: "QUEUE", reason: decision.reason } });
    const managers = await permissionHolders(tx, acc.organizationId, "accidents.assign", acc.projectId, { includeAllScope: true });
    await notifyUsers(tx, { orgId: acc.organizationId, userIds: managers, type: "ACCIDENT_CASE_QUEUED", title: tr("الحادث {0} بانتظار الإسناد", accLabel(acc.number)), link: `/accidents/${acc.id}`, entityType: "accident", entityId: acc.id });
  }
}

/** Flags the vehicle ACCIDENT when a case is submitted or reopened (same rule as the legacy report). */
async function flagVehicle(tx: DbOrTx, req: Request, acc: Case): Promise<void> {
  const [v] = await tx.select().from(vehicles).where(eq(vehicles.id, acc.vehicleId)).for("update");
  if (!v) return;
  if (v.status === "ARCHIVED" || v.status === "SOLD") throw new HttpError(409, "VEHICLE_UNAVAILABLE", tr("المركبة مؤرشفة أو مباعة"));
  if (!FLAGGABLE.has(v.status)) return;
  await tx.update(accidents).set({ vehicleStatusBefore: v.status }).where(eq(accidents.id, acc.id));
  await tx.update(vehicles).set({ status: "ACCIDENT", updatedAt: now() }).where(eq(vehicles.id, v.id));
  await audit(tx, req, { action: "VEHICLE_UPDATED", entity: "vehicle", entityId: v.id, projectId: v.projectId, vehicleId: v.id, metadata: { changes: { status: { from: v.status, to: "ACCIDENT" } }, source: accLabel(acc.number) } });
}

export type RequiredAction = { type: "USER" | "QUEUE" | "PROJECT_MANAGER" | "ROLE"; permission: PermissionKey; userId: string | null; name: string | null };

/** Who has to act on the case in its current stage (shown with the "returned for completion" marker). */
export async function requiredActionFor(db: DbOrTx, acc: Case): Promise<RequiredAction | null> {
  const stage = acc.workflowStage as WorkflowStage | null;
  if (!stage || stage === "CLOSED") return null;
  const nameOf = async (id: string | null) => (id ? ((await db.select({ n: users.name }).from(users).where(eq(users.id, id))))[0]?.n ?? null : null);
  const family = stageFamily(stage);
  if (family) {
    if (acc.assignedTo) return { type: "USER", permission: FAMILY_PERMISSION[family], userId: acc.assignedTo, name: await nameOf(acc.assignedTo) };
    return { type: "QUEUE", permission: "accidents.assign", userId: null, name: null };
  }
  if (stage === "AWAITING_FINAL_CLOSURE") return { type: "ROLE", permission: "accidents.close", userId: null, name: null };
  const [p] = acc.projectId ? await db.select({ m: projects.managerId }).from(projects).where(eq(projects.id, acc.projectId)) : [];
  return { type: "PROJECT_MANAGER", permission: "accidents.update", userId: p?.m ?? null, name: await nameOf(p?.m ?? null) };
}

/** Tells whoever has to act that the case came back, with the reason in the case itself (the title stays generic). */
async function notifyReturned(tx: DbOrTx, acc: Case, actorId: string): Promise<void> {
  const [fresh] = await tx.select().from(accidents).where(eq(accidents.id, acc.id));
  const need = await requiredActionFor(tx, fresh!);
  let userIds: string[] = [];
  if (need?.type === "USER" && need.userId) userIds = [need.userId];
  else if (need?.type === "PROJECT_MANAGER") userIds = await accidentRecipients(tx, acc.organizationId, acc.projectId);
  else if (need?.type === "ROLE") userIds = await permissionHolders(tx, acc.organizationId, "accidents.close", acc.projectId, { includeAllScope: true });
  await notifyUsers(tx, { orgId: acc.organizationId, userIds: userIds.filter((u) => u !== actorId), type: "ACCIDENT_CASE_RETURNED", title: tr("أُعيد الحادث {0} للاستكمال", accLabel(acc.number)), link: `/accidents/${acc.id}`, entityType: "accident", entityId: acc.id });
}

export type MoveOptions = { reason?: string | null; resolution?: string | null };

/**
 * The one place a case changes stage. The caller has locked the row, checked who may act and the stage requirements.
 * Validates the move with the state machine, then in this transaction: writes the transition log, the legacy status
 * mirror, the assignment for the new stage, the vehicle effect (submit flags it, close restores it, reopen flags it
 * again), the audit row and the notification.
 */
export async function moveStage(tx: DbOrTx, req: Request, access: Access, acc: Case, to: WorkflowStage, opts: MoveOptions = {}): Promise<{ kind: TransitionKind }> {
  const from = stageOf(acc);
  const r = evaluateTransition({ from, to, returnedTo: acc.returnedToStage as WorkflowStage | null, reason: opts.reason });
  if (!r.ok) throw new HttpError(409, "INVALID_TRANSITION", r.error);
  const at = now();
  const closing = to === "CLOSED";
  await tx
    .update(accidents)
    .set({
      workflowStage: to,
      status: legacyStatusFor(to),
      stageEnteredAt: at,
      updatedAt: at,
      closedAt: closing ? at : null,
      closedBy: closing ? access.userId : null,
      ...(opts.resolution ? { resolution: opts.resolution } : {}),
      // "Returned for completion" marker: set by a return or reopen, cleared by the next forward move.
      ...(r.kind === "RETURN" || r.kind === "REOPEN"
        ? { returnedToStage: to, returnedReason: opts.reason ?? null, returnedAt: at, returnedBy: access.userId }
        : { returnedToStage: null, returnedReason: null, returnedAt: null, returnedBy: null }),
    })
    .where(eq(accidents.id, acc.id));
  await tx.insert(accidentTransitions).values({ organizationId: acc.organizationId, accidentId: acc.id, fromStage: from, toStage: to, actorId: access.userId, reason: opts.reason ?? null });

  // Assignment follows the stage family: same family keeps the officer, a new family runs the engine, other stages clear it.
  const fromFamily = stageFamily(from);
  const toFamily = stageFamily(to);
  if (!toFamily) await tx.update(accidents).set({ assignedTo: null, assignmentMode: null }).where(eq(accidents.id, acc.id));
  else if (!(fromFamily === toFamily && acc.assignedTo)) await assignOnEntry(tx, req, acc, to, toFamily);

  if (from === "DRAFT") await flagVehicle(tx, req, acc);
  if (r.kind === "REOPEN") await flagVehicle(tx, req, acc);
  if (closing) {
    const [fresh] = await tx.select().from(accidents).where(eq(accidents.id, acc.id));
    await restoreVehicle(tx, req, fresh!);
  }

  if (r.kind === "RETURN" || r.kind === "REOPEN") await notifyReturned(tx, acc, access.userId);
  await audit(tx, req, { action: "ACCIDENT_CASE_STAGE_CHANGED", entity: "accident", entityId: acc.id, projectId: acc.projectId, vehicleId: acc.vehicleId, metadata: { label: accLabel(acc.number), fromStage: from, toStage: to, kind: r.kind, ...(opts.reason ? { reason: opts.reason } : {}) } });
  const recipients = [acc.createdBy, acc.reportedBy].filter((u): u is string => !!u && u !== access.userId);
  await notifyUsers(tx, { orgId: acc.organizationId, userIds: recipients, type: "ACCIDENT_CASE_STAGE", title: tr("تغيرت مرحلة الحادث {0}", accLabel(acc.number)), link: `/accidents/${acc.id}`, entityType: "accident", entityId: acc.id });
  return { kind: r.kind };
}
