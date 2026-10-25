import { describe, expect, it } from "vitest";
import { can, isFinanceOnlyUser, NAV, visibleNav } from "./permissions";
import type { Me } from "./types";

const me = (permissions: Me["permissions"]): Me => ({ id: "1", email: "a@example.test", name: "a", mustChangePassword: false, roles: [], permissions, projectIds: [], csrfToken: "t" });

describe("permission helpers (UI only)", () => {
  it("respects scope hierarchy", () => {
    const m = me({ "vehicles.read": "PROJECT" });
    expect(can(m, "vehicles.read")).toBe(true);
    expect(can(m, "vehicles.read", "PROJECT")).toBe(true);
    expect(can(m, "vehicles.read", "ALL")).toBe(false);
    expect(can(m, "vehicles.create")).toBe(false);
    expect(can(null, "vehicles.read")).toBe(false);
  });

  it("filters navigation by permission", () => {
    const driver = visibleNav(me({ "dashboard.view": "ASSIGNED", "vehicles.read": "ASSIGNED" }), NAV).map((n) => n.to);
    expect(driver).toEqual(["/", "/my-assignments", "/vehicles", "/settings"]);
    const perms = new Set(NAV.flatMap((n) => [n.perm, ...(n.anyOf ?? [])]).filter((p): p is string => !!p));
    const admin = visibleNav(me(Object.fromEntries([...perms].map((k) => [k, "ALL" as const]))), NAV);
    expect(admin).toHaveLength(NAV.length);
  });
});

describe("Sprint 2 navigation", () => {
  it("shows employees/drivers only with the matching permission", () => {
    const pm = visibleNav(me({ "dashboard.view": "PROJECT", "employees.read": "PROJECT", "drivers.read": "PROJECT" }), NAV).map((n) => n.to);
    expect(pm).toContain("/employees");
    expect(pm).toContain("/drivers");
    const viewer = visibleNav(me({ "dashboard.view": "PROJECT", "vehicles.read": "PROJECT" }), NAV).map((n) => n.to);
    expect(viewer).not.toContain("/employees");
    expect(viewer).not.toContain("/drivers");
  });
});

describe("full-system navigation", () => {
  it("driver sees tracking, handovers and fuel but no finance or admin", () => {
    const d = visibleNav(me({ "dashboard.view": "ASSIGNED", "vehicles.read": "ASSIGNED", "fuel.read": "ASSIGNED", "handover.read": "ASSIGNED", "gps.track": "ASSIGNED", "notifications.read": "ASSIGNED" }), NAV).map((n) => n.to);
    expect(d).toEqual(expect.arrayContaining(["/tracking", "/handovers", "/fuel", "/notifications"]));
    expect(d).not.toContain("/finance");
    expect(d).not.toContain("/map");
    expect(d).not.toContain("/users");
  });
  it("finance sees invoices, expenses, reports and approvals", () => {
    const f = visibleNav(me({ "invoices.read": "ALL", "finance.read": "ALL", "invoices.approve": "ALL", "reports.read": "ALL" }), NAV).map((n) => n.to);
    expect(f).toEqual(expect.arrayContaining(["/finance", "/finance/invoices", "/finance/expenses", "/reports", "/approvals"]));
  });
});

describe("finance-only navigation (ACCOUNTANT / FINANCE)", () => {
  const financePerms: Me["permissions"] = {
    "dashboard.view": "ALL", "vehicles.read": "ALL", "projects.read": "ALL", "maintenance.read": "ALL", "drivers.read": "ALL", "fuel.read": "ALL",
    "finance.read": "ALL", "invoices.read": "ALL", "finance.approve": "ALL", "reports.read": "ALL", "notifications.read": "ASSIGNED", "vendors.manage": "ALL", "users.read": "ALL",
  };
  const withRoles = (roles: string[], permissions = financePerms): Me => ({ ...me(permissions), roles });

  it.each(["ACCOUNTANT", "FINANCE"])("%s sees only the finance pages", (role) => {
    const to = visibleNav(withRoles([role]), NAV).map((n) => n.to);
    expect(to).toEqual(["/approvals", "/notifications", "/finance", "/finance/invoices", "/finance/expenses", "/vendors", "/reports"]);
    for (const hidden of ["/", "/vehicles", "/drivers", "/projects", "/maintenance", "/users", "/roles", "/settings", "/fuel", "/map"]) expect(to).not.toContain(hidden);
  });

  it("does not change the permissions or the menu of other roles", () => {
    const all = Object.fromEntries([...new Set(NAV.flatMap((n) => [n.perm, ...(n.anyOf ?? [])]).filter((p): p is string => !!p))].map((k) => [k, "ALL" as const]));
    expect(visibleNav(withRoles(["SUPER_ADMIN"], all), NAV)).toHaveLength(NAV.length);
    expect(visibleNav(withRoles(["PROJECT_MANAGER"], financePerms), NAV).map((n) => n.to)).toEqual(expect.arrayContaining(["/", "/vehicles", "/maintenance", "/settings"]));
    expect(visibleNav(withRoles(["SUPER_ADMIN", "FINANCE"], all), NAV)).toHaveLength(NAV.length);
    expect(visibleNav(withRoles([], financePerms), NAV).map((n) => n.to)).toContain("/vehicles");
  });

  it("detects a finance-only user only when every role is a finance role", () => {
    expect(isFinanceOnlyUser(withRoles(["ACCOUNTANT"]))).toBe(true);
    expect(isFinanceOnlyUser(withRoles(["FINANCE", "VIEWER"]))).toBe(false);
    expect(isFinanceOnlyUser(null)).toBe(false);
  });
});

describe("PROJECT_MANAGER navigation (permissions as granted by the server)", () => {
  const pmPerms = Object.fromEntries(
    ["dashboard.view", "projects.read", "vehicles.read", "vehicles.create", "vehicles.update", "assignments.read", "assignments.create", "employees.read", "drivers.read", "maintenance.read", "maintenance.approve", "maintenance.handover", "maintenance.parts.read", "documents.read", "reports.read", "accidents.read", "violations.read", "fuel.read", "handover.read", "handover.manage", "gps.read"].map((k) => [k, "PROJECT" as const]),
  ) as Me["permissions"];
  const nav = visibleNav({ ...me({ ...pmPerms, "notifications.read": "ASSIGNED" }), roles: ["PROJECT_MANAGER"] }, NAV).map((n) => n.to);

  it("shows the project work menus", () => {
    expect(nav).toEqual(expect.arrayContaining(["/", "/approvals", "/maintenance", "/handovers", "/fuel", "/accidents", "/violations", "/assignments", "/map", "/vehicles", "/drivers", "/employees", "/projects", "/documents", "/reports", "/notifications"]));
  });

  it("hides finance, vendors and administration", () => {
    for (const hidden of ["/finance", "/finance/invoices", "/finance/expenses", "/vendors", "/users", "/roles", "/audit"]) expect(nav).not.toContain(hidden);
  });

  it("is not treated as a finance-only user", () => {
    expect(isFinanceOnlyUser({ roles: ["PROJECT_MANAGER"] })).toBe(false);
  });
});
