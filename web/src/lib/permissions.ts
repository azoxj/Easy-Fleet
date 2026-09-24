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

export const NAV: NavItem[] = [
  { to: "/", label: "لوحة التحكم", icon: "home", perm: "dashboard.view" },
  { to: "/my-assignments", label: "إسناداتي", icon: "inbox" },
  { to: "/projects", label: "المشاريع", icon: "folder", perm: "projects.read" },
  { to: "/vehicles", label: "المركبات", icon: "truck", perm: "vehicles.read" },
  { to: "/assignments", label: "متابعة الإسنادات", icon: "clipboard", anyOf: ["assignments.read", "assignments.create"] },
  { to: "/users", label: "المستخدمون", icon: "users", perm: "users.read" },
  { to: "/roles", label: "الأدوار والصلاحيات", icon: "shield", perm: "roles.read" },
  { to: "/audit", label: "سجل التدقيق", icon: "log", perm: "audit.read" },
];

export const UPCOMING_NAV: NavItem[] = [
  { to: "#", label: "الصيانة", icon: "wrench", soon: true },
  { to: "#", label: "المالية والفواتير", icon: "receipt", soon: true },
  { to: "#", label: "التسليم والاستلام", icon: "key", soon: true },
  { to: "#", label: "الحوادث", icon: "alert", soon: true },
  { to: "#", label: "المخالفات", icon: "ticket", soon: true },
  { to: "#", label: "الوقود", icon: "fuel", soon: true },
  { to: "#", label: "الموظفون", icon: "id", soon: true },
];

export function visibleNav(me: Me | null, items: NavItem[] = NAV): NavItem[] {
  return items.filter((i) => {
    if (i.perm) return can(me, i.perm);
    if (i.anyOf) return i.anyOf.some((p) => can(me, p));
    return true;
  });
}
