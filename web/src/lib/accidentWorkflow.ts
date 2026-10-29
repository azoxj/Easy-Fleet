import { t } from "../i18n";
import type { Tone } from "./labels";

/**
 * Accident case workflow: types of what the server sends, the labels, and the small pure rules of the screen.
 * Nothing here decides what a user may do: the server sends `actions`, `requirements` and `uploadCategories`,
 * and re-checks every request. These helpers only decide how to show them.
 */

export type WorkflowStage =
  | "DRAFT"
  | "AWAITING_TECHNICAL"
  | "AWAITING_ESTIMATES"
  | "AWAITING_INSURANCE"
  | "CLAIM_IN_PROGRESS"
  | "AWAITING_COMPENSATION_PROOF"
  | "AWAITING_FINAL_CLOSURE"
  | "CLOSED"
  | "RETURNED";

export const STAGES: WorkflowStage[] = ["DRAFT", "AWAITING_TECHNICAL", "AWAITING_ESTIMATES", "AWAITING_INSURANCE", "CLAIM_IN_PROGRESS", "AWAITING_COMPENSATION_PROOF", "AWAITING_FINAL_CLOSURE", "CLOSED", "RETURNED"];

export type RepairDecision = "REPAIR" | "NOT_REPAIRABLE" | "NOT_NEEDED";
export type ClaimStatus = "PREPARING" | "FILED" | "PROCESSING" | "APPROVED" | "REJECTED" | "COMPENSATION_RECEIVED";

export type RequiredAction = { type: "USER" | "QUEUE" | "PROJECT_MANAGER" | "ROLE"; permission: string; userId: string | null; name: string | null };
export type ReturnedInfo = { stage: WorkflowStage; reason: string | null; returnedAt: string; returnedBy: { id: string; name: string } | null; requiredAction: RequiredAction | null };

export type CaseAttachment = { id: string; category: string; stage: WorkflowStage | null; supersededAt: string | null; fileName: string; mimeType: string; sizeBytes: number; createdAt: string };
export type CaseEstimate = { id: string; vendorName: string; amount: string; notes: string | null; attachmentId: string | null; selected: boolean; createdAt: string };
export type CaseClaim = { id: string; status: ClaimStatus; insurerName: string | null; claimNumber: string | null; claimedAmount: string | null; approvedAmount: string | null; receivedAmount: string | null; rejectionReason: string | null; filedAt: string | null; decidedAt: string | null; receivedAt: string | null };
export type CaseTransition = { id: string; fromStage: WorkflowStage | null; toStage: WorkflowStage; reason: string | null; createdAt: string; actorName: string | null };
export type CaseAssignment = { id: string; stage: WorkflowStage; mode: "AUTO" | "MANUAL" | "QUEUE"; reason: string | null; createdAt: string; assignedToName: string | null; assignedByName: string | null };

export type CaseDetail = {
  id: string;
  number: number;
  label: string;
  vehicleId: string;
  plateNumber: string;
  vehicleStatus: string;
  projectId: string | null;
  projectName: string | null;
  driverName: string | null;
  createdBy: string;
  createdByName: string;
  reportedBy: string | null;
  assignedTo: string | null;
  assignedToName: string | null;
  assignmentMode: "AUTO" | "MANUAL" | "QUEUE" | null;
  occurredAt: string;
  location: string | null;
  latitude: string | null;
  longitude: string | null;
  description: string;
  severity: string;
  responsibility: string;
  policeReportNumber: string | null;
  insuranceClaimNumber: string | null;
  repairCost: string | null;
  resolution: string | null;
  status: string;
  workflowStage: WorkflowStage;
  stageEnteredAt: string | null;
  damageDescription: string | null;
  technicalNotes: string | null;
  repairDecision: RepairDecision | null;
  slaDueAt: string | null;
  overdue: boolean;
  returnedForCompletion: ReturnedInfo | null;
  attachments: CaseAttachment[];
  estimates: CaseEstimate[];
  claim: CaseClaim | null;
  transitions: CaseTransition[];
  assignments: CaseAssignment[];
  actions: string[];
  requirements: { to: WorkflowStage; missing: string[] }[];
  uploadCategories: string[];
};

export const STAGE_TONE: Record<WorkflowStage, Tone> = {
  DRAFT: "gray",
  AWAITING_TECHNICAL: "blue",
  AWAITING_ESTIMATES: "violet",
  AWAITING_INSURANCE: "amber",
  CLAIM_IN_PROGRESS: "amber",
  AWAITING_COMPENSATION_PROOF: "amber",
  AWAITING_FINAL_CLOSURE: "green",
  CLOSED: "gray",
  RETURNED: "red",
};

export const stageLabel = (s: string): string => (STAGES.includes(s as WorkflowStage) ? t(`accidentFlow.stage.${s as WorkflowStage}`) : s);
export const nextActionLabel = (s: string): string => (STAGES.includes(s as WorkflowStage) ? t(`accidentFlow.nextAction.${s as WorkflowStage}`) : "—");

