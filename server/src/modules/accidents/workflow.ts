import { tr } from "../../i18n/index.js";

export type WorkflowStage =
  | "DRAFT"
  | "AWAITING_TECHNICAL"
  | "AWAITING_ESTIMATES"
  | "AWAITING_TECHNICAL_DECISION"
  | "REPAIR_IN_PROGRESS"
  | "AWAITING_INSURANCE"
  | "CLAIM_IN_PROGRESS"
  | "AWAITING_COMPENSATION_PROOF"
  | "AWAITING_FINAL_CLOSURE"
  | "CLOSED"
  | "RETURNED";

export type LegacyStatus = "OPEN" | "UNDER_REVIEW" | "INSURANCE" | "REPAIR" | "CLOSED";

export const WORKFLOW_STAGES: readonly WorkflowStage[] = [
  "DRAFT",
  "AWAITING_TECHNICAL",
  "AWAITING_ESTIMATES",
  "AWAITING_TECHNICAL_DECISION",
  "REPAIR_IN_PROGRESS",
  "AWAITING_INSURANCE",
  "CLAIM_IN_PROGRESS",
  "AWAITING_COMPENSATION_PROOF",
  "AWAITING_FINAL_CLOSURE",
  "CLOSED",
  "RETURNED",
];

/** Permission needed to move a case OUT of a stage forward. */
export const FORWARD_PERMISSION: Partial<Record<WorkflowStage, string>> = {
  // A driver can file the draft (accidents.create) but only whoever completes cases (accidents.update) submits it.
  DRAFT: "accidents.update",
  AWAITING_TECHNICAL: "accidents.review.technical",
  // The assigned technical officer uploads and selects repair estimates.
  AWAITING_ESTIMATES: "accidents.review.technical",
  AWAITING_TECHNICAL_DECISION: "accidents.review.technical",
  REPAIR_IN_PROGRESS: "accidents.review.technical",
  AWAITING_INSURANCE: "accidents.claims.manage",
  CLAIM_IN_PROGRESS: "accidents.claims.manage",
  AWAITING_COMPENSATION_PROOF: "accidents.claims.manage",
  AWAITING_FINAL_CLOSURE: "accidents.close",
};

/** Normal forward path. AWAITING_COMPENSATION_PROOF is skipped when no compensation is due (rejected claim / not repairable). */
const FORWARD: Partial<Record<WorkflowStage, WorkflowStage[]>> = {
  DRAFT: ["AWAITING_TECHNICAL"],
  AWAITING_TECHNICAL: ["AWAITING_ESTIMATES", "AWAITING_INSURANCE"],
  AWAITING_ESTIMATES: ["AWAITING_TECHNICAL_DECISION"],
  AWAITING_TECHNICAL_DECISION: ["AWAITING_INSURANCE", "REPAIR_IN_PROGRESS"],
  REPAIR_IN_PROGRESS: ["AWAITING_FINAL_CLOSURE"],
  AWAITING_INSURANCE: ["CLAIM_IN_PROGRESS"],
  CLAIM_IN_PROGRESS: ["AWAITING_COMPENSATION_PROOF", "REPAIR_IN_PROGRESS", "AWAITING_FINAL_CLOSURE"],
  AWAITING_COMPENSATION_PROOF: ["REPAIR_IN_PROGRESS", "AWAITING_FINAL_CLOSURE"],
  AWAITING_FINAL_CLOSURE: ["CLOSED"],
};

/** Stages a case can be sent back to (never DRAFT/CLOSED/RETURNED). */
export const RETURN_TARGETS: readonly WorkflowStage[] = [
  "AWAITING_TECHNICAL",
  "AWAITING_ESTIMATES",
  "AWAITING_INSURANCE",
  "CLAIM_IN_PROGRESS",
  "AWAITING_COMPENSATION_PROOF",
];

export type TransitionKind = "FORWARD" | "RETURN" | "RESUME" | "REOPEN";

export type TransitionInput = {
  from: WorkflowStage;
  to: WorkflowStage;
  /** Stage stored when the case was returned; RESUME must go back to it. */
  returnedTo?: WorkflowStage | null;
  reason?: string | null;
};

export type TransitionResult = { ok: true; kind: TransitionKind } | { ok: false; error: string };

const fail = (error: string): TransitionResult => ({ ok: false, error });

