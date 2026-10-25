import { describe, expect, it } from "vitest";
import { ALL_PERMISSION_KEYS, ROLES } from "../src/auth/permissions.js";
import { createDriverFor, createDriverUser, createEmployee, createMaintenance, createProject, createUser, createVehicle, login, PDF_BYTES, uid, userAndClient } from "./helpers.js";

/** The exact permission set of PROJECT_MANAGER (all PROJECT scope except notifications = ASSIGNED). */
const PM_GRANTS = [
  "dashboard.view",
  "projects.read",
  "vehicles.read", "vehicles.create", "vehicles.update",
  "assignments.read", "assignments.create", "assignments.manage", "assignments.update", "assignments.delete",
  "employees.read", "employees.create", "employees.update",
  "drivers.read", "drivers.create", "drivers.update", "drivers.assign",
  "vehicle_documents.read", "vehicle_documents.create", "vehicle_documents.update",
  "registration.read", "registration.create", "registration.update",
  "insurance.read", "insurance.create", "insurance.update",
  "maintenance.read", "maintenance.create", "maintenance.update", "maintenance.assign", "maintenance.approve", "maintenance.reject", "maintenance.handover", "maintenance.close",
  "maintenance.parts.read", "maintenance.parts.manage", "maintenance.labor.read", "maintenance.labor.manage",
  "documents.read", "documents.upload",
  "reports.read", "reports.export",
  "notifications.read",
  "accidents.read", "accidents.create", "accidents.update",
  "violations.read", "violations.create", "violations.update",
  "fuel.read", "fuel.create",
  "handover.read", "handover.create", "handover.manage",
  "gps.read",
].sort();

describe("PROJECT_MANAGER — permission set", () => {
  it("holds exactly the project-management permissions, every one project-scoped", () => {
    const g = ROLES.PROJECT_MANAGER.grants as Record<string, string>;
    expect(Object.keys(g).sort()).toEqual(PM_GRANTS);
    for (const [k, scope] of Object.entries(g)) expect(scope, k).toBe(k === "notifications.read" ? "ASSIGNED" : "PROJECT");
    for (const k of Object.keys(g)) expect(ALL_PERMISSION_KEYS as string[]).toContain(k);
  });

  it("holds nothing financial, no user/role/audit/settings administration and no archive or delete right", () => {
    const keys = Object.keys(ROLES.PROJECT_MANAGER.grants);
    for (const k of keys) {
      expect(k, k).not.toMatch(/^(finance|invoices|users|roles|audit|settings|integrations|members|vendors)\./);
      if (!k.startsWith("assignments.")) expect(k, k).not.toMatch(/\.(archive|delete)$/); // assignments.delete only cancels an assignment
    }
    for (const k of ["maintenance.quote.read", "maintenance.quote.create", "maintenance.quote.approve", "projects.update", "projects.create", "projects.members.manage", "notifications.manage"]) expect(keys).not.toContain(k);
  });

  it("leaves the other roles untouched", () => {
    expect(Object.keys(ROLES.SUPER_ADMIN.grants).length).toBe(ALL_PERMISSION_KEYS.length);
    const f = ROLES.FINANCE.grants as Record<string, string>;
    for (const k of ["finance.read", "finance.create", "finance.approve", "invoices.read", "invoices.approve", "maintenance.quote.read", "maintenance.quote.approve", "vendors.manage", "reports.read"]) expect(f[k], k).toBe("ALL");
    const t = ROLES.TECHNICAL.grants as Record<string, string>;
    for (const k of ["maintenance.quote.read", "maintenance.quote.create", "maintenance.parts.read", "maintenance.parts.manage"]) expect(t[k], k).toBe("ASSIGNED");
    expect((ROLES.VIEWER.grants as Record<string, string>)["projects.read"]).toBe("PROJECT");
  });
});

