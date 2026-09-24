/**
 * Permission catalog & built-in role grants — the single source of truth.
 * `npm run db:bootstrap` syncs this into the roles / permissions /
 * role_permissions tables (idempotent), so the DB always matches the code.
 *
 * Scope hierarchy: ALL ⊇ PROJECT ⊇ ASSIGNED
 *   ALL      – every record in the organization
 *   PROJECT  – records in projects the user belongs to (member or manager),
 *              plus records explicitly assigned to the user
 *   ASSIGNED – only records explicitly assigned to the user
 */
export type Scope = "ALL" | "PROJECT" | "ASSIGNED";

export const SCOPE_RANK: Record<Scope, number> = { ASSIGNED: 1, PROJECT: 2, ALL: 3 };

export const PERMISSIONS = {
  "dashboard.view": { module: "dashboard", descriptionAr: "عرض لوحة التحكم" },
  "users.read": { module: "users", descriptionAr: "عرض المستخدمين" },
  "users.manage": { module: "users", descriptionAr: "إنشاء وتعديل المستخدمين وأدوارهم" },
  "roles.read": { module: "roles", descriptionAr: "عرض الأدوار والصلاحيات" },
  "projects.read": { module: "projects", descriptionAr: "عرض المشاريع" },
  "projects.create": { module: "projects", descriptionAr: "إنشاء المشاريع" },
  "projects.update": { module: "projects", descriptionAr: "تعديل بيانات المشاريع" },
  "projects.members.manage": { module: "projects", descriptionAr: "إدارة أعضاء المشاريع" },
  "vehicles.read": { module: "vehicles", descriptionAr: "عرض المركبات" },
  "vehicles.create": { module: "vehicles", descriptionAr: "إضافة المركبات" },
  "vehicles.update": { module: "vehicles", descriptionAr: "تعديل بيانات المركبات" },
  "vehicles.archive": { module: "vehicles", descriptionAr: "أرشفة المركبات" },
  "assignments.read": { module: "assignments", descriptionAr: "عرض إسنادات الآخرين" },
  "assignments.create": { module: "assignments", descriptionAr: "إنشاء الإسنادات" },
  "assignments.manage": { module: "assignments", descriptionAr: "إلغاء وتعديل الإسنادات" },
  "audit.read": { module: "audit", descriptionAr: "عرض سجل التدقيق" },
  "employees.read": { module: "employees", descriptionAr: "عرض الموظفين" },
  "employees.create": { module: "employees", descriptionAr: "إضافة الموظفين" },
  "employees.update": { module: "employees", descriptionAr: "تعديل بيانات الموظفين" },
  "employees.archive": { module: "employees", descriptionAr: "أرشفة الموظفين" },
  "drivers.read": { module: "drivers", descriptionAr: "عرض السائقين" },
  "drivers.create": { module: "drivers", descriptionAr: "إضافة السائقين" },
  "drivers.update": { module: "drivers", descriptionAr: "تعديل بيانات السائقين وإسناد المركبات" },
  "drivers.archive": { module: "drivers", descriptionAr: "أرشفة السائقين" },
  "vehicle_documents.read": { module: "vehicle_documents", descriptionAr: "عرض مستندات المركبات" },
  "vehicle_documents.create": { module: "vehicle_documents", descriptionAr: "إضافة مستندات المركبات" },
  "vehicle_documents.update": { module: "vehicle_documents", descriptionAr: "تعديل مستندات المركبات" },
  "vehicle_documents.delete": { module: "vehicle_documents", descriptionAr: "حذف مستندات المركبات" },
  "registration.read": { module: "registration", descriptionAr: "عرض الاستمارات" },
  "registration.create": { module: "registration", descriptionAr: "إضافة/تجديد الاستمارات" },
  "registration.update": { module: "registration", descriptionAr: "تعديل الاستمارات" },
  "insurance.read": { module: "insurance", descriptionAr: "عرض وثائق التأمين" },
  "insurance.create": { module: "insurance", descriptionAr: "إضافة/تجديد وثائق التأمين" },
  "insurance.update": { module: "insurance", descriptionAr: "تعديل وثائق التأمين" },
  "maintenance.read": { module: "maintenance", descriptionAr: "عرض طلبات الصيانة" },
  "maintenance.create": { module: "maintenance", descriptionAr: "إنشاء طلبات الصيانة" },
  "maintenance.update": { module: "maintenance", descriptionAr: "تنفيذ أعمال الصيانة (فحص، تشخيص، إصلاح)" },
  "maintenance.assign": { module: "maintenance", descriptionAr: "إسناد الفني لطلب الصيانة" },
  "maintenance.approve": { module: "maintenance", descriptionAr: "اعتماد تنفيذ الصيانة" },
  "maintenance.reject": { module: "maintenance", descriptionAr: "رفض طلب الصيانة" },
  "maintenance.handover": { module: "maintenance", descriptionAr: "قبول أو رفض استلام المركبة بعد الإصلاح" },
  "maintenance.close": { module: "maintenance", descriptionAr: "إغلاق طلب الصيانة بعد القبول" },
  "maintenance.quote.read": { module: "maintenance", descriptionAr: "عرض عروض أسعار الصيانة" },
  "maintenance.quote.create": { module: "maintenance", descriptionAr: "إنشاء وتقديم عروض الأسعار" },
  "maintenance.quote.approve": { module: "maintenance", descriptionAr: "اعتماد عروض الأسعار" },
  "maintenance.quote.reject": { module: "maintenance", descriptionAr: "رفض عروض الأسعار" },
  "maintenance.parts.read": { module: "maintenance", descriptionAr: "عرض قطع الغيار" },
  "maintenance.parts.manage": { module: "maintenance", descriptionAr: "إدارة قطع الغيار" },
  "maintenance.labor.read": { module: "maintenance", descriptionAr: "عرض أعمال العمالة" },
  "maintenance.labor.manage": { module: "maintenance", descriptionAr: "إدارة أعمال العمالة" },
} as const;

