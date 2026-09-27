import { tr } from "../i18n/index.js";
/**
 * Turns audit-log rows into human-readable Arabic timeline entries.
 * Descriptions are generated server-side from stored metadata only; the
 * timeline itself is read-only (audit_logs is append-only at the DB level).
 */
const FIELD: Record<string, string> = {
  get plateNumber() { return tr("رقم اللوحة"); },
  get plateArabic() { return tr("اللوحة (عربي)"); },
  get plateEnglish() { return tr("اللوحة (إنجليزي)"); },
  get serialNumber() { return tr("الرقم التسلسلي"); },
  get vehicleNumber() { return tr("رقم المركبة"); },
  get make() { return tr("الشركة المصنعة"); },
  get model() { return tr("الطراز"); },
  get year() { return tr("سنة الصنع"); },
  get color() { return tr("اللون"); },
  get vin() { return tr("رقم الهيكل"); },
  get currentOdometer() { return tr("العداد"); },
  get status() { return tr("الحالة"); },
  get projectId() { return tr("المشروع"); },
  get purchaseDate() { return tr("تاريخ الشراء"); },
  get purchasePrice() { return tr("سعر الشراء"); },
  get warrantyStart() { return tr("بداية الضمان"); },
  get warrantyEnd() { return tr("نهاية الضمان"); },
  get notes() { return tr("الملاحظات"); },
  get documentNumber() { return tr("الرقم"); },
  get issueDate() { return tr("تاريخ الإصدار"); },
  get expiryDate() { return tr("تاريخ الانتهاء"); },
  get issuer() { return tr("جهة الإصدار"); },
  get provider() { return tr("شركة التأمين"); },
  get policyNumber() { return tr("رقم الوثيقة"); },
  get premiumAmount() { return tr("قيمة القسط"); },
  get coverageType() { return tr("نوع التغطية"); },
};

const VEHICLE_STATUS: Record<string, string> = {
  get AVAILABLE() { return tr("متاحة"); },
  get ASSIGNED() { return tr("مسندة"); },
  get IN_MAINTENANCE() { return tr("في الصيانة"); },
  get OUT_OF_SERVICE() { return tr("خارج الخدمة"); },
  get ACCIDENT() { return tr("حادث"); },
  get SOLD() { return tr("مباعة"); },
  get ARCHIVED() { return tr("مؤرشفة"); },
};

const DOC_TYPE: Record<string, string> = {
  get REGISTRATION() { return tr("استمارة"); },
  get INSURANCE() { return tr("تأمين"); },
  get LICENSE() { return tr("رخصة"); },
  get WARRANTY() { return tr("ضمان"); },
  get OWNERSHIP() { return tr("ملكية"); },
  get OTHER() { return tr("مستند"); },
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
    if (f === "projectId") return tr("المشروع: {0} ← {1}", names.from ?? tr("بدون"), names.to ?? tr("بدون"));
    return `${FIELD[f] ?? f}: ${val(f, c.from)} ← ${val(f, c.to)}`;
  });
  return parts.join(tr("، "));
}

