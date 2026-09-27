import type { Me, Scope } from "./types";
import { t } from "../i18n";

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
    get title() { return t("nav.home"); },
    items: [
      { to: "/", get label() { return t("nav.dashboard"); }, icon: "home", perm: "dashboard.view" },
      { to: "/approvals", get label() { return t("common.approvalCenter"); }, icon: "stamp", anyOf: ["maintenance.approve", "maintenance.quote.approve", "maintenance.handover", "invoices.approve", "finance.transfer", "finance.approve", "handover.manage"] },
      { to: "/my-assignments", get label() { return t("common.myAssignments"); }, icon: "inbox" },
      { to: "/notifications", get label() { return t("common.notifications"); }, icon: "bell", perm: "notifications.read" },
    ],
  },
  {
    get title() { return t("nav.operations"); },
    items: [
      { to: "/maintenance", get label() { return t("common.maintenance"); }, icon: "wrench", perm: "maintenance.read" },
      { to: "/handovers", get label() { return t("common.handoverReturn"); }, icon: "key", perm: "handover.read" },
      { to: "/fuel", get label() { return t("common.fuel"); }, icon: "fuel", perm: "fuel.read" },
      { to: "/accidents", get label() { return t("common.accidents"); }, icon: "alert", perm: "accidents.read" },
      { to: "/violations", get label() { return t("common.violations"); }, icon: "ticket", perm: "violations.read" },
      { to: "/assignments", get label() { return t("common.assignmentTracking"); }, icon: "clipboard", anyOf: ["assignments.read", "assignments.create"] },
      { to: "/tracking", get label() { return t("common.trackMyTrip"); }, icon: "navigation", perm: "gps.track" },
    ],
  },
  {
    get title() { return t("nav.finance"); },
    items: [
      { to: "/finance", get label() { return t("common.financeDashboard"); }, icon: "gauge", perm: "finance.read" },
      { to: "/finance/invoices", get label() { return t("common.invoices"); }, icon: "receipt", perm: "invoices.read" },
      { to: "/finance/expenses", get label() { return t("common.expenses"); }, icon: "copy", perm: "finance.read" },
      { to: "/vendors", get label() { return t("common.vendors"); }, icon: "building", anyOf: ["vendors.manage", "maintenance.quote.read"] },
    ],
  },
  {
    get title() { return t("nav.fleet"); },
    items: [
      { to: "/map", get label() { return t("common.fleetMap"); }, icon: "map", perm: "gps.read" },
      { to: "/vehicles", get label() { return t("common.vehicles"); }, icon: "truck", perm: "vehicles.read" },
      { to: "/drivers", get label() { return t("common.drivers"); }, icon: "user", perm: "drivers.read" },
      { to: "/employees", get label() { return t("common.employees"); }, icon: "id", perm: "employees.read" },
      { to: "/projects", get label() { return t("common.projects"); }, icon: "folder", perm: "projects.read" },
      { to: "/documents", get label() { return t("common.documentCenter"); }, icon: "file", perm: "documents.read" },
    ],
  },
  {
    get title() { return t("common.reports"); },
    items: [{ to: "/reports", get label() { return t("common.reports"); }, icon: "chart", perm: "reports.read" }],
  },
  {
    get title() { return t("nav.administration"); },
    items: [
      { to: "/users", get label() { return t("common.users"); }, icon: "users", perm: "users.read" },
      { to: "/roles", get label() { return t("common.rolesPermissions"); }, icon: "shield", perm: "roles.read" },
      { to: "/audit", get label() { return t("common.auditLog"); }, icon: "log", perm: "audit.read" },
      { to: "/settings", get label() { return t("common.settings"); }, icon: "settings" },
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
