/**
 * Turns audit-log rows into human-readable Arabic timeline entries.
 * Descriptions are generated server-side from stored metadata only; the
 * timeline itself is read-only (audit_logs is append-only at the DB level).
 */
const FIELD: Record<string, string> = {
  plateNumber: "رقم اللوحة",
  vehicleNumber: "رقم المركبة",
  make: "الشركة المصنعة",
  model: "الطراز",
  year: "سنة الصنع",
  color: "اللون",
  vin: "رقم الهيكل",
  currentOdometer: "العداد",
  status: "الحالة",
  projectId: "المشروع",
  purchaseDate: "تاريخ الشراء",
  purchasePrice: "سعر الشراء",
  warrantyStart: "بداية الضمان",
  warrantyEnd: "نهاية الضمان",
  notes: "الملاحظات",
  documentNumber: "الرقم",
  issueDate: "تاريخ الإصدار",
  expiryDate: "تاريخ الانتهاء",
  issuer: "جهة الإصدار",
  provider: "شركة التأمين",
  policyNumber: "رقم الوثيقة",
  premiumAmount: "قيمة القسط",
  coverageType: "نوع التغطية",
};

const VEHICLE_STATUS: Record<string, string> = {
  AVAILABLE: "متاحة",
  ASSIGNED: "مسندة",
  IN_MAINTENANCE: "في الصيانة",
  OUT_OF_SERVICE: "خارج الخدمة",
  ACCIDENT: "حادث",
  SOLD: "مباعة",
  ARCHIVED: "مؤرشفة",
};

const DOC_TYPE: Record<string, string> = {
  REGISTRATION: "استمارة",
  INSURANCE: "تأمين",
  LICENSE: "رخصة",
  WARRANTY: "ضمان",
  OWNERSHIP: "ملكية",
  OTHER: "مستند",
};

type Change = { from: unknown; to: unknown };
type Meta = Record<string, unknown> | null;

const val = (field: string, v: unknown) => {
  if (v === null || v === undefined || v === "") return "—";
  if (field === "status") return VEHICLE_STATUS[String(v)] ?? String(v);
  return String(v);
};

function describeChanges(meta: Meta): string {
  const changes = (meta?.changes ?? {}) as Record<string, Change>;
  const names = (meta?.projectNames ?? {}) as { from?: string | null; to?: string | null };
  const parts = Object.entries(changes).map(([f, c]) => {
    if (f === "projectId") return `المشروع: ${names.from ?? "بدون"} ← ${names.to ?? "بدون"}`;
    return `${FIELD[f] ?? f}: ${val(f, c.from)} ← ${val(f, c.to)}`;
  });
  return parts.join("، ");
}

