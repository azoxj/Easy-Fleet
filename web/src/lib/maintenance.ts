import type { Tone } from "./labels";

type LabelMap = Record<string, { label: string; tone: Tone }>;

export const MAINTENANCE_STATUS: LabelMap = {
  REQUESTED: { label: "مطلوبة", tone: "slate" },
  INSPECTION: { label: "قيد الفحص", tone: "blue" },
  QUOTE_PENDING: { label: "بانتظار عرض سعر", tone: "amber" },
  PENDING_APPROVAL: { label: "بانتظار الاعتماد", tone: "amber" },
  APPROVED: { label: "معتمدة", tone: "green" },
  IN_REPAIR: { label: "قيد الإصلاح", tone: "blue" },
  READY_FOR_HANDOVER: { label: "جاهزة للاستلام", tone: "green" },
  ACCEPTED: { label: "تم القبول", tone: "green" },
  REJECTED: { label: "مرفوضة", tone: "red" },
  CLOSED: { label: "مغلقة", tone: "gray" },
};

export const MAINTENANCE_PRIORITY: LabelMap = {
  LOW: { label: "منخفضة", tone: "slate" },
  MEDIUM: { label: "متوسطة", tone: "blue" },
  HIGH: { label: "عالية", tone: "amber" },
  CRITICAL: { label: "حرجة", tone: "red" },
};

export const QUOTE_STATUS: LabelMap = {
  DRAFT: { label: "مسودة", tone: "slate" },
  SUBMITTED: { label: "مقدَّم", tone: "blue" },
  UNDER_REVIEW: { label: "قيد المراجعة", tone: "blue" },
  APPROVED: { label: "معتمد", tone: "green" },
  REJECTED: { label: "مرفوض", tone: "red" },
};

export const ATTACHMENT_CATEGORY: Record<string, string> = {
  DAMAGE_PHOTO: "صور العطل",
  INSPECTION_REPORT: "تقرير الفحص",
  QUOTE: "عرض سعر",
  INVOICE: "فاتورة",
  REPAIR_PHOTO: "صور الإصلاح",
  OTHER: "أخرى",
};

/** Server action keys → button labels. The list of actions itself always comes from the server. */
export const ACTION_LABEL: Record<string, string> = {
  assign: "إسناد فني",
  startInspection: "بدء الفحص",
  completeInspection: "إنهاء الفحص وطلب عرض سعر",
  approve: "اعتماد التنفيذ",
  reject: "رفض الطلب",
  startRepair: "بدء الإصلاح",
  markReady: "جاهزة للاستلام",
  acceptHandover: "قبول الاستلام",
  rejectHandover: "رفض الاستلام",
  close: "إغلاق الطلب",
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
  CREATED: "إنشاء الطلب",
  ASSIGNED: "إسناد الفني",
  UPDATED: "تحديث البيانات",
  DIAGNOSIS_UPDATED: "تحديث التشخيص",
  WORK_UPDATED: "تحديث الأعمال المنفذة",
  INSPECTION_STARTED: "بدء الفحص",
  INSPECTION_COMPLETED: "اكتمال الفحص",
  QUOTE_CREATED: "إنشاء عرض سعر",
  QUOTE_SUBMITTED: "تقديم عرض سعر",
  QUOTE_REVIEW_STARTED: "بدء مراجعة العرض",
  QUOTE_APPROVED: "اعتماد عرض السعر",
  QUOTE_REJECTED: "رفض عرض السعر",
  STATUS_CHANGED: "تغيير تلقائي للحالة",
  APPROVED: "اعتماد التنفيذ",
  REJECTED: "رفض الطلب",
  REPAIR_STARTED: "بدء الإصلاح",
  READY_FOR_HANDOVER: "جاهزة للاستلام",
  HANDOVER_ACCEPTED: "قبول الاستلام",
  HANDOVER_REJECTED: "رفض الاستلام",
  CLOSED: "إغلاق الطلب",
  PART_ADDED: "إضافة قطعة",
  PART_UPDATED: "تعديل قطعة",
  PART_REMOVED: "حذف قطعة",
  LABOR_ADDED: "إضافة عمالة",
  LABOR_UPDATED: "تعديل عمالة",
  LABOR_REMOVED: "حذف عمالة",
  ATTACHMENT_ADDED: "إرفاق ملف",
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
  if (!v.vehicleId) e.vehicleId = "اختر المركبة";
  if (v.issue.trim().length < 3) e.issue = "وصف العطل مطلوب (3 أحرف على الأقل)";
  if (!v.priority) e.priority = "الأولوية مطلوبة";
  if (v.odometer.trim() && (!/^\d+$/.test(v.odometer.trim()) || Number(v.odometer) < 0)) e.odometer = "العداد رقم صحيح ≥ 0";
  return e;
}

export function validatePart(v: { partName: string; quantity: string; unitPrice: string }) {
  const e: Record<string, string> = {};
  if (v.partName.trim().length < 2) e.partName = "اسم القطعة مطلوب";
  if (!DECIMAL.test(v.quantity.trim()) || Number(v.quantity) <= 0) e.quantity = "الكمية أكبر من صفر";
  if (!MONEY.test(v.unitPrice.trim())) e.unitPrice = "سعر غير صالح (≥ 0)";
  return e;
}

export function validateLabor(v: { description: string; hours: string; hourlyRate: string }) {
  const e: Record<string, string> = {};
  if (v.description.trim().length < 2) e.description = "الوصف مطلوب";
  if (!DECIMAL.test(v.hours.trim()) || Number(v.hours) <= 0 || Number(v.hours) > 1000) e.hours = "الساعات أكبر من صفر";
  if (!MONEY.test(v.hourlyRate.trim())) e.hourlyRate = "سعر غير صالح (≥ 0)";
  return e;
}

export function validateQuote(v: { amount: string; validUntil: string }, todayIso: string) {
  const e: Record<string, string> = {};
  if (!MONEY.test(v.amount.trim())) e.amount = "المبلغ مطلوب (≥ 0)";
  if (v.validUntil && !/^\d{4}-\d{2}-\d{2}$/.test(v.validUntil)) e.validUntil = "تاريخ غير صالح";
  else if (v.validUntil && v.validUntil < todayIso) e.validUntil = "لا يمكن أن يكون في الماضي";
  return e;
}

export function validateReason(reason: string) {
  return reason.trim().length >= 3 ? null : "السبب مطلوب (3 أحرف على الأقل)";
}

/** Money sum as string, avoiding float drift by working in halalas. */
export function sumMoney(values: (string | null | undefined)[]): string {
  const cents = values.reduce((a, v) => a + Math.round(Number(v ?? 0) * 100), 0);
  return (cents / 100).toFixed(2);
}
