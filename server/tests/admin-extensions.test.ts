import { and, eq } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { db } from "../src/db/client.js";
import { accidents, assignments, auditLogs, notifications, sessions, users, vehicles } from "../src/db/schema/index.js";
import { setClock } from "../src/lib/clock.js";
import { createDriverUser, createEmployee, createMaintenance, createProject, createUser, createVehicle, defaultOrgId, login, PDF_BYTES, userAndClient } from "./helpers.js";

beforeEach(() => setClock(new Date("2026-06-15T09:00:00Z")));
afterEach(() => setClock(null));

describe("assignments — typed references, edit, delete", () => {
  it("ACCIDENT assignment resolves project from the record; PATCH reassigns; DELETE keeps audit copy", async () => {
    const pm = await createUser(["PROJECT_MANAGER"]);
    const tech = await createUser(["TECHNICAL"]);
    const pA = await createProject({ managerId: pm.id, members: [tech.id] });
    const vA = await createVehicle(pA.id);
    const pmc = await login(pm.email);
    const acc = (await pmc.post("/api/accidents", { vehicleId: vA.id, occurredAt: "2026-06-14T10:00:00Z", description: "حادث للمتابعة", severity: "MINOR" })).body.data;
    const a = await pmc.post("/api/assignments", { type: "ACCIDENT", referenceId: acc.id, assignedTo: tech.id, title: "متابعة الحادث مع التأمين" });
    expect(a.status).toBe(201);
    expect(a.body.data).toMatchObject({ projectId: pA.id, vehicleId: vA.id, referenceId: acc.id });
    // accident in another project is not reachable
    const other = await createVehicle((await createProject()).id);
    const stranger = await createUser(["SUPER_ADMIN"]);
    const [foreignAcc] = await db.insert(accidents).values({ organizationId: pm.orgId, vehicleId: other.id, projectId: other.projectId, occurredAt: new Date(), description: "x", severity: "MINOR", createdBy: stranger.id }).returning();
    expect((await pmc.post("/api/assignments", { type: "ACCIDENT", referenceId: foreignAcc!.id, assignedTo: tech.id, title: "x1" })).status).toBe(404);
    // PATCH: title + reassign to a non-member is refused
    const outsider = await createUser(["USER"]);
    expect((await pmc.patch(`/api/assignments/${a.body.data.id}`, { assignedTo: outsider.id })).status).toBe(400);
    expect((await pmc.patch(`/api/assignments/${a.body.data.id}`, { title: "متابعة مطالبة التأمين", priority: "HIGH" })).body.data).toMatchObject({ title: "متابعة مطالبة التأمين", priority: "HIGH" });
    // the assignee cannot delete; the PM can
    const tc = await login(tech.email);
    expect((await tc.delete(`/api/assignments/${a.body.data.id}`)).status).toBe(403);
    expect((await pmc.delete(`/api/assignments/${a.body.data.id}`)).status).toBe(204);
    expect(await db.select().from(assignments).where(eq(assignments.id, a.body.data.id))).toHaveLength(0);
    const [aud] = await db.select().from(auditLogs).where(and(eq(auditLogs.entityId, a.body.data.id), eq(auditLogs.action, "ASSIGNMENT_DELETED")));
    expect(aud!.oldValue).toMatchObject({ title: "متابعة مطالبة التأمين" });
  });
});

describe("projects — archive (delete) and dashboard", () => {
  it("archive refused while dependencies exist; dashboard counts from DB", async () => {
    const { client: admin } = await userAndClient(["SUPER_ADMIN"]);
    const p = await createProject();
    const v = await createVehicle(p.id);
    const dash = (await admin.get(`/api/projects/${p.id}/dashboard`)).body.data;
    expect(dash.counts).toMatchObject({ vehicles: 1, openMaintenance: 0 });
    const r = await admin.delete(`/api/projects/${p.id}`);
    expect(r.status).toBe(409);
    expect(r.body.error.code).toBe("HAS_DEPENDENCIES");
    await db.update(vehicles).set({ status: "ARCHIVED" }).where(eq(vehicles.id, v.id));
    expect((await admin.delete(`/api/projects/${p.id}`)).body.data.status).toBe("ARCHIVED");
    // PM does not hold projects.delete
    const pm = await createUser(["PROJECT_MANAGER"]);
    const own = await createProject({ managerId: pm.id });
    expect((await (await login(pm.email)).delete(`/api/projects/${own.id}`)).status).toBe(403);
  });
});

