import type { Tone } from "./labels";
import { t } from "../i18n";

type LabelMap = Record<string, { label: string; tone: Tone }>;

export const MAINTENANCE_STATUS: LabelMap = {
  REQUESTED: { get label() { return t("enums.maintenanceStatus.REQUESTED"); }, tone: "slate" },
  INSPECTION: { get label() { return t("enums.maintenanceStatus.INSPECTION"); }, tone: "blue" },
  QUOTE_PENDING: { get label() { return t("enums.maintenanceStatus.QUOTE_PENDING"); }, tone: "amber" },
  PENDING_APPROVAL: { get label() { return t("enums.maintenanceStatus.PENDING_APPROVAL"); }, tone: "amber" },
  APPROVED: { get label() { return t("enums.maintenanceStatus.APPROVED"); }, tone: "green" },
  IN_REPAIR: { get label() { return t("enums.maintenanceStatus.IN_REPAIR"); }, tone: "blue" },
  READY_FOR_HANDOVER: { get label() { return t("enums.maintenanceStatus.READY_FOR_HANDOVER"); }, tone: "green" },
  ACCEPTED: { get label() { return t("enums.maintenanceStatus.ACCEPTED"); }, tone: "green" },
  REJECTED: { get label() { return t("enums.maintenanceStatus.REJECTED"); }, tone: "red" },
  CLOSED: { get label() { return t("enums.maintenanceStatus.CLOSED"); }, tone: "gray" },
};

export const MAINTENANCE_PRIORITY: LabelMap = {
  LOW: { get label() { return t("enums.maintenancePriority.LOW"); }, tone: "slate" },
  MEDIUM: { get label() { return t("enums.maintenancePriority.MEDIUM"); }, tone: "blue" },
  HIGH: { get label() { return t("enums.maintenancePriority.HIGH"); }, tone: "amber" },
  CRITICAL: { get label() { return t("enums.maintenancePriority.CRITICAL"); }, tone: "red" },
};

export const QUOTE_STATUS: LabelMap = {
  DRAFT: { get label() { return t("enums.quoteStatus.DRAFT"); }, tone: "slate" },
  SUBMITTED: { get label() { return t("enums.quoteStatus.SUBMITTED"); }, tone: "blue" },
  UNDER_REVIEW: { get label() { return t("enums.quoteStatus.UNDER_REVIEW"); }, tone: "blue" },
  APPROVED: { get label() { return t("enums.quoteStatus.APPROVED"); }, tone: "green" },
  REJECTED: { get label() { return t("enums.quoteStatus.REJECTED"); }, tone: "red" },
};

export const ATTACHMENT_CATEGORY: Record<string, string> = {
  get DAMAGE_PHOTO() { return t("enums.attachmentCategory.DAMAGE_PHOTO"); },
  get INSPECTION_REPORT() { return t("enums.attachmentCategory.INSPECTION_REPORT"); },
  get QUOTE() { return t("enums.attachmentCategory.QUOTE"); },
  get INVOICE() { return t("enums.attachmentCategory.INVOICE"); },
  get REPAIR_PHOTO() { return t("enums.attachmentCategory.REPAIR_PHOTO"); },
  get OTHER() { return t("enums.attachmentCategory.OTHER"); },
};

/** Server action keys → button labels. The list of actions itself always comes from the server. */
export const ACTION_LABEL: Record<string, string> = {
  get assign() { return t("labels.actionLabel.assign"); },
  get startInspection() { return t("labels.actionLabel.startInspection"); },
  get completeInspection() { return t("labels.actionLabel.completeInspection"); },
  get approve() { return t("labels.actionLabel.approve"); },
  get reject() { return t("labels.actionLabel.reject"); },
  get startRepair() { return t("labels.actionLabel.startRepair"); },
  get markReady() { return t("labels.actionLabel.markReady"); },
  get acceptHandover() { return t("labels.actionLabel.acceptHandover"); },
  get rejectHandover() { return t("labels.actionLabel.rejectHandover"); },
  get close() { return t("labels.actionLabel.close"); },
};

export const ACTION_PATH: Record<string, string> = {
  startInspection: "start-inspection",
  completeInspection: "complete-inspection",
  approve: "approve",
  reject: "reject",
  startRepair: "start-repair",
  markReady: "mark-ready",
  acceptHandover: "accept-handover",
  rejectHandover: "reject-handover",
  close: "close",
};

export const REASON_ACTIONS = new Set(["reject", "rejectHandover"]);
export const DANGER_ACTIONS = new Set(["reject", "rejectHandover"]);

