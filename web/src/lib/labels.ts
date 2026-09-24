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