/** Project A (the manager's) and project B (someone else's), with one record of every kind in B. */
async function world() {
  const pm = await createUser(["PROJECT_MANAGER"]);
  const pmB = await createUser(["PROJECT_MANAGER"]);
  const pA = await createProject({ managerId: pm.id });
  const pB = await createProject({ managerId: pmB.id });
  const { client: sa } = await userAndClient(["SUPER_ADMIN"]);
  const c = await login(pm.email);

  const vA = await createVehicle(pA.id);
  const vB = await createVehicle(pB.id);
  const eA = await createEmployee(pA.id);
  const eB = await createEmployee(pB.id);
  const dA = await createDriverFor((await createEmployee(pA.id)).id);
  const dB = await createDriverFor((await createEmployee(pB.id)).id);
  const mrA = await createMaintenance(vA, pm.id);
  const mrB = await createMaintenance(vB, pmB.id);
  const fuelB = (await sa.post("/api/fuel", { vehicleId: vB.id, fueledAt: "2026-06-14T10:00:00Z", liters: 10, pricePerLiter: 2 })).body.data;
  const fuelA = (await sa.post("/api/fuel", { vehicleId: vA.id, fueledAt: "2026-06-14T10:00:00Z", liters: 20, pricePerLiter: 2 })).body.data;
  const accB = (await sa.post("/api/accidents", { vehicleId: vB.id, occurredAt: "2026-06-14T10:00:00Z", description: "حادث المشروع الآخر", severity: "MINOR" })).body.data;
  const vioB = (await sa.post("/api/violations", { vehicleId: vB.id, violationDate: "2026-06-14", type: "سرعة", amount: "100" })).body.data;
  const drvB = await createDriverUser(pB.id);
  const hoVehicleB = await createVehicle(pB.id);
  const hoB = (await sa.post("/api/handovers", { vehicleId: hoVehicleB.id, driverId: drvB.driver.id })).body.data;
  const docB = (await sa.post(`/api/employees/${eB.id}/documents`, { documentType: "CONTRACT" })).body.data;
  return { pm, pmB, pA, pB, sa, c, vA, vB, eA, eB, dA, dB, mrA, mrB, fuelA, fuelB, accB, vioB, hoB, docB, hoVehicleB };
}

describe("PROJECT_MANAGER — own project works", () => {
  it("reads and manages the records of his own project", async () => {
    const w = await world();
    const ids = (r: { body: { data: { id: string }[] } }) => r.body.data.map((x) => x.id);
    expect(ids(await w.c.get("/api/vehicles?pageSize=100"))).toEqual([w.vA.id]);
    expect(ids(await w.c.get("/api/employees?pageSize=100"))).toContain(w.eA.id);
    expect(ids(await w.c.get("/api/employees?pageSize=100"))).not.toContain(w.eB.id);
    expect(ids(await w.c.get("/api/projects?pageSize=100"))).toEqual([w.pA.id]);
    expect(ids(await w.c.get("/api/maintenance?pageSize=100"))).toEqual([w.mrA.id]);
    expect(ids(await w.c.get("/api/fuel?pageSize=100"))).toEqual([w.fuelA.id]);
    expect((await w.c.get(`/api/vehicles/${w.vA.id}`)).status).toBe(200);
    expect((await w.c.patch(`/api/vehicles/${w.vA.id}`, { color: "أبيض" })).status).toBe(200);
    expect((await w.c.get(`/api/drivers/${w.dA.id}`)).status).toBe(200);
    expect((await w.c.get("/api/dashboard")).status).toBe(200);
    expect((await w.c.get("/api/reports")).status).toBe(200);
    expect((await w.c.get("/api/documents-center")).status).toBe(200);
    expect((await w.c.get("/api/notifications")).status).toBe(200);
    expect((await w.c.get("/api/assignments")).status).toBe(200);
  });
});