export const EVENT_LABEL: Record<string, string> = {
  get CREATED() { return t("enums.eventLabel.CREATED"); },
  get ASSIGNED() { return t("enums.eventLabel.ASSIGNED"); },
  get UPDATED() { return t("enums.eventLabel.UPDATED"); },
  get DIAGNOSIS_UPDATED() { return t("enums.eventLabel.DIAGNOSIS_UPDATED"); },
  get WORK_UPDATED() { return t("enums.eventLabel.WORK_UPDATED"); },
  get INSPECTION_STARTED() { return t("enums.eventLabel.INSPECTION_STARTED"); },
  get INSPECTION_COMPLETED() { return t("enums.eventLabel.INSPECTION_COMPLETED"); },
  get QUOTE_CREATED() { return t("enums.eventLabel.QUOTE_CREATED"); },
  get QUOTE_SUBMITTED() { return t("enums.eventLabel.QUOTE_SUBMITTED"); },
  get QUOTE_REVIEW_STARTED() { return t("enums.eventLabel.QUOTE_REVIEW_STARTED"); },
  get QUOTE_APPROVED() { return t("enums.eventLabel.QUOTE_APPROVED"); },
  get QUOTE_REJECTED() { return t("enums.eventLabel.QUOTE_REJECTED"); },
  get STATUS_CHANGED() { return t("enums.eventLabel.STATUS_CHANGED"); },
  get APPROVED() { return t("enums.eventLabel.APPROVED"); },
  get REJECTED() { return t("enums.eventLabel.REJECTED"); },
  get REPAIR_STARTED() { return t("enums.eventLabel.REPAIR_STARTED"); },
  get READY_FOR_HANDOVER() { return t("enums.eventLabel.READY_FOR_HANDOVER"); },
  get HANDOVER_ACCEPTED() { return t("enums.eventLabel.HANDOVER_ACCEPTED"); },
  get HANDOVER_REJECTED() { return t("enums.eventLabel.HANDOVER_REJECTED"); },
  get CLOSED() { return t("enums.eventLabel.CLOSED"); },
  get PART_ADDED() { return t("enums.eventLabel.PART_ADDED"); },
  get PART_UPDATED() { return t("enums.eventLabel.PART_UPDATED"); },
  get PART_REMOVED() { return t("enums.eventLabel.PART_REMOVED"); },
  get LABOR_ADDED() { return t("enums.eventLabel.LABOR_ADDED"); },
  get LABOR_UPDATED() { return t("enums.eventLabel.LABOR_UPDATED"); },
  get LABOR_REMOVED() { return t("enums.eventLabel.LABOR_REMOVED"); },
  get ATTACHMENT_ADDED() { return t("enums.eventLabel.ATTACHMENT_ADDED"); },
};

/** Main path shown as a stepper. REJECTED is shown separately. */
export const STEPS = ["REQUESTED", "INSPECTION", "QUOTE_PENDING", "PENDING_APPROVAL", "APPROVED", "IN_REPAIR", "READY_FOR_HANDOVER", "CLOSED"] as const;

export function stepIndex(status: string): number {
  if (status === "ACCEPTED") return STEPS.indexOf("CLOSED") - 0.5;
  const i = (STEPS as readonly string[]).indexOf(status);
  return i;
}

export const mrNumber = (n: number) => `MR-${n}`;

// ------------------------------------------------------------------ client-side validation
// (UX only — the server re-validates everything.)

const MONEY = /^\d{1,12}(\.\d{1,2})?$/;
const DECIMAL = /^\d{1,8}(\.\d{1,2})?$/;

export function validateCreate(v: { vehicleId: string; issue: string; priority: string; odometer: string }) {
  const e: Record<string, string> = {};
  if (!v.vehicleId) e.vehicleId = t("common.selectAVehicle2");
  if (v.issue.trim().length < 3) e.issue = t("maintenance.issueDescriptionIsRequiredAt");
  if (!v.priority) e.priority = t("maintenance.priorityIsRequired");
  if (v.odometer.trim() && (!/^\d+$/.test(v.odometer.trim()) || Number(v.odometer) < 0)) e.odometer = t("maintenance.odometerMustBeAWhole");
  return e;
}

export function validatePart(v: { partName: string; quantity: string; unitPrice: string }) {
  const e: Record<string, string> = {};
  if (v.partName.trim().length < 2) e.partName = t("maintenance.partNameIsRequired");
  if (!DECIMAL.test(v.quantity.trim()) || Number(v.quantity) <= 0) e.quantity = t("maintenance.quantityMustBeGreaterThan");
  if (!MONEY.test(v.unitPrice.trim())) e.unitPrice = t("maintenance.invalidPrice0");
  return e;
}

export function validateLabor(v: { description: string; hours: string; hourlyRate: string }) {
  const e: Record<string, string> = {};
  if (v.description.trim().length < 2) e.description = t("maintenance.descriptionIsRequired");
  if (!DECIMAL.test(v.hours.trim()) || Number(v.hours) <= 0 || Number(v.hours) > 1000) e.hours = t("maintenance.hoursMustBeGreaterThan");
  if (!MONEY.test(v.hourlyRate.trim())) e.hourlyRate = t("maintenance.invalidPrice0");
  return e;
}

export function validateQuote(v: { amount: string; validUntil: string }, todayIso: string) {
  const e: Record<string, string> = {};
  if (!MONEY.test(v.amount.trim())) e.amount = t("maintenance.amountIsRequired0");
  if (v.validUntil && !/^\d{4}-\d{2}-\d{2}$/.test(v.validUntil)) e.validUntil = t("maintenance.invalidDate");
  else if (v.validUntil && v.validUntil < todayIso) e.validUntil = t("maintenance.cannotBeInThePast");
  return e;
}

export function validateReason(reason: string) {
  return reason.trim().length >= 3 ? null : t("maintenance.reasonIsRequiredAtLeast");
}

/** Money sum as string, avoiding float drift by working in halalas. */
export function sumMoney(values: (string | null | undefined)[]): string {
  const cents = values.reduce((a, v) => a + Math.round(Number(v ?? 0) * 100), 0);
  return (cents / 100).toFixed(2);
}