export const REPAIR_DECISIONS: RepairDecision[] = ["REPAIR", "NOT_REPAIRABLE", "NOT_NEEDED"];
export const repairDecisionLabel = (d: string | null): string => (d && (REPAIR_DECISIONS as string[]).includes(d) ? t(`accidentFlow.repair.${d as RepairDecision}`) : "—");

export const CLAIM_STATUSES: ClaimStatus[] = ["PREPARING", "FILED", "PROCESSING", "APPROVED", "REJECTED", "COMPENSATION_RECEIVED"];
export const claimStatusLabel = (s: string): string => ((CLAIM_STATUSES as string[]).includes(s) ? t(`accidentFlow.claimStatus.${s as ClaimStatus}`) : s);
export const CLAIM_TONE: Record<ClaimStatus, Tone> = { PREPARING: "gray", FILED: "blue", PROCESSING: "blue", APPROVED: "green", REJECTED: "red", COMPENSATION_RECEIVED: "green" };

/** The four documents without which a report cannot be submitted. */
export const REQUIRED_DOCS = ["NAJM_REPORT", "DRIVER_ID", "DRIVER_LICENSE", "VEHICLE_REGISTRATION"] as const;
export const DOC_CATEGORIES = ["NAJM_REPORT", "DRIVER_ID", "DRIVER_LICENSE", "VEHICLE_REGISTRATION", "POLICE_REPORT", "INSURANCE", "PHOTO", "ESTIMATE", "CLAIM_FORM", "INSURER_DECISION", "COMPENSATION_PROOF", "REPAIR_INVOICE", "REPAIR_COMPLETION", "OTHER"] as const;
export type DocCategory = (typeof DOC_CATEGORIES)[number];
export const docLabel = (c: string): string => ((DOC_CATEGORIES as readonly string[]).includes(c) ? t(`accidentFlow.doc.${c as DocCategory}`) : c);

/** A server requirement code ("attachment:DRIVER_ID", "estimates.none", …) as a sentence for the user. */
export function requirementText(code: string): string {
  if (code.startsWith("attachment:")) return t("accidentFlow.req.attachment", { doc: docLabel(code.slice("attachment:".length)) });
  const known = REQUIREMENT_CODES.find((c) => c === code);
  return known ? t(`accidentFlow.req.${known}`) : t("accidentFlow.req.unknown", { code });
}

export const REQUIREMENT_CODES = [
  "technical.damageDescription",
  "technical.repairDecision",
  "technical.repair",
  "technical.no_repair_decision",
  "technical.notes",
  "estimates.none",
  "estimates.selected",
  "claim.missing",
  "claim.details",
  "claim.approved",
  "claim.rejected",
  "claim.rejectionReason",
  "claim.compensation_received",
  "claim.receivedAmount",
  "claim.terminal",
  "resolution",
  "repair.decision",
  "repair.documentation",
] as const;

/** Missing items for the move to `to`, from what the server sent (empty when the step can be taken). */
export function missingFor(d: Pick<CaseDetail, "requirements">, to: WorkflowStage): string[] {
  return d.requirements.find((r) => r.to === to)?.missing ?? [];
}

/** For a draft: which of the four required documents are still missing, according to the server. */
export function missingDocuments(d: Pick<CaseDetail, "requirements">): string[] {
  return missingFor(d, "AWAITING_TECHNICAL").filter((c) => c.startsWith("attachment:")).map((c) => c.slice("attachment:".length));
}

/** Who has to act, in a sentence. */
export function requiredActorText(a: RequiredAction | null): string {
  if (!a) return "—";
  switch (a.type) {
    case "USER":
      return t("accidentFlow.who.USER", { name: a.name ?? "—" });
    case "QUEUE":
      return t("accidentFlow.who.QUEUE");
    case "PROJECT_MANAGER":
      return a.name ? t("accidentFlow.who.PROJECT_MANAGER_NAMED", { name: a.name }) : t("accidentFlow.who.PROJECT_MANAGER");
    case "ROLE":
      return t("accidentFlow.who.ROLE");
  }
}

export type AccidentTabKey = "all" | "reported" | "assigned" | "queue" | "returned" | "drafts" | "claims";

/**
 * The tabs of the accidents screen for this user. "All" always exists (the page itself needs accidents.read); the others belong to the
 * workflow and appear only when it is on and the user holds a permission that gives them something to do or see there.
 * (Hiding a tab is a convenience: the server refuses what the user may not do or see.)
 */