describe("PROJECT_MANAGER — other projects are invisible and untouchable (server-side)", () => {
  it("answers 404 for every read of project B's records and files", async () => {
    const w = await world();
    const urls = [
      `/api/vehicles/${w.vB.id}`,
      `/api/vehicles/${w.vB.id}/timeline`,
      `/api/vehicles/${w.vB.id}/qr`,
      `/api/vehicles/${w.vB.id}/maintenance`,
      `/api/employees/${w.eB.id}`,
      `/api/employees/${w.eB.id}/documents`,
      `/api/employee-documents/${w.docB.id}/file`,
      `/api/drivers/${w.dB.id}`,
      `/api/maintenance/${w.mrB.id}`,
      `/api/maintenance/${w.mrB.id}/parts`,
      `/api/fuel/${w.fuelB.id}`,
      `/api/accidents/${w.accB.id}`,
      `/api/violations/${w.vioB.id}`,
      `/api/handovers/${w.hoB.id}`,
      `/api/projects/${w.pB.id}`,
      `/api/projects/${w.pB.id}/members`,
      `/api/projects/${w.pB.id}/dashboard`,
    ];
    for (const u of urls) expect((await w.c.get(u)).status, u).toBe(404);
  });

  it("answers 404/403 for every write aimed at project B or into project B", async () => {
    const w = await world();
    const n = uid();
    expect((await w.c.patch(`/api/vehicles/${w.vB.id}`, { color: "أسود" })).status).toBe(404);
    expect((await w.c.patch(`/api/vehicles/${w.vA.id}`, { projectId: w.pB.id })).status).toBe(403); // cannot move own vehicle out
    expect((await w.c.post("/api/vehicles", { plateNumber: `Z-${n}`, make: "a", model: "b", projectId: w.pB.id })).status).toBe(403);
    expect((await w.c.post("/api/employees", { employeeNumber: `E-${n}`, fullName: "موظف جديد", projectId: w.pB.id })).status).toBe(403);
    expect((await w.c.patch(`/api/employees/${w.eB.id}`, { phone: "+966500000009" })).status).toBe(404);
    expect((await w.c.patch(`/api/drivers/${w.dB.id}`, { licenseNumber: `L-${n}` })).status).toBe(404);
    expect((await w.c.post("/api/maintenance", { vehicleId: w.vB.id, issue: "عطل في مشروع آخر", priority: "LOW" })).status).toBe(404);
    expect((await w.c.post(`/api/maintenance/${w.mrB.id}/approve`)).status).toBe(404);
    expect((await w.c.post(`/api/maintenance/${w.mrB.id}/parts`, { partName: "قطعة", quantity: 1, unitPrice: 1 })).status).toBe(404);
    expect((await w.c.post("/api/fuel", { vehicleId: w.vB.id, fueledAt: "2026-06-14T10:00:00Z", liters: 1, pricePerLiter: 1 })).status).toBe(404);
    expect((await w.c.post("/api/accidents", { vehicleId: w.vB.id, occurredAt: "2026-06-14T10:00:00Z", description: "حادث آخر", severity: "MINOR" })).status).toBe(404);
    expect((await w.c.post(`/api/accidents/${w.accB.id}/status`, { to: "UNDER_REVIEW" })).status).toBe(404);
    expect((await w.c.patch(`/api/violations/${w.vioB.id}`, { amount: "1" })).status).toBe(404);
    expect((await w.c.post("/api/handovers", { vehicleId: w.hoVehicleB.id, driverId: w.dB.id })).status).toBe(404);
    expect((await w.c.post(`/api/handovers/${w.hoB.id}/rotate-link`)).status).toBe(404);
    expect((await w.c.post("/api/assignments", { type: "VEHICLE", referenceId: w.vB.id, assignedTo: w.pm.id, title: "إسناد" })).status).toBe(404);
    expect((await w.c.post("/api/assignments", { type: "PROJECT", referenceId: w.pB.id, assignedTo: w.pm.id, title: "إسناد" })).status).toBe(403);
  });

  it("lists, dashboard, search and reports never include project B", async () => {
    const w = await world();
    for (const u of ["/api/vehicles", "/api/employees", "/api/drivers", "/api/maintenance", "/api/fuel", "/api/accidents", "/api/violations", "/api/handovers", "/api/projects", "/api/documents-center", "/api/assignments", "/api/reports/vehicles", "/api/reports/maintenance", "/api/reports/fuel", "/api/reports/accidents", "/api/reports/violations", "/api/reports/drivers", "/api/reports/handovers", "/api/reports/projects"]) {
      const r = await w.c.get(`${u}${u.includes("?") ? "&" : "?"}pageSize=100`);
      expect(r.status, u).toBe(200);
      const text = JSON.stringify(r.body);
      for (const needle of [w.pB.id, w.vB.plateNumber, w.pB.code, "حادث المشروع الآخر"]) expect(text, `${u} leaks ${needle}`).not.toContain(needle);
    }
    const search = await w.c.get(`/api/search?q=${encodeURIComponent(w.vB.plateNumber)}`);
    expect(JSON.stringify(search.body)).not.toContain(w.vB.id);
    const dash = await w.c.get("/api/dashboard");
    expect(dash.body.data.projects.total).toBe(1);
    expect(dash.body.data.vehicles.total).toBe(1);
  });
});

