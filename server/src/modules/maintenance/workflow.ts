import type { Access } from "../../auth/access.js";
import { canOnMaintenance } from "../../auth/access.js";
import type { PermissionKey } from "../../auth/permissions.js";
import type { AuditAction } from "../../services/audit.js";

/**
 * Maintenance state machine — the ONLY place that defines which status may
 * follow which. Clients never send a status: they call an action endpoint and
 * the server derives the next state from this table.
 *
 * REQUESTED → INSPECTION → QUOTE_PENDING → PENDING_APPROVAL → APPROVED → IN_REPAIR
 *   → READY_FOR_HANDOVER → ACCEPTED → CLOSED
 *   READY_FOR_HANDOVER --reject handover (reason)--> IN_REPAIR
 *   REQUESTED | INSPECTION | QUOTE_PENDING | PENDING_APPROVAL --reject (reason)--> REJECTED (terminal)
 * System-only transitions (triggered by quote actions, never callable directly):
 *   QUOTE_PENDING → PENDING_APPROVAL   when a quote is submitted
 *   PENDING_APPROVAL → QUOTE_PENDING   when the last open quote is rejected
 */
export type MaintenanceStatus =
  | "REQUESTED"
  | "INSPECTION"
  | "QUOTE_PENDING"
  | "PENDING_APPROVAL"
  | "APPROVED"
  | "IN_REPAIR"
  | "READY_FOR_HANDOVER"
  | "ACCEPTED"
  | "REJECTED"
  | "CLOSED";

export type ActionKey =
  | "startInspection"
  | "completeInspection"
  | "approve"
  | "reject"
  | "startRepair"
  | "markReady"
  | "acceptHandover"
  | "rejectHandover"
  | "close";

type ActionDef = {
  from: MaintenanceStatus[];
  to: MaintenanceStatus;
  perm: PermissionKey;
  audit: AuditAction;
  event: string;
  requiresReason?: boolean;
};

export const ACTIONS: Record<ActionKey, ActionDef> = {
  startInspection: { from: ["REQUESTED"], to: "INSPECTION", perm: "maintenance.update", audit: "MAINTENANCE_INSPECTION_STARTED", event: "INSPECTION_STARTED" },
  completeInspection: { from: ["INSPECTION"], to: "QUOTE_PENDING", perm: "maintenance.update", audit: "MAINTENANCE_INSPECTION_COMPLETED", event: "INSPECTION_COMPLETED" },
  approve: { from: ["PENDING_APPROVAL"], to: "APPROVED", perm: "maintenance.approve", audit: "MAINTENANCE_APPROVED", event: "APPROVED" },
  reject: {
    from: ["REQUESTED", "INSPECTION", "QUOTE_PENDING", "PENDING_APPROVAL"],
    to: "REJECTED",
    perm: "maintenance.reject",
    audit: "MAINTENANCE_REJECTED",
    event: "REJECTED",
    requiresReason: true,
  },
  startRepair: { from: ["APPROVED"], to: "IN_REPAIR", perm: "maintenance.update", audit: "MAINTENANCE_REPAIR_STARTED", event: "REPAIR_STARTED" },
  markReady: { from: ["IN_REPAIR"], to: "READY_FOR_HANDOVER", perm: "maintenance.update", audit: "MAINTENANCE_READY_FOR_HANDOVER", event: "READY_FOR_HANDOVER" },
  acceptHandover: { from: ["READY_FOR_HANDOVER"], to: "ACCEPTED", perm: "maintenance.handover", audit: "MAINTENANCE_HANDOVER_ACCEPTED", event: "HANDOVER_ACCEPTED" },
  rejectHandover: {
    from: ["READY_FOR_HANDOVER"],
    to: "IN_REPAIR",
    perm: "maintenance.handover",
    audit: "MAINTENANCE_HANDOVER_REJECTED",
    event: "HANDOVER_REJECTED",
    requiresReason: true,
  },
  close: { from: ["ACCEPTED"], to: "CLOSED", perm: "maintenance.close", audit: "MAINTENANCE_CLOSED", event: "CLOSED" },
};

export const TERMINAL: MaintenanceStatus[] = ["CLOSED", "REJECTED"];
export const OPEN_STATUSES: MaintenanceStatus[] = ["REQUESTED", "INSPECTION", "QUOTE_PENDING", "PENDING_APPROVAL", "APPROVED", "IN_REPAIR", "READY_FOR_HANDOVER", "ACCEPTED"];
/** States where the technician may still be (re)assigned. */
export const ASSIGNABLE: MaintenanceStatus[] = ["REQUESTED", "INSPECTION", "QUOTE_PENDING", "PENDING_APPROVAL", "APPROVED", "IN_REPAIR"];
/** States where parts and labor may be recorded. */
export const COST_EDITABLE: MaintenanceStatus[] = ["INSPECTION", "QUOTE_PENDING", "PENDING_APPROVAL", "APPROVED", "IN_REPAIR"];
/** States where quotes may be created / submitted. */
export const QUOTE_OPEN: MaintenanceStatus[] = ["QUOTE_PENDING", "PENDING_APPROVAL"];

/** Field → states in which it may be edited through PATCH. */
export const EDITABLE_FIELDS: Record<string, MaintenanceStatus[]> = {
  issue: ["REQUESTED", "INSPECTION"],
  description: ["REQUESTED", "INSPECTION"],
  priority: ["REQUESTED", "INSPECTION", "QUOTE_PENDING", "PENDING_APPROVAL", "APPROVED", "IN_REPAIR"],
  odometer: ["REQUESTED", "INSPECTION"],
  diagnosis: ["INSPECTION", "QUOTE_PENDING"],
  workPerformed: ["IN_REPAIR"],
  notes: OPEN_STATUSES,
};

export type RequestState = {
  status: MaintenanceStatus;
  projectId: string | null;
  assignedTo: string | null;
  diagnosis: string | null;
  workPerformed: string | null;
  hasApprovedQuote: boolean;
};

/**
 * Pre-conditions beyond the from-state. Returns an Arabic error message when
 * the action is not currently possible, else null.
 */
export function preconditionError(action: ActionKey, s: RequestState): string | null {
  switch (action) {
    case "completeInspection":
      if (!s.assignedTo) return "يجب إسناد فني قبل إنهاء الفحص";
      if (!s.diagnosis?.trim()) return "يجب إدخال التشخيص قبل إنهاء الفحص";
      return null;
    case "approve":
      return s.hasApprovedQuote ? null : "لا يمكن الاعتماد قبل اعتماد عرض سعر";
    case "startRepair":
      return s.assignedTo ? null : "يجب إسناد فني قبل بدء الإصلاح";
    case "markReady":
      return s.workPerformed?.trim() ? null : "يجب توثيق الأعمال المنفذة قبل التسليم";
    default:
      return null;
  }
}

/** Actions the caller may perform right now (drives the UI; the server re-checks on every call). */
export function availableActions(a: Access, s: RequestState, isAssigned: boolean): (ActionKey | "assign")[] {
  const out: (ActionKey | "assign")[] = [];
  if (ASSIGNABLE.includes(s.status) && canOnMaintenance(a, "maintenance.assign", s, isAssigned, "act")) out.push("assign");
  for (const [key, def] of Object.entries(ACTIONS) as [ActionKey, ActionDef][]) {
    if (!def.from.includes(s.status)) continue;
    if (!canOnMaintenance(a, def.perm, s, isAssigned, "act")) continue;
    out.push(key);
  }
  return out;
}
