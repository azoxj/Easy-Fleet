import type { Me, Scope } from "./types";

const RANK: Record<Scope, number> = { ASSIGNED: 1, PROJECT: 2, ALL: 3 };

/**
 * UI-only convenience: hides controls the user cannot use. The server
 * re-checks every request — this is never the security boundary.
 */
export function can(me: Pick<Me, "permissions"> | null | undefined, perm: string, min: Scope = "ASSIGNED"): boolean {
  const s = me?.permissions[perm];
  return !!s && RANK[s] >= RANK[min];
}

export type NavItem = { to: string; label: string; icon: string; perm?: string; anyOf?: string[]; soon?: boolean };

export const NAV_GROUPS: { title: string; items: NavItem[] }[] = [
  {
    title: "الرئيسية",
    items: [
      { to: "/", label: "لوحة التحكم", icon: "home", perm: "dashboard.view" },
      { to: "/approvals", label: "مركز الاعتمادات", icon: "stamp", anyOf: ["maintenance.approve", "maintenance.quote.approve", "maintenance.handover", "invoices.approve", "finance.transfer", "finance.approve", "handover.manage"] },
      { to: "/my-assignments", label: "إسناداتي", icon: "inbox" },
      { to: "/notifications", label: "الإشعارات", icon: "bell", perm: "notifications.read" },
    ],
  },
  {
    title: "العمليات",
    items: [
      { to: "/maintenance", label: "الصيانة", icon: "wrench", perm: "maintenance.read" },
      { to: "/handovers", label: "التسليم والاستلام", icon: "key", perm: "handover.read" },
      { to: "/fuel", label: "الوقود", icon: "fuel", perm: "fuel.read" },
      { to: "/accidents", label: "الحوادث", icon: "alert", perm: "accidents.read" },
      { to: "/violations", label: "المخالفات", icon: "ticket", perm: "violations.read" },
      { to: "/assignments", label: "متابعة الإسنادات", icon: "clipboard", anyOf: ["assignments.read", "assignments.create"] },
      { to: "/tracking", label: "تتبع رحلتي", icon: "navigation", perm: "gps.track" },
    ],
  },
  {
    title: "المالية",
    items: [
      { to: "/finance", label: "لوحة المالية", icon: "gauge", perm: "finance.read" },
      { to: "/finance/invoices", label: "الفواتير", icon: "receipt", perm: "invoices.read" },
      { to: "/finance/expenses", label: "المصروفات", icon: "copy", perm: "finance.read" },
      { to: "/vendors", label: "الموردون", icon: "building", anyOf: ["vendors.manage", "maintenance.quote.read"] },
    ],
  },
  {
    title: "الأسطول",
    items: [
      { to: "/map", label: "خريطة الأسطول", icon: "map", perm: "gps.read" },
      { to: "/vehicles", label: "المركبات", icon: "truck", perm: "vehicles.read" },
      { to: "/drivers", label: "السائقون", icon: "user", perm: "drivers.read" },
      { to: "/employees", label: "الموظفون", icon: "id", perm: "employees.read" },
      { to: "/projects", label: "المشاريع", icon: "folder", perm: "projects.read" },
      { to: "/documents", label: "مركز المستندات", icon: "file", perm: "documents.read" },
    ],
  },
  {
    title: "التقارير",
    items: [{ to: "/reports", label: "التقارير", icon: "chart", perm: "reports.read" }],
  },
  {
    title: "الإدارة",
    items: [
      { to: "/users", label: "المستخدمون", icon: "users", perm: "users.read" },
      { to: "/roles", label: "الأدوار والصلاحيات", icon: "shield", perm: "roles.read" },
      { to: "/audit", label: "سجل التدقيق", icon: "log", perm: "audit.read" },
      { to: "/settings", label: "الإعدادات", icon: "settings" },
    ],
  },
];

/** Flat list (all groups) — used by tests and anywhere a single list is handy. */
export const NAV: NavItem[] = NAV_GROUPS.flatMap((g) => g.items);

export function visibleNav(me: Me | null, items: NavItem[] = NAV): NavItem[] {
  return items.filter((i) => {
    if (i.perm) return can(me, i.perm);
    if (i.anyOf) return i.anyOf.some((p) => can(me, p));
    return true;
  });
}
