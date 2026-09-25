export type Tone = "gray" | "blue" | "green" | "amber" | "red" | "violet" | "slate";

type LabelMap = Record<string, { label: string; tone: Tone }>;

export const VEHICLE_STATUS: LabelMap = {
  AVAILABLE: { label: "متاحة", tone: "green" },
  ASSIGNED: { label: "مسندة", tone: "blue" },
  IN_MAINTENANCE: { label: "في الصيانة", tone: "amber" },
  OUT_OF_SERVICE: { label: "خارج الخدمة", tone: "red" },
  ACCIDENT: { label: "حادث", tone: "red" },
  SOLD: { label: "مباعة", tone: "violet" },
  ARCHIVED: { label: "مؤرشفة", tone: "gray" },
};

export const PROJECT_STATUS: LabelMap = {
  PLANNED: { label: "مخطط", tone: "slate" },
  ACTIVE: { label: "نشط", tone: "green" },
  ON_HOLD: { label: "متوقف مؤقتًا", tone: "amber" },
  COMPLETED: { label: "مكتمل", tone: "blue" },
  ARCHIVED: { label: "مؤرشف", tone: "gray" },
};

export const ASSIGNMENT_STATUS: LabelMap = {
  PENDING: { label: "بانتظار البدء", tone: "amber" },
  IN_PROGRESS: { label: "قيد التنفيذ", tone: "blue" },
  COMPLETED: { label: "مكتمل", tone: "green" },
  CANCELLED: { label: "ملغى", tone: "gray" },
};

export const ASSIGNMENT_TYPE: Record<string, string> = {
  PROJECT: "مشروع",
  VEHICLE: "مركبة",
  MAINTENANCE_REQUEST: "طلب صيانة",
  ACCIDENT: "حادث",
  INVOICE: "فاتورة",
  TASK: "مهمة",
  DOCUMENT: "مستند",
  VIOLATION: "مخالفة",
  REGISTRATION: "استمارة",
  INSURANCE: "تأمين",
};

export const PRIORITY: LabelMap = {
  LOW: { label: "منخفضة", tone: "slate" },
  MEDIUM: { label: "متوسطة", tone: "blue" },
  HIGH: { label: "عالية", tone: "amber" },
  URGENT: { label: "عاجلة", tone: "red" },
};

export const EMPLOYEE_STATUS: LabelMap = {
  ACTIVE: { label: "نشط", tone: "green" },
  INACTIVE: { label: "غير نشط", tone: "slate" },
  SUSPENDED: { label: "موقوف", tone: "amber" },
  ARCHIVED: { label: "مؤرشف", tone: "gray" },
};

export const DRIVER_STATUS: LabelMap = {
  ACTIVE: { label: "نشط", tone: "green" },
  EXPIRED: { label: "رخصة منتهية", tone: "red" },
  SUSPENDED: { label: "موقوف", tone: "amber" },
  INACTIVE: { label: "غير نشط", tone: "gray" },
};

export const EXPIRY_STATUS: LabelMap = {
  ACTIVE: { label: "سارية", tone: "green" },
  EXPIRING_SOON: { label: "تنتهي قريبًا", tone: "amber" },
  EXPIRED: { label: "منتهية", tone: "red" },
};

export const LICENSE_TYPE: Record<string, string> = {
  PRIVATE: "خاصة",
  PUBLIC: "عمومي",
  HEAVY: "نقل ثقيل",
  MOTORCYCLE: "دراجة نارية",
  OTHER: "أخرى",
};

export const DOCUMENT_TYPE: Record<string, string> = {
  REGISTRATION: "استمارة",
  INSURANCE: "تأمين",
  LICENSE: "رخصة سير/تشغيل",
  WARRANTY: "ضمان",
  OWNERSHIP: "ملكية",
  OTHER: "أخرى",
};

export const COVERAGE_TYPE: Record<string, string> = {
  THIRD_PARTY: "ضد الغير",
  COMPREHENSIVE: "شامل",
  OTHER: "أخرى",
};

export const USER_STATUS: LabelMap = {
  ACTIVE: { label: "نشط", tone: "green" },
  DISABLED: { label: "معطل", tone: "gray" },
};

export const SCOPE_LABEL: Record<string, string> = {
  ALL: "الكل",
  PROJECT: "المشاريع",
  ASSIGNED: "المسند فقط",
};

