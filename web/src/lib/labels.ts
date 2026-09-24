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
};

export function labelOf(map: LabelMap, key: string) {
  return map[key] ?? { label: key, tone: "gray" as Tone };
}