export function describeEvent(action: string, meta: Meta): string {
  const m = meta ?? {};
  const docType = DOC_TYPE[String(m.documentType ?? "")] ?? "مستند";
  switch (action) {
    case "VEHICLE_CREATED":
      return `تمت إضافة المركبة${m.plateNumber ? ` ${m.plateNumber}` : ""}`;
    case "VEHICLE_UPDATED": {
      const changes = (m.changes ?? {}) as Record<string, Change>;
      if (Object.keys(changes).length === 1 && changes.status) return `تغيير الحالة: ${val("status", changes.status.from)} ← ${val("status", changes.status.to)}`;
      if (Object.keys(changes).length === 1 && changes.projectId) return `تغيير المشروع: ${describeChanges(m).replace(/^المشروع: /, "")}`;
      return `تعديل بيانات المركبة — ${describeChanges(m)}`;
    }
    case "VEHICLE_ARCHIVED":
      return `أرشفة المركبة${m.reason ? ` — السبب: ${m.reason}` : ""}`;
    case "VEHICLE_DRIVER_CHANGED":
      if (!m.toDriverName) return `إلغاء إسناد السائق ${m.fromDriverName ?? ""}`.trim();
      return m.fromDriverName ? `تغيير السائق: ${m.fromDriverName} ← ${m.toDriverName}` : `إسناد السائق ${m.toDriverName}`;
    case "VEHICLE_DOCUMENT_ADDED":
      return `إضافة ${docType}${m.documentNumber ? ` رقم ${m.documentNumber}` : ""}${m.expiryDate ? ` (تنتهي ${m.expiryDate})` : ""}`;
    case "VEHICLE_DOCUMENT_UPDATED":
      return `تعديل ${docType} — ${describeChanges(m)}`;
    case "VEHICLE_DOCUMENT_DELETED":
      return `حذف ${docType}${m.documentNumber ? ` رقم ${m.documentNumber}` : ""}`;
    case "REGISTRATION_ADDED":
      return `${m.renewedFrom ? "تجديد" : "إضافة"} الاستمارة رقم ${m.documentNumber ?? "—"} (تنتهي ${m.expiryDate ?? "—"})`;
    case "REGISTRATION_UPDATED":
      return `تحديث الاستمارة — ${describeChanges(m)}`;
    case "INSURANCE_ADDED":
      return `${m.renewedFrom ? "تجديد" : "إضافة"} التأمين لدى ${m.provider ?? "—"} رقم ${m.policyNumber ?? "—"} (ينتهي ${m.expiryDate ?? "—"})`;
    case "INSURANCE_UPDATED":
      return `تحديث وثيقة التأمين — ${describeChanges(m)}`;
    case "FILE_UPLOADED":
      if (m.maintenanceNumber) return `إرفاق ملف لطلب الصيانة ${m.maintenanceNumber}`;
      return `إرفاق ملف${m.documentType ? ` لـ${docType}` : " لوثيقة التأمين"}`;
    case "ASSIGNMENT_CREATED":
      return "إسناد المركبة لمستخدم";
    case "MAINTENANCE_CREATED":
      return `طلب صيانة ${m.maintenanceNumber ?? ""}: ${m.issue ?? ""}`.trim();
    case "MAINTENANCE_ASSIGNED":
      return `إسناد الفني ${m.technicianName ?? ""} لطلب ${m.maintenanceNumber ?? ""}`.trim();
    case "MAINTENANCE_INSPECTION_STARTED":
      return `بدء فحص ${m.maintenanceNumber ?? ""}`;
    case "MAINTENANCE_INSPECTION_COMPLETED":
      return `اكتمال الفحص والتشخيص ${m.maintenanceNumber ?? ""}`;
    case "MAINTENANCE_APPROVED":
      return `اعتماد تنفيذ الصيانة ${m.maintenanceNumber ?? ""}`;
    case "MAINTENANCE_REJECTED":
      return `رفض طلب الصيانة ${m.maintenanceNumber ?? ""}${m.reason ? ` — ${m.reason}` : ""}`;
    case "MAINTENANCE_REPAIR_STARTED":
      return `بدء الإصلاح ${m.maintenanceNumber ?? ""}`;
    case "MAINTENANCE_READY_FOR_HANDOVER":
      return `جاهزة للاستلام بعد الصيانة ${m.maintenanceNumber ?? ""}`;
    case "MAINTENANCE_HANDOVER_ACCEPTED":
      return `قبول استلام المركبة بعد الصيانة ${m.maintenanceNumber ?? ""}`;
    case "MAINTENANCE_HANDOVER_REJECTED":
      return `رفض الاستلام وإعادتها للإصلاح ${m.maintenanceNumber ?? ""}${m.reason ? ` — ${m.reason}` : ""}`;
    case "MAINTENANCE_CLOSED":
      return `إغلاق طلب الصيانة ${m.maintenanceNumber ?? ""}`;
    case "MAINTENANCE_STATUS_CHANGED":
      return `تغيّر حالة ${m.maintenanceNumber ?? ""} تلقائيًا`;
    case "MAINTENANCE_UPDATED":
      return `تحديث بيانات ${m.maintenanceNumber ?? "طلب الصيانة"}`;
    case "QUOTE_CREATED":
    case "QUOTE_SUBMITTED":
    case "QUOTE_APPROVED":
    case "QUOTE_REJECTED":
    case "QUOTE_REVIEW_STARTED":
    case "QUOTE_UPDATED":
      return `${{ QUOTE_CREATED: "إنشاء", QUOTE_SUBMITTED: "تقديم", QUOTE_APPROVED: "اعتماد", QUOTE_REJECTED: "رفض", QUOTE_REVIEW_STARTED: "مراجعة", QUOTE_UPDATED: "تعديل" }[action]} عرض سعر ${m.maintenanceNumber ?? ""}${m.amount ? ` (${m.amount} ريال)` : ""}`;
    case "PART_ADDED":
    case "PART_UPDATED":
    case "PART_REMOVED":
      return `${{ PART_ADDED: "إضافة", PART_UPDATED: "تعديل", PART_REMOVED: "حذف" }[action]} قطعة ${m.partName ?? ""} ${m.maintenanceNumber ?? ""}`.trim();
    case "LABOR_ADDED":
    case "LABOR_UPDATED":
    case "LABOR_REMOVED":
      return `${{ LABOR_ADDED: "إضافة", LABOR_UPDATED: "تعديل", LABOR_REMOVED: "حذف" }[action]} عمالة ${m.maintenanceNumber ?? ""}`;
    default:
      return action;
  }
}

export const TIMELINE_ENTITY_LABEL: Record<string, string> = {
  vehicle: "المركبة",
  vehicle_document: "مستند",
  insurance_policy: "التأمين",
  assignment: "إسناد",
  maintenance_request: "الصيانة",
  maintenance_quote: "عرض سعر",
  maintenance_part: "قطع غيار",
  maintenance_labor: "عمالة",
  maintenance_attachment: "مرفق صيانة",
};