export const AUDIT_ACTION: Record<string, string> = {
  AUTH_LOGIN: "تسجيل دخول",
  AUTH_LOGIN_FAILED: "محاولة دخول فاشلة",
  AUTH_LOGOUT: "تسجيل خروج",
  AUTH_PASSWORD_CHANGED: "تغيير كلمة المرور",
  USER_CREATED: "إنشاء مستخدم",
  USER_UPDATED: "تعديل مستخدم",
  USER_ROLES_CHANGED: "تغيير أدوار مستخدم",
  USER_DISABLED: "تعطيل مستخدم",
  USER_ENABLED: "تفعيل مستخدم",
  USER_PASSWORD_RESET: "إعادة تعيين كلمة مرور",
  PROJECT_CREATED: "إنشاء مشروع",
  PROJECT_UPDATED: "تعديل مشروع",
  PROJECT_MEMBER_ADDED: "إضافة عضو لمشروع",
  PROJECT_MEMBER_REMOVED: "إزالة عضو من مشروع",
  VEHICLE_CREATED: "إضافة مركبة",
  VEHICLE_UPDATED: "تعديل مركبة",
  VEHICLE_ARCHIVED: "أرشفة مركبة",
  ASSIGNMENT_CREATED: "إنشاء إسناد",
  ASSIGNMENT_STATUS_CHANGED: "تغيير حالة إسناد",
  EMPLOYEE_CREATED: "إضافة موظف",
  EMPLOYEE_UPDATED: "تعديل موظف",
  EMPLOYEE_ARCHIVED: "أرشفة موظف",
  DRIVER_CREATED: "إضافة سائق",
  DRIVER_UPDATED: "تعديل سائق",
  DRIVER_ARCHIVED: "أرشفة سائق",
  VEHICLE_DRIVER_CHANGED: "تغيير سائق مركبة",
  VEHICLE_DOCUMENT_ADDED: "إضافة مستند مركبة",
  VEHICLE_DOCUMENT_UPDATED: "تعديل مستند مركبة",
  VEHICLE_DOCUMENT_DELETED: "حذف مستند مركبة",
  REGISTRATION_ADDED: "إضافة/تجديد استمارة",
  REGISTRATION_UPDATED: "تحديث استمارة",
  INSURANCE_ADDED: "إضافة/تجديد تأمين",
  INSURANCE_UPDATED: "تحديث تأمين",
  FILE_UPLOADED: "رفع ملف",
  FILE_DOWNLOADED: "تنزيل ملف",
  VENDOR_CREATED: "إضافة مورد",
  MAINTENANCE_CREATED: "إنشاء طلب صيانة",
  MAINTENANCE_UPDATED: "تعديل طلب صيانة",
  MAINTENANCE_ASSIGNED: "إسناد فني لصيانة",
  MAINTENANCE_INSPECTION_STARTED: "بدء فحص صيانة",
  MAINTENANCE_INSPECTION_COMPLETED: "اكتمال فحص صيانة",
  MAINTENANCE_APPROVED: "اعتماد صيانة",
  MAINTENANCE_REJECTED: "رفض طلب صيانة",
  MAINTENANCE_REPAIR_STARTED: "بدء إصلاح",
  MAINTENANCE_READY_FOR_HANDOVER: "جاهزة للاستلام",
  MAINTENANCE_HANDOVER_ACCEPTED: "قبول استلام بعد الصيانة",
  MAINTENANCE_HANDOVER_REJECTED: "رفض استلام بعد الصيانة",
  MAINTENANCE_CLOSED: "إغلاق صيانة",
  MAINTENANCE_STATUS_CHANGED: "تغيير تلقائي لحالة صيانة",
  QUOTE_CREATED: "إنشاء عرض سعر",
  QUOTE_UPDATED: "تعديل عرض سعر",
  QUOTE_SUBMITTED: "تقديم عرض سعر",
  QUOTE_REVIEW_STARTED: "مراجعة عرض سعر",
  QUOTE_APPROVED: "اعتماد عرض سعر",
  QUOTE_REJECTED: "رفض عرض سعر",
  PART_ADDED: "إضافة قطعة غيار",
  PART_UPDATED: "تعديل قطعة غيار",
  PART_REMOVED: "حذف قطعة غيار",
  LABOR_ADDED: "إضافة عمالة",
  LABOR_UPDATED: "تعديل عمالة",
  LABOR_REMOVED: "حذف عمالة",
  PROJECT_ARCHIVED: "أرشفة مشروع",
  USER_DELETED: "حذف (تعطيل نهائي) مستخدم",
  VENDOR_UPDATED: "تعديل مورد",
  INVOICE_CREATED: "إنشاء فاتورة",
  INVOICE_UPDATED: "تعديل فاتورة",
  INVOICE_SUBMITTED: "تقديم فاتورة",
  INVOICE_REVIEW_STARTED: "بدء مراجعة فاتورة",
  INVOICE_APPROVED: "اعتماد فاتورة",
  INVOICE_REJECTED: "رفض فاتورة",
  INVOICE_CANCELLED: "إلغاء فاتورة",
  INVOICE_TRANSFERRED: "تحويل مبلغ فاتورة",
  INVOICE_PAID: "إغلاق فاتورة كمدفوعة",
  INVOICE_STATUS_CHANGED: "تغيير حالة فاتورة",
  EXPENSE_CREATED: "تسجيل مصروف",
  EXPENSE_APPROVED: "اعتماد مصروف",
  EXPENSE_REJECTED: "رفض مصروف",
  FUEL_CREATED: "تسجيل تعبئة وقود",
  ACCIDENT_CREATED: "تسجيل حادث",
  ACCIDENT_UPDATED: "تعديل حادث",
  ACCIDENT_STATUS_CHANGED: "تغيير حالة حادث",
  VIOLATION_CREATED: "تسجيل مخالفة",
  VIOLATION_UPDATED: "تعديل مخالفة",
  VIOLATION_STATUS_CHANGED: "تغيير حالة مخالفة",
  EMPLOYEE_DOCUMENT_ADDED: "إضافة مستند موظف",
  EMPLOYEE_DOCUMENT_UPDATED: "تعديل مستند موظف",
  EMPLOYEE_DOCUMENT_DELETED: "حذف مستند موظف",
  HANDOVER_CREATED: "إنشاء رابط تسليم",
  HANDOVER_LINK_ROTATED: "تجديد رابط تسليم",
  HANDOVER_PHOTO_UPLOADED: "رفع صورة تسليم/إرجاع",
  HANDOVER_COMPLETED: "استلام السائق للمركبة",
  HANDOVER_RETURN_COMPLETED: "إرجاع المركبة",
  HANDOVER_CLOSED: "إغلاق جلسة تسليم",
  HANDOVER_CANCELLED: "إلغاء جلسة تسليم",
  HANDOVER_TOKEN_INVALID: "محاولة رابط تسليم غير صالح",
  TRIP_STARTED: "بدء رحلة",
  TRIP_ENDED: "انتهاء رحلة",
  ASSIGNMENT_UPDATED: "تعديل إسناد",
  ASSIGNMENT_DELETED: "حذف إسناد",
  NOTIFICATION_BROADCAST: "إرسال إشعار عام",
  SETTINGS_UPDATED: "تعديل الإعدادات",
  REPORT_EXPORTED: "تصدير تقرير",
  SECURITY_CSRF_REJECTED: "رفض طلب (CSRF)",
  SECURITY_RATE_LIMITED: "تجاوز حد الطلبات",
};

