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
    },
  },
  FINANCE: {
    nameAr: "المالية",
    description: "مراجعة واعتماد الفواتير والمدفوعات",
    grants: {
      "dashboard.view": "ALL",
      "projects.read": "ALL",
      "vehicles.read": "ALL",
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
    },
  },
  USER: {
    nameAr: "مستخدم",
    description: "مستخدم عادي ضمن مشاريعه",
    grants: {
      "dashboard.view": "PROJECT",
      "projects.read": "PROJECT",
      "vehicles.read": "PROJECT",
    },
  },
  DRIVER: {
    nameAr: "سائق",
    description: "يرى المركبات والمهام المسندة إليه فقط",
    grants: {
      "dashboard.view": "ASSIGNED",
      "vehicles.read": "ASSIGNED",
    },
  },
  VIEWER: {
    nameAr: "مشاهد",
    description: "عرض فقط ضمن مشاريعه",
    grants: {
      "dashboard.view": "PROJECT",
      "projects.read": "PROJECT",
      "vehicles.read": "PROJECT",
    },
  },
};

export const ROLE_KEYS = Object.keys(ROLES) as RoleKey[];

export function widerScope(a: Scope | undefined, b: Scope): Scope {
  if (!a) return b;
  return SCOPE_RANK[b] > SCOPE_RANK[a] ? b : a;
}
