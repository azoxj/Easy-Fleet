import { describe, expect, it } from "vitest";
import { can, NAV, visibleNav } from "./permissions";
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
    expect(driver).toEqual(["/", "/my-assignments", "/vehicles"]);
    const admin = visibleNav(me(Object.fromEntries(["dashboard.view", "projects.read", "vehicles.read", "employees.read", "drivers.read", "assignments.read", "users.read", "roles.read", "audit.read"].map((k) => [k, "ALL" as const]))), NAV);
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