describe("users — delete (deactivate) and aliases", () => {
  it("deactivates, revokes sessions, removes memberships, cancels open assignments; never self / last admin", async () => {
    const { client: admin, user: adminUser } = await userAndClient(["SUPER_ADMIN"]);
    const victim = await createUser(["USER"]);
    const p = await createProject({ members: [victim.id] });
    await login(victim.email);
    await db.insert(assignments).values({ organizationId: victim.orgId, type: "TASK", assignedTo: victim.id, assignedBy: adminUser.id, projectId: p.id, title: "مهمة" });
    expect((await admin.delete(`/api/users/${adminUser.id}`)).status).toBe(400);
    expect((await admin.delete(`/api/users/${victim.id}`)).status).toBe(204);
    const [u] = await db.select().from(users).where(eq(users.id, victim.id));
    expect(u!.status).toBe("DISABLED");
    const active = await db.select().from(sessions).where(and(eq(sessions.userId, victim.id)));
    expect(active.every((s) => s.revokedAt !== null)).toBe(true);
    const [asg] = await db.select().from(assignments).where(eq(assignments.assignedTo, victim.id));
    expect(asg!.status).toBe("CANCELLED");
    await expect(login(victim.email)).rejects.toThrow();
    const { client: pmc } = await userAndClient(["PROJECT_MANAGER"]);
    expect((await pmc.delete(`/api/users/${victim.id}`)).status).toBe(403);
  });
});

