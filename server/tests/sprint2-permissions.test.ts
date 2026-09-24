import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { ROLES } from "../src/auth/permissions.js";
import { setClock } from "../src/lib/clock.js";
import { createDriverFor, createEmployee, createProject, createUser, createVehicle, login, uid, userAndClient } from "./helpers.js";

beforeEach(() => setClock(new Date("2026-06-15T09:00:00Z")));
afterEach(() => setClock(null));

describe("Sprint 2 permission grants", () => {
  it("are least-privilege per role", () => {
    const g = (r: keyof typeof ROLES) => ROLES[r].grants as Record<string, string>;
    // Only SUPER_ADMIN archives people or deletes documents.
    for (const role of ["PROJECT_MANAGER", "FINANCE", "TECHNICAL", "USER", "DRIVER", "VIEWER"] as const) {
      expect(g(role)["employees.archive"], role).toBeUndefined();
      expect(g(role)["drivers.archive"], role).toBeUndefined();
      expect(g(role)["vehicle_documents.delete"], role).toBeUndefined();
    }
    // Employee PII is limited to managers of the project (and a driver's own record).
    for (const role of ["FINANCE", "TECHNICAL", "USER", "VIEWER"] as const) expect(g(role)["employees.read"], role).toBeUndefined();
    expect(g("DRIVER")["employees.read"]).toBe("ASSIGNED");
    expect(g("PROJECT_MANAGER")["employees.update"]).toBe("PROJECT");
    // Read-only roles never write documents.
    for (const role of ["FINANCE", "TECHNICAL", "USER", "DRIVER", "VIEWER"] as const) {
      for (const p of ["vehicle_documents.create", "registration.create", "insurance.create", "insurance.update"]) expect(g(role)[p], `${role} ${p}`).toBeUndefined();
    }
    expect(g("FINANCE")["insurance.read"]).toBe("ALL");
    expect(g("USER")["insurance.read"]).toBeUndefined();
  });

  it("security #6: a regular user cannot grant themselves a permission", async () => {
    const { user, client } = await userAndClient(["PROJECT_MANAGER"]);
    expect((await client.put(`/api/users/${user.id}/roles`, { roleKeys: ["SUPER_ADMIN"] })).status).toBe(403);
    expect((await client.post("/api/users", { name: "حساب جديد", email: `x-${uid()}@example.test`, roleKeys: ["SUPER_ADMIN"] })).status).toBe(403);
    expect((await client.post("/api/roles", { key: "X" })).status).toBe(404); // no role/permission write API exists
    expect((await client.put("/api/roles/permissions", {})).status).toBe(404);
    const me = await client.get("/api/auth/me");
    expect(me.body.data.permissions["employees.archive"]).toBeUndefined();
    // even SUPER_ADMIN cannot edit their own roles
    const { user: admin, client: ac } = await userAndClient(["SUPER_ADMIN"]);
    expect((await ac.put(`/api/users/${admin.id}/roles`, { roleKeys: ["SUPER_ADMIN", "FINANCE"] })).status).toBe(400);
  });

  it("security #8: responses the caller is not entitled to contain no sensitive data", async () => {
    const pm = await createUser(["PROJECT_MANAGER"]);
    const pA = await createProject({ managerId: pm.id });
    const pB = await createProject();
    const secret = "1987654321";
    const e = await createEmployee(pB.id, { nationalId: secret, phone: "+966511111111" });
    const pmc = await login(pm.email);
    const res = await pmc.get(`/api/employees/${e.id}`);
    expect(res.status).toBe(404);
    expect(JSON.stringify(res.body)).not.toContain(secret);
    expect(JSON.stringify(res.body)).not.toContain("+966511111111");
    // search endpoint never includes employees or national ids
    const search = await pmc.get(`/api/search?q=${secret}`);
    expect(JSON.stringify(search.body)).not.toContain(secret);
    // driver list never includes national ids
    await createDriverFor((await createEmployee(pA.id, { nationalId: "1122334455" })).id);
    expect(JSON.stringify((await pmc.get("/api/drivers?pageSize=100")).body)).not.toContain("1122334455");
  });
});

describe("dashboard — expiring items", () => {
  it("counts expired + expiring (≤30 days) items within scope only", async () => {
    const pm = await createUser(["PROJECT_MANAGER"]);
    const pA = await createProject({ managerId: pm.id });
    const pB = await createProject();
    const { client: admin } = await userAndClient(["SUPER_ADMIN"]);
    const vA = await createVehicle(pA.id);
    const vA2 = await createVehicle(pA.id);
    const vB = await createVehicle(pB.id);
    await admin.post(`/api/vehicles/${vA.id}/registration`, { documentNumber: "R-1", expiryDate: "2026-07-01" }); // soon
    await admin.post(`/api/vehicles/${vA2.id}/registration`, { documentNumber: "R-2", expiryDate: "2027-07-01" }); // active
    await admin.post(`/api/vehicles/${vB.id}/registration`, { documentNumber: "R-3", expiryDate: "2026-01-01" }); // expired, other project
    await admin.post(`/api/vehicles/${vA.id}/insurance`, { provider: "مزود تجريبي", policyNumber: `P-${uid()}`, expiryDate: "2026-05-01", coverageType: "OTHER" }); // expired
    await createDriverFor((await createEmployee(pA.id)).id, { licenseExpiryDate: "2026-06-30" }); // soon
    const res = await (await login(pm.email)).get("/api/dashboard");
    expect(res.body.data.expiring).toEqual({ registrations: 1, insurance: 1, documents: 0, licenses: 1, total: 3 });
    const { client: viewer } = await userAndClient(["VIEWER"]);
    const v = await viewer.get("/api/dashboard");
    expect(v.body.data.expiring.licenses).toBeNull(); // no drivers.read → not counted
  });
});