export function describeEvent(action: string, meta: Meta): string {
  const m = meta ?? {};
  const docType = DOC_TYPE[String(m.documentType ?? "")] ?? tr("مستند");
  switch (action) {
    case "VEHICLE_CREATED":
      return tr("تمت إضافة المركبة{0}", m.plateNumber ? ` ${m.plateNumber}` : "");
    case "VEHICLE_UPDATED": {
      const changes = (m.changes ?? {}) as Record<string, Change>;
      if (Object.keys(changes).length === 1 && changes.status) return tr("تغيير الحالة: {0} ← {1}", val("status", changes.status.from), val("status", changes.status.to));
      if (Object.keys(changes).length === 1 && changes.projectId) return tr("تغيير المشروع: {0}", describeChanges(m).replace(/^المشروع: /, ""));
      return tr("تعديل بيانات المركبة — {0}", describeChanges(m));
    }
    case "VEHICLE_ARCHIVED":
      return tr("أرشفة المركبة{0}", m.reason ? tr(" — السبب: {0}", m.reason) : "");
    case "VEHICLE_DRIVER_CHANGED":
      if (!m.toDriverName) return tr("إلغاء إسناد السائق {0}", m.fromDriverName ?? "").trim();
      return m.fromDriverName ? tr("تغيير السائق: {0} ← {1}", m.fromDriverName, m.toDriverName) : tr("إسناد السائق {0}", m.toDriverName);
    case "VEHICLE_DOCUMENT_ADDED":
      return tr("إضافة {0}{1}{2}", docType, m.documentNumber ? tr(" رقم {0}", m.documentNumber) : "", m.expiryDate ? tr(" (تنتهي {0})", m.expiryDate) : "");
    case "VEHICLE_DOCUMENT_UPDATED":
      return tr("تعديل {0} — {1}", docType, describeChanges(m));
    case "VEHICLE_DOCUMENT_DELETED":
      return tr("حذف {0}{1}", docType, m.documentNumber ? tr(" رقم {0}", m.documentNumber) : "");
    case "REGISTRATION_ADDED":
      return tr("{0} الاستمارة رقم {1} (تنتهي {2})", m.renewedFrom ? tr("تجديد") : tr("إضافة"), m.documentNumber ?? "—", m.expiryDate ?? "—");
    case "REGISTRATION_UPDATED":
      return tr("تحديث الاستمارة — {0}", describeChanges(m));
    case "INSURANCE_ADDED":
      return tr("{0} التأمين لدى {1} رقم {2} (ينتهي {3})", m.renewedFrom ? tr("تجديد") : tr("إضافة"), m.provider ?? "—", m.policyNumber ?? "—", m.expiryDate ?? "—");
    case "INSURANCE_UPDATED":
      return tr("تحديث وثيقة التأمين — {0}", describeChanges(m));
    case "FILE_UPLOADED":
      if (m.maintenanceNumber) return tr("إرفاق ملف لطلب الصيانة {0}", m.maintenanceNumber);
      return tr("إرفاق ملف{0}", m.documentType ? tr(" لـ{0}", docType) : tr(" لوثيقة التأمين"));
    case "ASSIGNMENT_CREATED":
      return tr("إسناد المركبة لمستخدم");
    case "MAINTENANCE_CREATED":
      return tr("طلب صيانة {0}: {1}", m.maintenanceNumber ?? "", m.issue ?? "").trim();
    case "MAINTENANCE_ASSIGNED":
      return tr("إسناد الفني {0} لطلب {1}", m.technicianName ?? "", m.maintenanceNumber ?? "").trim();
    case "MAINTENANCE_INSPECTION_STARTED":
      return tr("بدء فحص {0}", m.maintenanceNumber ?? "");
    case "MAINTENANCE_INSPECTION_COMPLETED":
      return tr("اكتمال الفحص والتشخيص {0}", m.maintenanceNumber ?? "");
    case "MAINTENANCE_APPROVED":
      return tr("اعتماد تنفيذ الصيانة {0}", m.maintenanceNumber ?? "");
    case "MAINTENANCE_REJECTED":
      return tr("رفض طلب الصيانة {0}{1}", m.maintenanceNumber ?? "", m.reason ? ` — ${m.reason}` : "");
    case "MAINTENANCE_REPAIR_STARTED":
      return tr("بدء الإصلاح {0}", m.maintenanceNumber ?? "");
    case "MAINTENANCE_READY_FOR_HANDOVER":
      return tr("جاهزة للاستلام بعد الصيانة {0}", m.maintenanceNumber ?? "");
    case "MAINTENANCE_HANDOVER_ACCEPTED":
      return tr("قبول استلام المركبة بعد الصيانة {0}", m.maintenanceNumber ?? "");
    case "MAINTENANCE_HANDOVER_REJECTED":
      return tr("رفض الاستلام وإعادتها للإصلاح {0}{1}", m.maintenanceNumber ?? "", m.reason ? ` — ${m.reason}` : "");
    case "MAINTENANCE_CLOSED":
      return tr("إغلاق طلب الصيانة {0}", m.maintenanceNumber ?? "");
    case "MAINTENANCE_STATUS_CHANGED":
      return tr("تغيّر حالة {0} تلقائيًا", m.maintenanceNumber ?? "");
    case "MAINTENANCE_UPDATED":
      return tr("تحديث بيانات {0}", m.maintenanceNumber ?? tr("طلب الصيانة"));
    case "QUOTE_CREATED":
    case "QUOTE_SUBMITTED":
    case "QUOTE_APPROVED":
    case "QUOTE_REJECTED":
    case "QUOTE_REVIEW_STARTED":
    case "QUOTE_UPDATED":
      return tr("{0} عرض سعر {1}{2}", { QUOTE_CREATED: tr("إنشاء"), QUOTE_SUBMITTED: tr("تقديم"), QUOTE_APPROVED: tr("اعتماد"), QUOTE_REJECTED: tr("رفض"), QUOTE_REVIEW_STARTED: tr("مراجعة"), QUOTE_UPDATED: tr("تعديل") }[action], m.maintenanceNumber ?? "", m.amount ? tr(" ({0} ريال)", m.amount) : "");
    case "PART_ADDED":
    case "PART_UPDATED":
    case "PART_REMOVED":
      return tr("{0} قطعة {1} {2}", { PART_ADDED: tr("إضافة"), PART_UPDATED: tr("تعديل"), PART_REMOVED: tr("حذف") }[action], m.partName ?? "", m.maintenanceNumber ?? "").trim();
    case "LABOR_ADDED":
    case "LABOR_UPDATED":
    case "LABOR_REMOVED":
      return tr("{0} عمالة {1}", { LABOR_ADDED: tr("إضافة"), LABOR_UPDATED: tr("تعديل"), LABOR_REMOVED: tr("حذف") }[action], m.maintenanceNumber ?? "");
    case "FUEL_CREATED":
      return tr("تعبئة وقود {0} لتر بقيمة {1} ريال{2}", m.liters ?? "", m.total ?? "", m.odometer ? tr(" (العداد {0})", m.odometer) : "");
    case "ACCIDENT_CREATED":
      return tr("تسجيل حادث {0} ({1})", m.label ?? "", ACC_SEVERITY[String(m.severity)] ?? m.severity ?? "");
    case "ACCIDENT_UPDATED":
      return tr("تحديث الحادث {0}", m.label ?? "");
    case "ACCIDENT_STATUS_CHANGED":
      return tr("الحادث {0}: {1} ← {2}", m.label ?? "", ACC_STATUS[String(m.fromStatus)] ?? m.fromStatus, ACC_STATUS[String(m.toStatus)] ?? m.toStatus);
    case "VIOLATION_CREATED":
      return tr("تسجيل مخالفة {0} بقيمة {1} ريال", m.type ?? "", m.amount ?? "");
    case "VIOLATION_UPDATED":
      return tr("تعديل بيانات مخالفة");
    case "VIOLATION_STATUS_CHANGED":
      return tr("المخالفة: {0} ← {1}", VIO_STATUS[String(m.fromStatus)] ?? m.fromStatus, VIO_STATUS[String(m.toStatus)] ?? m.toStatus);
    case "HANDOVER_CREATED":
      return tr("إنشاء رابط تسليم المركبة للسائق {0}", m.driverName ?? "").trim();
    case "HANDOVER_COMPLETED":
      return tr("استلام السائق للمركبة (العداد {0})", m.odometer ?? "—");
    case "HANDOVER_RETURN_COMPLETED":
      return tr("إرجاع المركبة (العداد {0}{1}{2})", m.odometer ?? "—", m.distance != null ? tr("، المسافة {0} كم", m.distance) : "", m.newDamage ? tr("، {0} ضرر جديد", m.newDamage) : "");
    case "HANDOVER_CLOSED":
      return tr("إغلاق جلسة التسليم بعد المراجعة");
    case "HANDOVER_CANCELLED":
      return tr("إلغاء جلسة التسليم{0}", m.reason ? ` — ${m.reason}` : "");
    case "HANDOVER_LINK_ROTATED":
      return tr("تجديد رابط التسليم");
    case "HANDOVER_PHOTO_UPLOADED":
      return tr("صورة {0}: {1}{2}", m.phase === "RETURN" ? tr("إرجاع") : tr("تسليم"), m.category ?? "", m.damage ? tr(" (ضرر)") : "");
    case "TRIP_STARTED":
      return tr("بدء رحلة (تتبع GPS)");
    case "TRIP_ENDED":
      return tr("انتهاء رحلة{0}", m.distanceMeters ? tr(" — {0} كم", (Number(m.distanceMeters) / 1000).toFixed(1)) : "");
    case "INVOICE_CREATED":
    case "INVOICE_SUBMITTED":
    case "INVOICE_APPROVED":
    case "INVOICE_REJECTED":
    case "INVOICE_TRANSFERRED":
    case "INVOICE_PAID":
      return tr("{0} فاتورة {1}", { INVOICE_CREATED: tr("إنشاء"), INVOICE_SUBMITTED: tr("تقديم"), INVOICE_APPROVED: tr("اعتماد"), INVOICE_REJECTED: tr("رفض"), INVOICE_TRANSFERRED: tr("تحويل"), INVOICE_PAID: tr("سداد") }[action], m.label ?? m.number ?? "").trim();
    case "EXPENSE_CREATED":
    case "EXPENSE_APPROVED":
    case "EXPENSE_REJECTED":
      return tr("{0} مصروف", { EXPENSE_CREATED: tr("تسجيل"), EXPENSE_APPROVED: tr("اعتماد"), EXPENSE_REJECTED: tr("رفض") }[action]);
    default:
      return action;
  }
}