export const INVOICE_STATUS: LabelMap = {
  DRAFT: { label: "مسودة", tone: "slate" },
  SUBMITTED: { label: "مقدمة", tone: "blue" },
  UNDER_REVIEW: { label: "قيد المراجعة", tone: "violet" },
  APPROVED: { label: "معتمدة", tone: "green" },
  REJECTED: { label: "مرفوضة", tone: "red" },
  TRANSFER_PENDING: { label: "بانتظار التحويل", tone: "amber" },
  TRANSFERRED: { label: "تم التحويل", tone: "green" },
  PAID: { label: "مدفوعة", tone: "green" },
  CANCELLED: { label: "ملغاة", tone: "gray" },
};

export const EXPENSE_STATUS: LabelMap = {
  SUBMITTED: { label: "بانتظار الاعتماد", tone: "amber" },
  APPROVED: { label: "معتمد", tone: "green" },
  REJECTED: { label: "مرفوض", tone: "red" },
};

export const COST_CATEGORY: Record<string, string> = {
  FUEL: "وقود",
  MAINTENANCE: "صيانة",
  INSURANCE: "تأمين",
  REGISTRATION: "استمارة",
  ACCIDENT: "حوادث",
  VIOLATION: "مخالفات",
  OTHER: "أخرى",
};

export const ACCIDENT_STATUS: LabelMap = {
  OPEN: { label: "مفتوح", tone: "red" },
  UNDER_REVIEW: { label: "قيد المراجعة", tone: "violet" },
  INSURANCE: { label: "لدى التأمين", tone: "blue" },
  REPAIR: { label: "قيد الإصلاح", tone: "amber" },
  CLOSED: { label: "مغلق", tone: "gray" },
};