export function accidentTabs(can: (perm: string) => boolean, workflow: boolean): { key: AccidentTabKey; label: string }[] {
  const tabs: { key: AccidentTabKey; label: string }[] = [{ key: "all", label: t("accidentFlow.tab.all") }];
  if (!workflow) return tabs;
  const handles = can("accidents.update") || can("accidents.review.technical") || can("accidents.claims.manage") || can("accidents.assign") || can("accidents.close") || can("accidents.reopen");
  if (can("accidents.create")) tabs.push({ key: "reported", label: t("accidentFlow.tab.reported") });
  if (can("accidents.review.technical") || can("accidents.claims.manage")) tabs.push({ key: "assigned", label: t("accidentFlow.tab.assigned") });
  if (can("accidents.assign")) tabs.push({ key: "queue", label: t("accidentFlow.tab.queue") });
  if (handles) tabs.push({ key: "returned", label: t("accidentFlow.tab.returned") });
  if (can("accidents.create") || can("accidents.update") || can("accidents.assign") || can("accidents.close")) tabs.push({ key: "drafts", label: t("accidentFlow.tab.drafts") });
  if (can("accidents.claims.manage") || can("accidents.update") || can("accidents.assign") || can("accidents.close")) tabs.push({ key: "claims", label: t("accidentFlow.tab.claims") });
  return tabs;
}

export const isTabKey = (v: string | null): v is AccidentTabKey => v === "all" || v === "reported" || v === "assigned" || v === "queue" || v === "returned" || v === "drafts" || v === "claims";

/** Earlier stages a case can be sent back to (the server validates the move). */
export const RETURN_TARGETS: WorkflowStage[] = ["AWAITING_TECHNICAL", "AWAITING_ESTIMATES", "AWAITING_INSURANCE", "CLAIM_IN_PROGRESS", "AWAITING_COMPENSATION_PROOF"];
/** Stages a closed case can be reopened to. */
export const REOPEN_TARGETS: WorkflowStage[] = ["AWAITING_FINAL_CLOSURE", ...RETURN_TARGETS];
/** A return goes to an earlier stage than the current one. */
export const returnTargetsFrom = (stage: WorkflowStage): WorkflowStage[] => RETURN_TARGETS.filter((s) => STAGES.indexOf(s) < STAGES.indexOf(stage));

/** The details a case form sends. Empty optional fields are left out. */
export function draftBody(v: { vehicleId: string; driverId: string; occurredAt: string; location: string; description: string; severity: string; responsibility: string; policeReportNumber: string }, iso: (local: string) => string, geo: { lat: number; lng: number } | null) {
  return {
    vehicleId: v.vehicleId,
    occurredAt: iso(v.occurredAt),
    description: v.description.trim(),
    severity: v.severity,
    responsibility: v.responsibility,
    ...(v.driverId ? { driverId: v.driverId } : {}),
    ...(v.location.trim() ? { location: v.location.trim() } : {}),
    ...(v.policeReportNumber.trim() ? { policeReportNumber: v.policeReportNumber.trim() } : {}),
    ...(geo ? { latitude: geo.lat, longitude: geo.lng } : {}),
  };
}

/** Missing items carried by a 409 REQUIREMENTS_NOT_MET answer. */
export function missingFromError(err: unknown): string[] | null {
  const e = err as { code?: string; details?: { missing?: unknown } } | null;
  if (e?.code !== "REQUIREMENTS_NOT_MET") return null;
  const m = e.details?.missing;
  return Array.isArray(m) ? m.filter((x): x is string => typeof x === "string") : null;
}

/**
 * What is still missing for the step that is due now (shown with the "returned for completion" marker and above the step).
 * Where a stage has two possible next steps the one the case is heading for is used; with no way to tell, nothing is listed.
 */
export function pendingMissing(c: Pick<CaseDetail, "workflowStage" | "repairDecision" | "claim" | "requirements">): string[] {
  const stage = c.workflowStage;
  let to: WorkflowStage | null = null;
  switch (stage) {
    case "DRAFT":
      to = "AWAITING_TECHNICAL";
      break;
    case "AWAITING_TECHNICAL":
      to = c.repairDecision && c.repairDecision !== "REPAIR" ? "AWAITING_INSURANCE" : "AWAITING_ESTIMATES";
      break;
    case "AWAITING_ESTIMATES":
      to = "AWAITING_INSURANCE";
      break;
    case "AWAITING_INSURANCE":
      to = "CLAIM_IN_PROGRESS";
      break;
    case "CLAIM_IN_PROGRESS":
      to = c.claim?.status === "APPROVED" ? "AWAITING_COMPENSATION_PROOF" : c.claim?.status === "REJECTED" ? "AWAITING_FINAL_CLOSURE" : null;
      break;
    case "AWAITING_COMPENSATION_PROOF":
      to = "AWAITING_FINAL_CLOSURE";
      break;
    case "AWAITING_FINAL_CLOSURE":
      to = "CLOSED";
      break;
    default:
      to = null;
  }
  // The resolution is typed in the closing dialog itself.
  return to ? missingFor(c, to).filter((m) => m !== "resolution") : [];
}