const ACC_STATUS: Record<string, string> = { get OPEN() { return tr("مفتوح"); }, get UNDER_REVIEW() { return tr("قيد المراجعة"); }, get INSURANCE() { return tr("لدى التأمين"); }, get REPAIR() { return tr("قيد الإصلاح"); }, get CLOSED() { return tr("مغلق"); } };
const ACC_SEVERITY: Record<string, string> = { get MINOR() { return tr("بسيط"); }, get MODERATE() { return tr("متوسط"); }, get SEVERE() { return tr("شديد"); }, get CRITICAL() { return tr("حرج"); } };
const VIO_STATUS: Record<string, string> = { get OPEN() { return tr("مفتوحة"); }, get PAID() { return tr("مدفوعة"); }, get DISPUTED() { return tr("معترض عليها"); }, get CANCELLED() { return tr("ملغاة"); } };

export const TIMELINE_ENTITY_LABEL: Record<string, string> = {
  get vehicle() { return tr("المركبة"); },
  get vehicle_document() { return tr("مستند"); },
  get insurance_policy() { return tr("التأمين"); },
  get assignment() { return tr("إسناد"); },
  get maintenance_request() { return tr("الصيانة"); },
  get maintenance_quote() { return tr("عرض سعر"); },
  get maintenance_part() { return tr("قطع غيار"); },
  get maintenance_labor() { return tr("عمالة"); },
  get maintenance_attachment() { return tr("مرفق صيانة"); },
  get fuel() { return tr("وقود"); },
  get accident() { return tr("حادث"); },
  get violation() { return tr("مخالفة"); },
  get handover() { return tr("تسليم/استلام"); },
  get trip() { return tr("رحلة"); },
  get invoice() { return tr("فاتورة"); },
  get expense() { return tr("مصروف"); },
};