export function evaluateTransition(i: TransitionInput): TransitionResult {
  const { from, to } = i;
  const reason = i.reason?.trim() ?? "";
  if (from === to) return fail(tr("الحادث موجود في هذه المرحلة بالفعل"));

  if (from === "CLOSED") {
    // Only an explicit reopen with a reason; it re-enters at the final closure stage.
    if (to !== "AWAITING_FINAL_CLOSURE" && !RETURN_TARGETS.includes(to)) return fail(tr("انتقال غير مسموح بين مراحل الحادث"));
    if (!reason) return fail(tr("سبب إعادة الفتح مطلوب"));
    return { ok: true, kind: "REOPEN" };
  }

  if (from === "RETURNED") {
    if (!i.returnedTo || to !== i.returnedTo) return fail(tr("يجب استئناف الحادث من المرحلة التي أُرجع إليها"));
    return { ok: true, kind: "RESUME" };
  }

  if (to === "RETURNED") {
    return fail(tr("انتقال غير مسموح بين مراحل الحادث"));
  }

  if (FORWARD[from]?.includes(to)) return { ok: true, kind: "FORWARD" };

  if (RETURN_TARGETS.includes(to) && from !== "DRAFT") {
    if (WORKFLOW_STAGES.indexOf(to) < WORKFLOW_STAGES.indexOf(from)) {
      if (!reason) return fail(tr("سبب الإرجاع مطلوب"));
      return { ok: true, kind: "RETURN" };
    }
  }
  return fail(tr("انتقال غير مسموح بين مراحل الحادث"));
}

/** Permission that must be held to perform the transition. */
export function requiredPermission(from: WorkflowStage, kind: TransitionKind): string | null {
  if (kind === "RETURN" || kind === "REOPEN") return "accidents.reopen";
  if (kind === "RESUME") return "accidents.assign";
  return FORWARD_PERMISSION[from] ?? null;
}

/**
 * Legacy status shown for rows in the new flow, so dashboards, reports and the
 * vehicle-restore logic that read `accidents.status` keep working.
 */
export function legacyStatusFor(stage: WorkflowStage): LegacyStatus {
  switch (stage) {
    case "DRAFT":
      return "OPEN";
    case "AWAITING_TECHNICAL":
    case "AWAITING_ESTIMATES":
    case "AWAITING_TECHNICAL_DECISION":
    case "AWAITING_FINAL_CLOSURE":
    case "RETURNED":
      return "UNDER_REVIEW";
    case "REPAIR_IN_PROGRESS":
      return "REPAIR";
    case "AWAITING_INSURANCE":
    case "CLAIM_IN_PROGRESS":
    case "AWAITING_COMPENSATION_PROOF":
      return "INSURANCE";
    case "CLOSED":
      return "CLOSED";
  }
}

/** A case counts as an "open accident" when it is neither closed nor an unsubmitted draft. */
export function isOpenAccident(row: { status: LegacyStatus; workflowStage: WorkflowStage | null }): boolean {
  return row.status !== "CLOSED" && row.workflowStage !== "DRAFT";
}

/** Stage whose SLA clock applies, and which setting holds its days. */
export const SLA_FIELD: Partial<Record<WorkflowStage, "slaTechnicalDays" | "slaEstimatesDays" | "slaInsuranceDays" | "slaClosureDays">> = {
  AWAITING_TECHNICAL: "slaTechnicalDays",
  AWAITING_ESTIMATES: "slaEstimatesDays",
  AWAITING_TECHNICAL_DECISION: "slaTechnicalDays",
  REPAIR_IN_PROGRESS: "slaClosureDays",
  AWAITING_INSURANCE: "slaInsuranceDays",
  CLAIM_IN_PROGRESS: "slaInsuranceDays",
  AWAITING_COMPENSATION_PROOF: "slaInsuranceDays",
  AWAITING_FINAL_CLOSURE: "slaClosureDays",
};

export const DEFAULT_SLA_DAYS = { slaTechnicalDays: 3, slaEstimatesDays: 5, slaInsuranceDays: 7, slaClosureDays: 3 } as const;
export type SlaDays = { [K in keyof typeof DEFAULT_SLA_DAYS]: number };

/** Calendar days (not business days): due = entered + N × 24h. */
export function slaDueAt(stage: WorkflowStage, enteredAt: Date, sla: SlaDays = DEFAULT_SLA_DAYS): Date | null {
  const f = SLA_FIELD[stage];
  if (!f) return null;
  return new Date(enteredAt.getTime() + sla[f] * 24 * 60 * 60 * 1000);
}

export function isOverdue(stage: WorkflowStage, enteredAt: Date, now: Date, sla: SlaDays = DEFAULT_SLA_DAYS): boolean {
  const due = slaDueAt(stage, enteredAt, sla);
  return due !== null && now.getTime() > due.getTime();
}