export type PermissionKey = keyof typeof PERMISSIONS;
export const ALL_PERMISSION_KEYS = Object.keys(PERMISSIONS) as PermissionKey[];

export type RoleKey =
  | "SUPER_ADMIN"
  | "PROJECT_MANAGER"
  | "FINANCE"
  | "TECHNICAL"
  | "USER"
  | "DRIVER"
  | "VIEWER";

type RoleDef = { nameAr: string; description: string; grants: Partial<Record<PermissionKey, Scope>> };

const allWith = (scope: Scope) =>
  Object.fromEntries(ALL_PERMISSION_KEYS.map((k) => [k, scope])) as Record<PermissionKey, Scope>;

export const ROLES: Record<RoleKey, RoleDef> = {
  SUPER_ADMIN: {
    nameAr: "مدير النظام",
    description: "صلاحيات كاملة على النظام",
    grants: allWith("ALL"),
  },
  PROJECT_MANAGER: {
    nameAr: "مدير مشروع",
    description: "يدير المشاريع المسندة إليه فقط",
    grants: {
      "dashboard.view": "PROJECT",
      "users.read": "PROJECT",
      "projects.read": "PROJECT",
      "projects.update": "PROJECT",
      "vehicles.read": "PROJECT",
      "vehicles.update": "PROJECT",
      "assignments.read": "PROJECT",
      "assignments.create": "PROJECT",
      "assignments.manage": "PROJECT",
      "employees.read": "PROJECT",
      "employees.create": "PROJECT",
      "employees.update": "PROJECT",
      "drivers.read": "PROJECT",
      "drivers.create": "PROJECT",
      "drivers.update": "PROJECT",
      "vehicle_documents.read": "PROJECT",
      "vehicle_documents.create": "PROJECT",
      "vehicle_documents.update": "PROJECT",
      "registration.read": "PROJECT",
      "registration.create": "PROJECT",
      "registration.update": "PROJECT",
      "insurance.read": "PROJECT",
      "insurance.create": "PROJECT",
      "insurance.update": "PROJECT",
      // Maintenance: the PM requests, assigns, approves the work and accepts the handover.
      // Quote approval is a FINANCE decision, so the PM does not hold maintenance.quote.approve.
      "maintenance.read": "PROJECT",
      "maintenance.create": "PROJECT",
      "maintenance.update": "PROJECT",
      "maintenance.assign": "PROJECT",
      "maintenance.approve": "PROJECT",
      "maintenance.reject": "PROJECT",
      "maintenance.handover": "PROJECT",
      "maintenance.close": "PROJECT",
      "maintenance.quote.read": "PROJECT",
      "maintenance.quote.create": "PROJECT",
      "maintenance.parts.read": "PROJECT",
      "maintenance.parts.manage": "PROJECT",
      "maintenance.labor.read": "PROJECT",
      "maintenance.labor.manage": "PROJECT",
    },
  },
  FINANCE: {
    nameAr: "المالية",
    description: "مراجعة واعتماد الفواتير والمدفوعات",
    grants: {
      "dashboard.view": "ALL",
      "projects.read": "ALL",
      "vehicles.read": "ALL",
      "vehicle_documents.read": "ALL",
      "registration.read": "ALL",
      "insurance.read": "ALL",
      "maintenance.read": "ALL",
      "maintenance.quote.read": "ALL",
      "maintenance.quote.approve": "ALL",
      "maintenance.quote.reject": "ALL",
      "maintenance.parts.read": "ALL",
      "maintenance.labor.read": "ALL",
    },
  },
  TECHNICAL: {
    nameAr: "فني",
    description: "متابعة الصيانة والأعمال الفنية",
    grants: {
      "dashboard.view": "PROJECT",
      "projects.read": "PROJECT",
      "vehicles.read": "PROJECT",
      "vehicles.update": "ASSIGNED",
      "vehicle_documents.read": "PROJECT",
      "registration.read": "PROJECT",
      "insurance.read": "PROJECT",
      // Technicians work only on maintenance assigned to them.
      "maintenance.read": "ASSIGNED",
      "maintenance.update": "ASSIGNED",
      "maintenance.quote.read": "ASSIGNED",
      "maintenance.quote.create": "ASSIGNED",
      "maintenance.parts.read": "ASSIGNED",
      "maintenance.parts.manage": "ASSIGNED",
      "maintenance.labor.read": "ASSIGNED",
      "maintenance.labor.manage": "ASSIGNED",
    },
  },
  USER: {
    nameAr: "مستخدم",
    description: "مستخدم عادي ضمن مشاريعه",
    grants: {
      "dashboard.view": "PROJECT",
      "projects.read": "PROJECT",
      "vehicles.read": "PROJECT",
      "vehicle_documents.read": "PROJECT",
      "registration.read": "PROJECT",
      "maintenance.read": "PROJECT",
    },
  },
  DRIVER: {
    nameAr: "سائق",
    description: "يرى المركبات والمهام المسندة إليه فقط",
    grants: {
      "dashboard.view": "ASSIGNED",
      "vehicles.read": "ASSIGNED",
      // ASSIGNED on employees/drivers = only the driver's own record.
      "employees.read": "ASSIGNED",
      "drivers.read": "ASSIGNED",
      "vehicle_documents.read": "ASSIGNED",
      "registration.read": "ASSIGNED",
      "insurance.read": "ASSIGNED",
    },
  },
  VIEWER: {
    nameAr: "مشاهد",
    description: "عرض فقط ضمن مشاريعه",
    grants: {
      "dashboard.view": "PROJECT",
      "projects.read": "PROJECT",
      "vehicles.read": "PROJECT",
      "vehicle_documents.read": "PROJECT",
      "registration.read": "PROJECT",
      "insurance.read": "PROJECT",
      "maintenance.read": "PROJECT",
    },
  },
};

export const ROLE_KEYS = Object.keys(ROLES) as RoleKey[];

export function widerScope(a: Scope | undefined, b: Scope): Scope {
  if (!a) return b;
  return SCOPE_RANK[b] > SCOPE_RANK[a] ? b : a;
}