describe("vendors, settings, approvals, notifications", () => {
  it("vendor PATCH with tax number/address/status; duplicates rejected", async () => {
    const { client: fc } = await userAndClient(["FINANCE"]);
    const v = (await fc.post("/api/vendors", { name: `ورشة ${Date.now()}`, taxNumber: "300000000000003", address: "الرياض" })).body.data;
    expect(v.taxNumber).toBe("300000000000003");
    expect((await fc.post("/api/vendors", { name: v.name })).status).toBe(409);
    expect((await fc.post("/api/vendors", { name: "مورد رقم خطأ", taxNumber: "abc" })).status).toBe(400);
    expect((await fc.patch(`/api/vendors/${v.id}`, { status: "INACTIVE" })).body.data.status).toBe("INACTIVE");
    const active = (await fc.get("/api/vendors")).body.data.map((x: { id: string }) => x.id);
    expect(active).not.toContain(v.id);
    expect((await fc.get("/api/vendors?status=ALL")).body.data.map((x: { id: string }) => x.id)).toContain(v.id);
    const { client: viewer } = await userAndClient(["VIEWER"]);
    expect((await viewer.post("/api/vendors", { name: "x-vendor" })).status).toBe(403);
  });

  it("company settings (admin only) and system info without secrets", async () => {
    const { client: admin } = await userAndClient(["SUPER_ADMIN"]);
    const { client: pmc } = await userAndClient(["PROJECT_MANAGER"]);
    expect((await pmc.get("/api/settings/company")).body.meta.canEdit).toBe(false);
    expect((await pmc.put("/api/settings/company", { phone: "+966500000000" })).status).toBe(403);
    expect((await admin.put("/api/settings/company", { taxNumber: "123" })).status).toBe(400);
    const r = await admin.put("/api/settings/company", { legalName: "شركة الأسطول المحدودة", taxNumber: "300000000000003", crNumber: "1010101010", settings: { vatRate: 15, currency: "SAR" } });
    expect(r.status).toBe(200);
    expect(r.body.data).toMatchObject({ legalName: "شركة الأسطول المحدودة", settings: { vatRate: 15 } });
    expect((await admin.put("/api/settings/company", { settings: { unknownKey: 1 } })).status).toBe(400);
    const sys = await admin.get("/api/settings/system");
    expect(sys.status).toBe(200);
    expect(sys.body.data.database.migrationsApplied).toBeGreaterThanOrEqual(5);
    const text = JSON.stringify(sys.body);
    expect(text).not.toContain(process.env.DATABASE_URL!);
    expect(text).not.toMatch(/password|secret/i);
    expect((await pmc.get("/api/settings/system")).status).toBe(403);
  });

  it("approval center lists items waiting for the caller only", async () => {
    const pm = await createUser(["PROJECT_MANAGER"]);
    const p = await createProject({ managerId: pm.id });
    const v = await createVehicle(p.id);
    const mr = await createMaintenance(v, pm.id, { status: "PENDING_APPROVAL" });
    const pmc = await login(pm.email);
    const items = (await pmc.get("/api/approvals")).body;
    expect(items.data.find((i: { id: string }) => i.id === mr.id)).toMatchObject({ kind: "MAINTENANCE_APPROVAL", label: `MR-${mr.number}` });
    const { client: otherPm } = await userAndClient(["PROJECT_MANAGER"]);
    expect((await otherPm.get("/api/approvals")).body.data.find((i: { id: string }) => i.id === mr.id)).toBeUndefined();
    const { client: dc } = await userAndClient(["DRIVER"]);
    expect((await dc.get("/api/approvals")).body.data).toEqual([]);
  });

  it("notification preferences suppress a category (SYSTEM cannot be disabled); category/state filters", async () => {
    const { client: admin } = await userAndClient(["SUPER_ADMIN"]);
    const u = await createUser(["USER"]);
    const uc = await login(u.email);
    await uc.put("/api/notifications/preferences", { preferences: [{ category: "FINANCE", enabled: false }, { category: "SYSTEM", enabled: false }] });
    const prefs = (await uc.get("/api/notifications/preferences")).body.data;
    expect(prefs.find((p: { category: string }) => p.category === "FINANCE").enabled).toBe(false);
    expect(prefs.find((p: { category: string }) => p.category === "SYSTEM").enabled).toBe(true);
    expect((await admin.post("/api/notifications/broadcast", { title: "صيانة النظام الليلة" })).status).toBe(201);
    const { notifyUsers } = await import("../src/services/notifications.js");
    const sent = await notifyUsers(db, { orgId: u.orgId, userIds: [u.id], type: "INVOICE_APPROVED", title: "x" });
    expect(sent).toEqual([]);
    const list = (await uc.get("/api/notifications?category=SYSTEM&state=unread")).body.data;
    expect(list.length).toBe(1);
    expect((await uc.get("/api/notifications?category=FINANCE")).body.data).toHaveLength(0);
    const { client: pmc } = await userAndClient(["PROJECT_MANAGER"]);
    expect((await pmc.post("/api/notifications/broadcast", { title: "رسالة للجميع" })).status).toBe(403);
    const mine = await db.select().from(notifications).where(eq(notifications.userId, u.id));
    expect(mine.every((n) => n.category === "SYSTEM")).toBe(true);
  });
});