export const ACCIDENT_SEVERITY: LabelMap = {
  MINOR: { label: "بسيط", tone: "slate" },
  MODERATE: { label: "متوسط", tone: "amber" },
  SEVERE: { label: "شديد", tone: "red" },
  CRITICAL: { label: "حرج", tone: "red" },
};

export const RESPONSIBILITY: Record<string, string> = {
  DRIVER: "السائق",
  THIRD_PARTY: "طرف ثالث",
  SHARED: "مشتركة",
  UNKNOWN: "غير محددة",
};

export const VIOLATION_STATUS: LabelMap = {
  OPEN: { label: "غير مسددة", tone: "red" },
  PAID: { label: "مسددة", tone: "green" },
  DISPUTED: { label: "معترض عليها", tone: "violet" },
  CANCELLED: { label: "ملغاة", tone: "gray" },
};

export const HANDOVER_STATUS: LabelMap = {
  PENDING_HANDOVER: { label: "بانتظار الاستلام", tone: "amber" },
  RETURN_PENDING: { label: "مع السائق", tone: "blue" },
  RETURN_COMPLETED: { label: "تم الإرجاع — للمراجعة", tone: "violet" },
  CLOSED: { label: "مغلقة", tone: "gray" },
  CANCELLED: { label: "ملغاة", tone: "gray" },
};

export const PHOTO_CATEGORY: Record<string, string> = {
  FRONT: "الأمام",
  REAR: "الخلف",
  LEFT: "الجانب الأيسر",
  RIGHT: "الجانب الأيمن",
  INTERIOR: "الداخلية",
  ODOMETER: "العداد",
  TIRES: "الإطارات",
  OTHER: "صورة إضافية",
  SIGNATURE: "التوقيع",
};

export const NOTIFICATION_CATEGORY: Record<string, string> = {
  MAINTENANCE: "الصيانة",
  FINANCE: "المالية",
  ASSIGNMENT: "الإسنادات",
  DOCUMENT_EXPIRY: "انتهاء المستندات",
  ACCIDENT: "الحوادث",
  VIOLATION: "المخالفات",
  HANDOVER: "التسليم والاستلام",
  SYSTEM: "النظام",
};

export const EMPLOYEE_DOC_TYPE: Record<string, string> = {
  NATIONAL_ID: "الهوية الوطنية",
  IQAMA: "الإقامة",
  PASSPORT: "جواز السفر",
  CONTRACT: "عقد العمل",
  DRIVING_LICENSE: "رخصة القيادة",
  OTHER: "أخرى",
};

export const DOC_KIND: Record<string, string> = {
  VEHICLE: "مستند مركبة",
  INSURANCE: "تأمين",
  EMPLOYEE: "مستند موظف",
  LICENSE: "رخصة قيادة",
};

export const APPROVAL_KIND: Record<string, { label: string; tone: Tone }> = {
  MAINTENANCE_APPROVAL: { label: "اعتماد صيانة", tone: "amber" },
  QUOTE_APPROVAL: { label: "اعتماد عرض سعر", tone: "violet" },
  MAINTENANCE_HANDOVER: { label: "استلام بعد الصيانة", tone: "blue" },
  INVOICE_REVIEW: { label: "مراجعة فاتورة", tone: "violet" },
  INVOICE_TRANSFER: { label: "تحويل مبلغ", tone: "green" },
  EXPENSE_APPROVAL: { label: "اعتماد مصروف", tone: "amber" },
  HANDOVER_REVIEW: { label: "مراجعة إرجاع مركبة", tone: "blue" },
};

export const FIELD_LABEL: Record<string, string> = {
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
  notes: "ملاحظات",
  name: "الاسم",
  description: "الوصف",
  budget: "الميزانية",
  managerId: "المدير",
  startDate: "تاريخ البداية",
  endDate: "تاريخ النهاية",
  code: "الرمز",
  phone: "الجوال",
  plateArabic: "اللوحة (عربي)",
  plateEnglish: "اللوحة (إنجليزي)",
  serialNumber: "الرقم التسلسلي",
  contractValue: "قيمة العقد",
  taxNumber: "الرقم الضريبي",
  address: "العنوان",
  severity: "الخطورة",
  responsibility: "المسؤولية",
  repairCost: "تكلفة الإصلاح",
  insuranceClaimNumber: "رقم المطالبة",
  amount: "المبلغ",
  title: "العنوان",
  priority: "الأولوية",
  dueDate: "تاريخ الاستحقاق",
};

export function labelOf(map: LabelMap, key: string) {
  return map[key] ?? { label: key, tone: "gray" as Tone };
}