describe("PROJECT_MANAGER — everything outside his job is closed by the server", () => {
  it("is forbidden from finance, vendors, users, roles, audit, settings and project administration", async () => {
    const w = await world();
    for (const u of ["/api/finance/dashboard", "/api/invoices", "/api/expenses", "/api/vendors", `/api/vendors/${uid()}`, "/api/users", "/api/roles", "/api/audit-logs", "/api/settings/system", "/api/settings/email", `/api/projects/${w.pA.id}/financials`, `/api/maintenance/${w.mrA.id}/quotes`, "/api/reports/invoices", "/api/reports/expenses", "/api/reports/vehicle-costs"]) {
      expect((await w.c.get(u)).status, u).toBeOneOf([403, 400]);
    }
    expect((await w.c.get("/api/vendors")).status).toBe(403);
    expect((await w.c.get("/api/invoices")).status).toBe(403);
    expect((await w.c.get("/api/users")).status).toBe(403);
    expect((await w.c.get(`/api/projects/${w.pA.id}/financials`)).status).toBe(403);
    expect((await w.c.get("/api/reports/invoices")).status).toBe(403);
    expect((await w.c.get("/api/reports/expenses")).status).toBe(403);
    expect((await w.c.get("/api/reports/vehicle-costs")).status).toBe(403);
    expect((await w.c.put("/api/settings/company", { name: "شركة" })).status).toBe(403);
    expect((await w.c.post("/api/vendors", { name: `ورشة ${uid()}` })).status).toBe(403);
    expect((await w.c.post("/api/invoices", { projectId: w.pA.id, amount: "1", invoiceDate: "2026-06-01" })).status).toBe(403);
    expect((await w.c.post("/api/expenses", { projectId: w.pA.id, category: "OTHER", amount: "1", expenseDate: "2026-06-01" })).status).toBe(403);
    expect((await w.c.post("/api/projects", { name: "مشروع جديد", code: `P-${uid()}` })).status).toBe(403);
    expect((await w.c.patch(`/api/projects/${w.pA.id}`, { description: "تعديل" })).status).toBe(403);
    expect((await w.c.post(`/api/projects/${w.pA.id}/members`, { userId: w.pmB.id })).status).toBe(403);
    expect((await w.c.post(`/api/vehicles/${w.vA.id}/archive`)).status).toBe(403);
    expect((await w.c.post(`/api/employees/${w.eA.id}/archive`)).status).toBe(403);
    expect((await w.c.post(`/api/drivers/${w.dA.id}/archive`)).status).toBe(403);
  });

  it("gets no financial figure on the dashboard (fuel and maintenance amounts stay)", async () => {
    const w = await world();
    const d = (await w.c.get("/api/dashboard")).body.data;
    expect(d.invoices).toBeNull();
    expect(d.monthlyCost).toBeNull();
    expect(d.charts.costs).toBeNull();
    expect(d.fuel).not.toBeNull();
    expect(d.charts.fuel).not.toBeNull();
    expect(d.maintenance).not.toBeNull();
    const reports = (await w.c.get("/api/reports")).body.data.map((r: { key: string }) => r.key);
    expect(reports).toEqual(expect.arrayContaining(["vehicles", "maintenance", "fuel", "accidents", "violations", "drivers", "handovers", "projects"]));
    for (const k of ["invoices", "expenses", "vehicle-costs"]) expect(reports).not.toContain(k);
    // project financial columns are empty for him
    const proj = (await w.c.get("/api/reports/projects")).body.data;
    expect(proj[0].costs).toBeNull();
    expect(proj[0].remaining).toBeNull();
  });

  it("never reaches the vendor directory through maintenance parts, even when a request is open", async () => {
    const w = await world();
    expect((await w.c.get("/api/vendors")).status).toBe(403);
    expect((await w.c.get(`/api/maintenance/${w.mrA.id}/parts`)).status).toBe(200); // the parts side of the job itself still works
    expect((await w.c.patch(`/api/vendors/${uid()}`, { notes: "x" })).status).toBe(403);
  });

  it("can pick co-members for his forms but nobody else", async () => {
    const w = await world();
    const member = await createUser(["USER"]);
    const stranger = await createUser(["USER"]);
    const p = await createProject({ managerId: w.pm.id, members: [member.id] });
    const r = await w.c.get(`/api/users/lookup/active?projectId=${p.id}`);
    expect(r.status).toBe(200);
    const ids = r.body.data.map((u: { id: string }) => u.id);
    expect(ids).toContain(member.id);
    expect(ids).not.toContain(stranger.id);
    expect(ids).not.toContain(w.pmB.id);
    expect((await w.c.get("/api/users")).status).toBe(403);
  });

  it("uploads of employee documents stay inside his project", async () => {
    const w = await world();
    const mine = await createEmployee(w.pA.id);
    const doc = await w.c.post(`/api/employees/${mine.id}/documents`, { documentType: "CONTRACT" });
    expect(doc.status).toBe(201);
    expect((await w.c.upload(`/api/employee-documents/${doc.body.data.id}/file`, PDF_BYTES)).status).toBe(201);
    expect((await w.c.post(`/api/employees/${w.eB.id}/documents`, { documentType: "CONTRACT" })).status).toBe(404);
  });
});
