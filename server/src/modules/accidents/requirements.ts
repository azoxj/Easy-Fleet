import { REQUIRED_FOR_SUBMIT } from "./attachments-policy.js";
import type { WorkflowStage } from "./workflow.js";

export type RepairDecision = "REPAIR" | "NOT_REPAIRABLE" | "NOT_NEEDED";
export type ClaimStatus = "PREPARING" | "FILED" | "PROCESSING" | "APPROVED" | "REJECTED" | "COMPENSATION_RECEIVED";

export type CaseFacts = {
  /** Categories of the attachments that are not superseded. */
  attachmentCategories: readonly string[];
  damageDescription: string | null;
  technicalNotes: string | null;
  /** The technician's decision; closure needs its documentation or its reasoning. */
  repairDecision: RepairDecision | null;
  estimates: readonly { selected: boolean }[];
  claim: { status: ClaimStatus; insurerName: string | null; claimNumber: string | null; filedAt: Date | null; rejectionReason: string | null; receivedAmount: string | null } | null;
  resolution: string | null;
};

const blank = (v: string | null | undefined) => !v || v.trim().length === 0;
const hasDoc = (f: CaseFacts, c: string) => f.attachmentCategories.includes(c);

/** Machine-readable reasons a move is not yet allowed (empty = requirements met). */
export function missingForTransition(from: WorkflowStage, to: WorkflowStage, f: CaseFacts): string[] {
  const miss: string[] = [];
  const need = (ok: boolean, code: string) => {
    if (!ok) miss.push(code);
  };
  const key = `${from}>${to}`;
  switch (key) {
    case "DRAFT>AWAITING_TECHNICAL":
      for (const c of REQUIRED_FOR_SUBMIT) need(hasDoc(f, c), `attachment:${c}`);
      break;
    case "AWAITING_TECHNICAL>AWAITING_ESTIMATES":
      need(!blank(f.damageDescription), "technical.damageDescription");
      need(f.repairDecision !== null, "technical.repairDecision");
      if (f.repairDecision !== null) need(f.repairDecision === "REPAIR", "technical.repair");
      break;
    case "AWAITING_TECHNICAL>AWAITING_INSURANCE":
      // Skipping the estimates is only for a vehicle that is not repairable or needs no repair, and the decision is explained.
      need(!blank(f.damageDescription), "technical.damageDescription");
      need(f.repairDecision === "NOT_REPAIRABLE" || f.repairDecision === "NOT_NEEDED", "technical.no_repair_decision");
      need(!blank(f.technicalNotes), "technical.notes");
      break;
    case "AWAITING_ESTIMATES>AWAITING_INSURANCE":
      need(f.estimates.length > 0, "estimates.none");
      need(f.estimates.filter((e) => e.selected).length === 1, "estimates.selected");
      break;
    case "AWAITING_INSURANCE>CLAIM_IN_PROGRESS":
      need(!!f.claim, "claim.missing");
      if (f.claim) need(!blank(f.claim.insurerName) && !blank(f.claim.claimNumber) && !!f.claim.filedAt, "claim.details");
      break;
    case "CLAIM_IN_PROGRESS>AWAITING_COMPENSATION_PROOF":
      need(f.claim?.status === "APPROVED", "claim.approved");
      break;
    case "CLAIM_IN_PROGRESS>AWAITING_FINAL_CLOSURE":
      need(f.claim?.status === "REJECTED", "claim.rejected");
      need(!blank(f.claim?.rejectionReason), "claim.rejectionReason");
      need(hasDoc(f, "INSURER_DECISION"), "attachment:INSURER_DECISION");
      break;
    case "AWAITING_COMPENSATION_PROOF>AWAITING_FINAL_CLOSURE":
      need(f.claim?.status === "COMPENSATION_RECEIVED", "claim.compensation_received");
      need(!blank(f.claim?.receivedAmount), "claim.receivedAmount");
      need(hasDoc(f, "COMPENSATION_PROOF"), "attachment:COMPENSATION_PROOF");
      break;
    case "AWAITING_FINAL_CLOSURE>CLOSED":
      need(!blank(f.resolution), "resolution");
      // A finished claim is not enough: the repair is documented, or the technical decision not to repair is explained.
      need(f.claim?.status === "REJECTED" || f.claim?.status === "COMPENSATION_RECEIVED", "claim.terminal");
      need(f.repairDecision !== null, "repair.decision");
      if (f.repairDecision === "REPAIR") need(hasDoc(f, "REPAIR_INVOICE") || hasDoc(f, "REPAIR_COMPLETION"), "repair.documentation");
      if (f.repairDecision === "NOT_REPAIRABLE" || f.repairDecision === "NOT_NEEDED") need(!blank(f.technicalNotes) && !blank(f.damageDescription), "technical.notes");
      break;
    default:
      break;
  }
  return miss;
}

/** Claim status graph (the stage follows automatically for APPROVED / REJECTED / COMPENSATION_RECEIVED). */
export const CLAIM_FLOW: Record<ClaimStatus, ClaimStatus[]> = {
  PREPARING: ["FILED"],
  FILED: ["PROCESSING", "APPROVED", "REJECTED"],
  PROCESSING: ["APPROVED", "REJECTED"],
  APPROVED: ["COMPENSATION_RECEIVED"],
  REJECTED: [],
  COMPENSATION_RECEIVED: [],
};

/** Stage the case moves to when the claim reaches this status (null = stays). */
export const STAGE_AFTER_CLAIM: Partial<Record<ClaimStatus, WorkflowStage>> = {
  APPROVED: "AWAITING_COMPENSATION_PROOF",
  REJECTED: "AWAITING_FINAL_CLOSURE",
  COMPENSATION_RECEIVED: "AWAITING_FINAL_CLOSURE",
};

/** What a claim status change needs before it is accepted. */
export function missingForClaimStatus(next: ClaimStatus, input: { reason?: string | null; receivedAmount?: string | null; approvedAmount?: string | null }, f: CaseFacts): string[] {
  const miss: string[] = [];
  if (next === "REJECTED") {
    if (blank(input.reason)) miss.push("claim.rejectionReason");
    if (!hasDoc(f, "INSURER_DECISION")) miss.push("attachment:INSURER_DECISION");
  }
  if (next === "COMPENSATION_RECEIVED") {
    if (blank(input.receivedAmount)) miss.push("claim.receivedAmount");
    if (!hasDoc(f, "COMPENSATION_PROOF")) miss.push("attachment:COMPENSATION_PROOF");
  }
  return miss;
}