describe("employee documents, documents center, search, vehicle fields, timeline filtering", () => {
  it("employee documents CRUD with expiry status; documents center scoped and filterable", async () => {
    const pm = await createUser(["PROJECT_MANAGER"]);
    const p = await createProject({ managerId: pm.id });
    const e = await createEmployee(p.id);
    const pmc = await login(pm.email);
    const d = await pmc.post(`/api/employees/${e.id}/documents`, { documentType: "IQAMA", documentNumber: "2400000001", issueDate: "2025-01-01", expiryDate: "2026-06-20" });
    expect(d.status).toBe(201);
    expect(d.body.data.status).toBe("EXPIRING_SOON");
    expect((await pmc.post(`/api/employees/${e.id}/documents`, { documentType: "PASSPORT", issueDate: "2026-01-01", expiryDate: "2025-01-01" })).status).toBe(400);
    expect((await pmc.upload(`/api/employee-documents/${d.body.data.id}/file`, PDF_BYTES)).status).toBe(201);
    expect((await pmc.get(`/api/employee-documents/${d.body.data.id}/file`)).status).toBe(200);
    expect((await pmc.delete(`/api/employee-documents/${d.body.data.id}`)).status).toBe(403); // PM lacks documents.delete
    const center = (await pmc.get("/api/documents-center?status=EXPIRING_SOON")).body;
    expect(center.data.find((x: { id: string }) => x.id === d.body.data.id)).toMatchObject({ kind: "EMPLOYEE", type: "IQAMA", status: "EXPIRING_SOON" });
    expect(center.summary.EXPIRING_SOON).toBeGreaterThanOrEqual(1);
    const { client: otherPm } = await userAndClient(["PROJECT_MANAGER"]);
    expect((await otherPm.get(`/api/employee-documents/${d.body.data.id}/file`)).status).toBe(404);
    expect((await otherPm.get("/api/documents-center")).body.data.find((x: { id: string }) => x.id === d.body.data.id)).toBeUndefined();
    const { client: admin } = await userAndClient(["SUPER_ADMIN"]);
    expect((await admin.delete(`/api/employee-documents/${d.body.data.id}`)).status).toBe(204);
    expect((await pmc.get(`/api/employees/${e.id}/documents`)).body.data).toHaveLength(0);
  });

  it("vehicle Arabic/English plate + serial; global search finds employees/maintenance only in scope", async () => {
    const pm = await createUser(["PROJECT_MANAGER"]);
    const p = await createProject({ managerId: pm.id });
    const { client: admin } = await userAndClient(["SUPER_ADMIN"]);
    const v = await admin.post("/api/vehicles", { plateNumber: "ABC-1234", plateArabic: "أ ب ج 1234", plateEnglish: "abc 1234", serialNumber: "987654321", make: "تويوتا", model: "هايلكس", projectId: p.id });
    expect(v.status).toBe(201);
    expect(v.body.data).toMatchObject({ plateArabic: "أ ب ج 1234", plateEnglish: "ABC 1234", serialNumber: "987654321" });
    expect((await admin.post("/api/vehicles", { plateNumber: "X-1", plateArabic: "abc", make: "a", model: "b" })).status).toBe(400);
    const e = await createEmployee(p.id, { fullName: "خالد البحث الفريد" });
    const e2 = await createEmployee((await createProject()).id, { fullName: "خالد البحث الآخر" });
    const pmc = await login(pm.email);
    const s = (await pmc.get(`/api/search?q=${encodeURIComponent("خالد البحث")}`)).body.data;
    expect(s.employees.map((x: { id: string }) => x.id)).toContain(e.id);
    expect(s.employees.map((x: { id: string }) => x.id)).not.toContain(e2.id);
    const s2 = (await pmc.get(`/api/search?q=${encodeURIComponent("ب ج 12")}`)).body.data;
    expect(s2.vehicles.map((x: { id: string }) => x.id)).toContain(v.body.data.id);
    const mr = await createMaintenance({ id: v.body.data.id, projectId: p.id }, pm.id);
    expect((await pmc.get(`/api/search?q=MR-${mr.number}`)).body.data.maintenance[0].id).toBe(mr.id);
  });

  it("vehicle timeline hides modules the caller cannot read; driver change needs drivers.assign", async () => {
    const pm = await createUser(["PROJECT_MANAGER"]);
    const p = await createProject({ managerId: pm.id });
    const v = await createVehicle(p.id);
    const drv = await createDriverUser(p.id);
    const pmc = await login(pm.email);
    expect((await pmc.put(`/api/vehicles/${v.id}/driver`, { driverId: drv.driver.id })).status).toBe(200);
    await pmc.post("/api/violations", { vehicleId: v.id, violationDate: "2026-06-10", type: "سرعة", amount: "150" });
    await pmc.post("/api/expenses", { projectId: p.id, vehicleId: v.id, category: "OTHER", amount: "10", expenseDate: "2026-06-10" });
    const dc = await login(drv.user.email);
    const tl = (await dc.get(`/api/vehicles/${v.id}/timeline`)).body.data.map((x: { entity: string }) => x.entity);
    expect(tl).toContain("vehicle");
    expect(tl).toContain("violation"); // driver has violations.read
    expect(tl).not.toContain("expense"); // no finance.read
    // TECHNICAL holds vehicles.update (ASSIGNED) but not drivers.assign
    const tech = await createUser(["TECHNICAL"]);
    const tc = await login(tech.email);
    expect((await tc.put(`/api/vehicles/${v.id}/driver`, { driverId: null })).status).toBe(403);
    void defaultOrgId;
  });
});
