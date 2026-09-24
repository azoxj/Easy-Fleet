import { and, eq } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { db } from "../src/db/client.js";
import { assignments, auditLogs, maintenanceEvents, maintenanceParts, notifications, permissions, projectUsers, rolePermissions, roles, userRoles, vehicles } from "../src/db/schema/index.js";
import { setClock } from "../src/lib/clock.js";
import { createMaintenance, createProject, createUser, createVehicle, login, PDF_BYTES, uid, userAndClient } from "./helpers.js";

beforeEach(() => setClock(new Date("2026-06-15T09:00:00Z")));
afterEach(() => setClock(null));

async function setup() {
  const pm = await createUser(["PROJECT_MANAGER"]);
  const tech = await createUser(["TECHNICAL"]);
  const fin = await createUser(["FINANCE"]);
  const pA = await createProject({ managerId: pm.id, members: [tech.id] });
  const vA = await createVehicle(pA.id, { currentOdometer: 42000 });
  return { pm, tech, fin, pA, vA, pmc: await login(pm.email), tc: await login(tech.email), fc: await login(fin.email) };
}

const notesOf = async (userId: string) => (await db.select().from(notifications).where(eq(notifications.userId, userId))).map((n) => n.type);

describe("maintenance — full workflow (happy path)", () => {
  it("REQUESTED → … → CLOSED with notifications, events, audit, costs and vehicle status", async () => {
    const { pm, tech, fin, vA, pmc, tc, fc } = await setup();

    // 1) PM creates — project derived from the vehicle, odometer defaults to the vehicle's
    const c = await pmc.post("/api/maintenance", { vehicleId: vA.id, issue: "صوت في الفرامل", description: "يظهر عند التوقف", priority: "HIGH" });
    expect(c.status).toBe(201);
    expect(c.body.data).toMatchObject({ status: "REQUESTED", projectId: vA.projectId, requestedBy: pm.id, odometer: 42000 });
    const id = c.body.data.id;

    // 2) Assign technician → notification + Assignments module entry
    expect((await pmc.post(`/api/maintenance/${id}/assign`, { technicianId: tech.id })).status).toBe(200);
    expect(await notesOf(tech.id)).toContain("MAINTENANCE_ASSIGNED");
    const mine = await tc.get("/api/assignments/mine");
    expect(mine.body.data.find((a: { type: string; referenceId: string }) => a.type === "MAINTENANCE_REQUEST" && a.referenceId === id)).toBeTruthy();

    // 3) Inspection + diagnosis (preconditions enforced)
    expect((await tc.post(`/api/maintenance/${id}/start-inspection`)).body.data.status).toBe("INSPECTION");
    expect((await tc.post(`/api/maintenance/${id}/complete-inspection`)).status).toBe(409); // no diagnosis
    expect((await tc.patch(`/api/maintenance/${id}`, { diagnosis: "تآكل فحمات الفرامل الأمامية" })).status).toBe(200);
    expect((await tc.post(`/api/maintenance/${id}/complete-inspection`)).body.data.status).toBe("QUOTE_PENDING");

    // 4) Parts & labor — totals computed by the server
    const part = await tc.post(`/api/maintenance/${id}/parts`, { partName: "فحمات فرامل", partNumber: "BP-1", quantity: 2, unitPrice: "150.25" });
    expect(part.status).toBe(201);
    expect(part.body.data.total).toBe("300.50");
    const labor = await tc.post(`/api/maintenance/${id}/labor`, { description: "تركيب الفحمات", hours: "1.5", hourlyRate: "100" });
    expect(labor.body.data.total).toBe("150.00");
    const upd = await tc.patch(`/api/maintenance-parts/${part.body.data.id}`, { quantity: "3" });
    expect(upd.body.data.total).toBe("450.75");

    // 5) Quote → submit (request moves to PENDING_APPROVAL by the server) → finance notified
    const q = await tc.post(`/api/maintenance/${id}/quotes`, { quoteNumber: "Q-100", amount: "600.75", validUntil: "2026-07-15" });
    expect(q.status).toBe(201);
    expect(q.body.data.status).toBe("DRAFT");
    const sub = await tc.post(`/api/maintenance-quotes/${q.body.data.id}/submit`);
    expect(sub.body.data.status).toBe("SUBMITTED");
    expect((await pmc.get(`/api/maintenance/${id}`)).body.data.status).toBe("PENDING_APPROVAL");
    expect(await notesOf(fin.id)).toContain("MAINTENANCE_QUOTE_REVIEW");
    expect(await notesOf(pm.id)).toContain("MAINTENANCE_ACTION_REQUIRED");

    // 6) Work approval needs an approved quote; PM cannot approve quotes; finance can
    expect((await pmc.post(`/api/maintenance/${id}/approve`)).status).toBe(409);
    expect((await pmc.post(`/api/maintenance-quotes/${q.body.data.id}/approve`)).status).toBe(403);
    expect((await fc.post(`/api/maintenance-quotes/${q.body.data.id}/review`)).body.data.status).toBe("UNDER_REVIEW");
    expect((await fc.post(`/api/maintenance-quotes/${q.body.data.id}/approve`)).body.data.status).toBe("APPROVED");
    expect(await notesOf(tech.id)).toContain("MAINTENANCE_QUOTE_APPROVED");
    const appr = await pmc.post(`/api/maintenance/${id}/approve`);
    expect(appr.body.data.status).toBe("APPROVED");
    expect(await notesOf(tech.id)).toContain("MAINTENANCE_APPROVED");

    // 7) Repair → vehicle IN_MAINTENANCE
    expect((await tc.post(`/api/maintenance/${id}/start-repair`)).body.data.status).toBe("IN_REPAIR");
    expect((await db.select().from(vehicles).where(eq(vehicles.id, vA.id)))[0]!.status).toBe("IN_MAINTENANCE");

    // 8) Ready for handover (work performed required) → PM notified
    expect((await tc.post(`/api/maintenance/${id}/mark-ready`)).status).toBe(409);
    expect((await tc.patch(`/api/maintenance/${id}`, { workPerformed: "تم تغيير الفحمات واختبار الفرامل" })).status).toBe(200);
    expect((await tc.post(`/api/maintenance/${id}/mark-ready`)).body.data.status).toBe("READY_FOR_HANDOVER");
    expect(await notesOf(pm.id)).toContain("MAINTENANCE_READY_FOR_HANDOVER");
    // costs are locked now
    expect((await tc.post(`/api/maintenance/${id}/parts`, { partName: "إضافي", quantity: 1, unitPrice: 1 })).status).toBe(409);

    // 9) PM accepts → CLOSED (PM also holds maintenance.close), vehicle restored
    const acc = await pmc.post(`/api/maintenance/${id}/accept-handover`);
    expect(acc.status).toBe(200);
    expect(acc.body.data.status).toBe("CLOSED");
    expect(acc.body.data.completedAt).toBeTruthy();
    expect(acc.body.data.closedAt).toBeTruthy();
    expect((await db.select().from(vehicles).where(eq(vehicles.id, vA.id)))[0]!.status).toBe("AVAILABLE");
    expect(await notesOf(tech.id)).toContain("MAINTENANCE_ACCEPTED");
    const [asg] = await db.select().from(assignments).where(and(eq(assignments.referenceId, id), eq(assignments.assignedTo, tech.id)));
    expect(asg!.status).toBe("COMPLETED");

    // History (append-only events) and audit trail
    const detail = (await pmc.get(`/api/maintenance/${id}`)).body.data;
    expect(detail.cost).toBe("600.75");
    expect(detail.actions).toEqual([]);
    const types = detail.timeline.map((e: { type: string }) => e.type).reverse();
    expect(types).toEqual([
      "CREATED", "ASSIGNED", "INSPECTION_STARTED", "DIAGNOSIS_UPDATED", "INSPECTION_COMPLETED", "PART_ADDED", "LABOR_ADDED", "PART_UPDATED",
      "QUOTE_CREATED", "QUOTE_SUBMITTED", "STATUS_CHANGED", "QUOTE_REVIEW_STARTED", "QUOTE_APPROVED", "APPROVED", "REPAIR_STARTED",
      "WORK_UPDATED", "READY_FOR_HANDOVER", "HANDOVER_ACCEPTED", "CLOSED",
    ]);
    const audits = await db.select().from(auditLogs).where(eq(auditLogs.entityId, id));
    const approved = audits.find((a) => a.action === "MAINTENANCE_APPROVED")!;
    expect(approved.userId).toBe(pm.id);
    expect(approved.projectId).toBe(vA.projectId);
    expect(approved.metadata).toMatchObject({ maintenanceId: id, fromStatus: "PENDING_APPROVAL", toStatus: "APPROVED" });
    expect(audits.map((a) => a.action)).toEqual(expect.arrayContaining(["MAINTENANCE_CREATED", "MAINTENANCE_ASSIGNED", "MAINTENANCE_HANDOVER_ACCEPTED", "MAINTENANCE_CLOSED"]));
    // vehicle timeline shows maintenance events
    const tl = (await pmc.get(`/api/vehicles/${vA.id}/timeline`)).body.data.map((e: { action: string }) => e.action);
    expect(tl).toEqual(expect.arrayContaining(["MAINTENANCE_CREATED", "MAINTENANCE_CLOSED", "QUOTE_APPROVED"]));
  });
});

describe("maintenance — handover rejection & quote rejection", () => {
  it("rejecting the handover requires a reason, returns to IN_REPAIR, notifies the technician and admins", async () => {
    const { pm, tech, vA, pmc, tc } = await setup();
    const admin = await createUser(["SUPER_ADMIN"]);
    const mr = await createMaintenance(vA, pm.id, { status: "READY_FOR_HANDOVER", assignedTo: tech.id, workPerformed: "تم" });
    expect((await pmc.post(`/api/maintenance/${mr.id}/reject-handover`)).status).toBe(400);
    expect((await pmc.post(`/api/maintenance/${mr.id}/reject-handover`, { reason: "" })).status).toBe(400);
    const r = await pmc.post(`/api/maintenance/${mr.id}/reject-handover`, { reason: "لا يزال هناك صوت في الفرامل." });
    expect(r.status).toBe(200);
    expect(r.body.data).toMatchObject({ status: "IN_REPAIR", rejectionReason: "لا يزال هناك صوت في الفرامل.", handoverRejections: 1 });
    expect(await notesOf(tech.id)).toContain("MAINTENANCE_RETURNED_FOR_REPAIR");
    expect(await notesOf(admin.id)).toContain("MAINTENANCE_HANDOVER_REJECTED");
    const [ev] = await db.select().from(maintenanceEvents).where(and(eq(maintenanceEvents.maintenanceRequestId, mr.id), eq(maintenanceEvents.type, "HANDOVER_REJECTED")));
    expect(ev!.reason).toBe("لا يزال هناك صوت في الفرامل.");
    // technician fixes again → ready → accepted
    expect((await tc.post(`/api/maintenance/${mr.id}/mark-ready`)).body.data.status).toBe("READY_FOR_HANDOVER");
    expect((await pmc.post(`/api/maintenance/${mr.id}/accept-handover`)).body.data.status).toBe("CLOSED");
  });

  it("rejecting the last open quote sends the request back to QUOTE_PENDING (server-side)", async () => {
    const { pm, tech, vA, tc, fc } = await setup();
    const mr = await createMaintenance(vA, pm.id, { status: "QUOTE_PENDING", assignedTo: tech.id, diagnosis: "x" });
    const q1 = (await tc.post(`/api/maintenance/${mr.id}/quotes`, { amount: "100" })).body.data;
    const q2 = (await tc.post(`/api/maintenance/${mr.id}/quotes`, { amount: "120" })).body.data;
    await tc.post(`/api/maintenance-quotes/${q1.id}/submit`);
    await tc.post(`/api/maintenance-quotes/${q2.id}/submit`);
    expect((await fc.post(`/api/maintenance-quotes/${q1.id}/reject`)).status).toBe(400); // reason required
    expect((await fc.post(`/api/maintenance-quotes/${q1.id}/reject`, { reason: "السعر مرتفع" })).body.data.status).toBe("REJECTED");
    expect((await tc.get(`/api/maintenance/${mr.id}`)).body.data.status).toBe("PENDING_APPROVAL"); // q2 still open
    await fc.post(`/api/maintenance-quotes/${q2.id}/reject`, { reason: "غير مطابق" });
    expect((await tc.get(`/api/maintenance/${mr.id}`)).body.data.status).toBe("QUOTE_PENDING");
    expect(await notesOf(tech.id)).toContain("MAINTENANCE_QUOTE_REJECTED");
    // a rejected quote cannot be approved later
    expect((await fc.post(`/api/maintenance-quotes/${q2.id}/approve`)).status).toBe(409);
  });

  it("approving one quote auto-rejects the others; only one approved quote exists", async () => {
    const { pm, tech, vA, tc, fc } = await setup();
    const mr = await createMaintenance(vA, pm.id, { status: "QUOTE_PENDING", assignedTo: tech.id, diagnosis: "x" });
    const q1 = (await tc.post(`/api/maintenance/${mr.id}/quotes`, { amount: "100" })).body.data;
    const q2 = (await tc.post(`/api/maintenance/${mr.id}/quotes`, { amount: "90" })).body.data;
    await tc.post(`/api/maintenance-quotes/${q1.id}/submit`);
    await tc.post(`/api/maintenance-quotes/${q2.id}/submit`);
    expect((await fc.post(`/api/maintenance-quotes/${q2.id}/approve`)).status).toBe(200);
    const quotes = (await tc.get(`/api/maintenance/${mr.id}/quotes`)).body.data;
    expect(quotes.find((q: { id: string }) => q.id === q1.id).status).toBe("REJECTED");
    expect((await fc.post(`/api/maintenance-quotes/${q1.id}/approve`)).status).toBe(409);
  });

  it("validates quotes: amount, validUntil in the past, expired quote cannot be submitted/approved", async () => {
    const { pm, tech, vA, tc } = await setup();
    const mr = await createMaintenance(vA, pm.id, { status: "QUOTE_PENDING", assignedTo: tech.id });
    expect((await tc.post(`/api/maintenance/${mr.id}/quotes`, { amount: "-1" })).status).toBe(400);
    expect((await tc.post(`/api/maintenance/${mr.id}/quotes`, { amount: "10", validUntil: "2026-06-01" })).status).toBe(400);
    expect((await tc.post(`/api/maintenance/${mr.id}/quotes`, { amount: "10", validUntil: "15/07/2026" })).status).toBe(400);
    const q = (await tc.post(`/api/maintenance/${mr.id}/quotes`, { amount: "10", validUntil: "2026-06-20" })).body.data;
    setClock(new Date("2026-06-25T09:00:00Z"));
    expect((await tc.post(`/api/maintenance-quotes/${q.id}/submit`)).status).toBe(400);
  });
});

describe("maintenance — accept without close permission", () => {
  it("stops at ACCEPTED; a user with maintenance.close closes it; closing only from ACCEPTED", async () => {
    const { pm, pA, tech, vA, pmc } = await setup();
    // Custom tenant role: can read + handover, but NOT close.
    const perms = await db.select().from(permissions);
    const pid = (k: string) => perms.find((p) => p.key === k)!.id;
    const [role] = await db.insert(roles).values({ organizationId: vA.organizationId, key: `INSPECTOR_${uid()}`, nameAr: "مفتش استلام" }).returning();
    await db.insert(rolePermissions).values([
      { roleId: role!.id, permissionId: pid("maintenance.read"), scope: "PROJECT" },
      { roleId: role!.id, permissionId: pid("maintenance.handover"), scope: "PROJECT" },
    ]);
    const inspector = await createUser(["VIEWER"]);
    await db.insert(userRoles).values({ userId: inspector.id, roleId: role!.id });
    await db.insert(projectUsers).values({ projectId: pA.id, userId: inspector.id });
    const mr = await createMaintenance(vA, pm.id, { status: "READY_FOR_HANDOVER", assignedTo: tech.id, workPerformed: "تم" });
    const ic = await login(inspector.email);
    const r = await ic.post(`/api/maintenance/${mr.id}/accept-handover`);
    expect(r.body.data.status).toBe("ACCEPTED");
    expect((await ic.post(`/api/maintenance/${mr.id}/close`)).status).toBe(403);
    expect((await pmc.post(`/api/maintenance/${mr.id}/close`)).body.data.status).toBe("CLOSED");
  });
});

describe("maintenance — CRUD, list, filters, validation", () => {
  it("validates create input", async () => {
    const { vA, pmc } = await setup();
    expect((await pmc.post("/api/maintenance", { vehicleId: vA.id, issue: "", priority: "HIGH" })).status).toBe(400);
    expect((await pmc.post("/api/maintenance", { vehicleId: vA.id, issue: "عطل" })).status).toBe(400); // priority required
    expect((await pmc.post("/api/maintenance", { vehicleId: vA.id, issue: "عطل كهربائي", priority: "URGENT" })).status).toBe(400);
    expect((await pmc.post("/api/maintenance", { vehicleId: vA.id, issue: "عطل كهربائي", priority: "LOW", odometer: -5 })).status).toBe(400);
    expect((await pmc.post("/api/maintenance", { issue: "عطل كهربائي", priority: "LOW" })).status).toBe(400);
    expect((await pmc.post("/api/maintenance", { vehicleId: "not-uuid", issue: "عطل كهربائي", priority: "LOW" })).status).toBe(400);
  });

  it("lists with search and filters (plate, MR number, status, priority, technician, dates)", async () => {
    const { pm, tech, vA, pmc } = await setup();
    const a = await createMaintenance(vA, pm.id, { status: "IN_REPAIR", priority: "CRITICAL", assignedTo: tech.id, issue: "تسريب زيت المحرك" });
    const b = await createMaintenance(vA, pm.id, { status: "REQUESTED", priority: "LOW", issue: "إطار احتياطي" });
    const ids = async (qs: string) => (await pmc.get(`/api/maintenance?pageSize=100&${qs}`)).body.data.map((r: { id: string }) => r.id);
    expect(await ids(`q=MR-${a.number}`)).toEqual([a.id]);
    expect(await ids(`q=${a.number}`)).toContain(a.id);
    expect(await ids(`q=${encodeURIComponent("تسريب")}`)).toEqual([a.id]);
    expect(await ids(`q=${encodeURIComponent(vA.plateNumber)}`)).toEqual(expect.arrayContaining([a.id, b.id]));
    expect(await ids(`q=${vA.id}`)).toEqual(expect.arrayContaining([a.id, b.id]));
    expect(await ids("status=IN_REPAIR")).toEqual([a.id]);
    expect(await ids("priority=LOW")).toEqual([b.id]);
    expect(await ids(`technicianId=${tech.id}`)).toEqual([a.id]);
    expect(await ids("from=2020-01-01&to=2100-01-01")).toEqual(expect.arrayContaining([a.id, b.id]));
    expect(await ids("from=2100-01-01")).toEqual([]);
    expect((await pmc.get("/api/maintenance?status=DONE")).status).toBe(400);
    expect((await pmc.get("/api/maintenance?from=yesterday")).status).toBe(400);
    const page = await pmc.get("/api/maintenance?pageSize=1");
    expect(page.body.meta.total).toBeGreaterThanOrEqual(2);
    expect(page.body.data).toHaveLength(1);
  });

  it("PATCH respects field/state rules", async () => {
    const { pm, tech, vA, pmc } = await setup();
    const mr = await createMaintenance(vA, pm.id, { status: "IN_REPAIR", assignedTo: tech.id });
    expect((await pmc.patch(`/api/maintenance/${mr.id}`, { issue: "تغيير" })).status).toBe(409);
    expect((await pmc.patch(`/api/maintenance/${mr.id}`, { diagnosis: "x" })).status).toBe(409);
    expect((await pmc.patch(`/api/maintenance/${mr.id}`, { workPerformed: "تم استبدال" })).status).toBe(200);
    expect((await pmc.patch(`/api/maintenance/${mr.id}`, {})).status).toBe(400);
    expect((await pmc.patch(`/api/maintenance/${mr.id}`, { odometer: -1 })).status).toBe(400);
  });

  it("parts and labor validation: quantity/hours > 0, prices ≥ 0, client total rejected", async () => {
    const { pm, tech, vA, tc } = await setup();
    const mr = await createMaintenance(vA, pm.id, { status: "IN_REPAIR", assignedTo: tech.id });
    expect((await tc.post(`/api/maintenance/${mr.id}/parts`, { partName: "قطعة", quantity: 0, unitPrice: 5 })).status).toBe(400);
    expect((await tc.post(`/api/maintenance/${mr.id}/parts`, { partName: "قطعة", quantity: 1, unitPrice: -5 })).status).toBe(400);
    expect((await tc.post(`/api/maintenance/${mr.id}/parts`, { partName: "قطعة", quantity: 1, unitPrice: 5, total: 1 })).status).toBe(400);
    expect((await tc.post(`/api/maintenance/${mr.id}/labor`, { description: "عمل", hours: 0, hourlyRate: 10 })).status).toBe(400);
    expect((await tc.post(`/api/maintenance/${mr.id}/labor`, { description: "عمل", hours: 2, hourlyRate: 10, total: 999 })).status).toBe(400);
    const l = await tc.post(`/api/maintenance/${mr.id}/labor`, { description: "عمل", hours: "0.25", hourlyRate: "80.10" });
    expect(l.body.data.total).toBe("20.03");
    expect((await tc.delete(`/api/maintenance-labor/${l.body.data.id}`)).status).toBe(204);
  });

  it("database constraints back up the server validation", async () => {
    const { pm, vA } = await setup();
    const mr = await createMaintenance(vA, pm.id, { status: "IN_REPAIR" });
    const base = { organizationId: vA.organizationId, maintenanceRequestId: mr.id, partName: "x" };
    await expect(db.insert(maintenanceParts).values({ ...base, quantity: "2", unitPrice: "10", total: "5" })).rejects.toThrow();
    await expect(db.insert(maintenanceParts).values({ ...base, quantity: "0", unitPrice: "10", total: "0" })).rejects.toThrow();
    const [ev] = await db.insert(maintenanceEvents).values({ organizationId: vA.organizationId, maintenanceRequestId: mr.id, type: "TEST" }).returning();
    await expect(db.update(maintenanceEvents).set({ type: "TAMPERED" }).where(eq(maintenanceEvents.id, ev!.id))).rejects.toThrow();
    await expect(db.delete(maintenanceEvents).where(eq(maintenanceEvents.id, ev!.id))).rejects.toThrow();
  });

  it("vendors: listing and creation rules", async () => {
    const { pmc, tc, fc } = await setup();
    const v = await pmc.post("/api/vendors", { name: `ورشة تجريبية ${uid()}`, phone: "+966500000000" });
    expect(v.status).toBe(201);
    expect((await tc.post("/api/vendors", { name: `ورشة ${uid()}` })).status).toBe(403); // ASSIGNED-only technician
    expect((await fc.get("/api/vendors")).body.data.map((x: { id: string }) => x.id)).toContain(v.body.data.id);
    expect((await pmc.post("/api/vendors", { name: v.body.data.name })).status).toBe(409);
    const { client: viewer } = await userAndClient(["VIEWER"]);
    expect((await viewer.get("/api/vendors")).status).toBe(403);
  });
});

describe("maintenance — attachments", () => {
  it("uploads with category, downloads with auth, rejects disguised files", async () => {
    const { pm, tech, vA, tc, pmc } = await setup();
    const mr = await createMaintenance(vA, pm.id, { status: "INSPECTION", assignedTo: tech.id });
    const up = await tc.agent.post(`/api/maintenance/${mr.id}/attachments?category=DAMAGE_PHOTO`).set("X-CSRF-Token", tc.csrf).set("Content-Type", "application/pdf").set("X-File-Name", "report.pdf").send(PDF_BYTES);
    expect(up.status).toBe(201);
    expect(up.body.data.category).toBe("DAMAGE_PHOTO");
    expect((await tc.agent.post(`/api/maintenance/${mr.id}/attachments`).set("X-CSRF-Token", tc.csrf).set("Content-Type", "application/pdf").send(Buffer.from("MZ fake"))).status).toBe(400);
    expect((await tc.agent.post(`/api/maintenance/${mr.id}/attachments?category=SELFIE`).set("X-CSRF-Token", tc.csrf).set("Content-Type", "application/pdf").send(PDF_BYTES)).status).toBe(400);
    const dl = await pmc.get(`/api/maintenance-attachments/${up.body.data.id}/file`);
    expect(dl.status).toBe(200);
    expect(dl.headers["content-disposition"]).toMatch(/^attachment/);
    const detail = (await pmc.get(`/api/maintenance/${mr.id}`)).body.data;
    expect(detail.attachments[0].fileName).toBe("report.pdf");
    expect(detail).not.toHaveProperty("fileId");
    expect(JSON.stringify(detail)).not.toMatch(/storageKey|storage_key/);
  });
});

describe("maintenance — vehicle integration & dashboard", () => {
  it("vehicle maintenance summary, archive guard, workflow-managed status", async () => {
    const { pm, tech, vA, pmc } = await setup();
    const { client: admin } = await userAndClient(["SUPER_ADMIN"]);
    const closed = await createMaintenance(vA, pm.id, { status: "CLOSED", closedAt: new Date(), completedAt: new Date() });
    await db.insert(maintenanceParts).values({ organizationId: vA.organizationId, maintenanceRequestId: closed.id, partName: "زيت", quantity: "4", unitPrice: "25", total: "100.00" });
    const open = await createMaintenance(vA, pm.id, { status: "PENDING_APPROVAL", assignedTo: tech.id });
    const s = (await pmc.get(`/api/vehicles/${vA.id}/maintenance`)).body.data;
    expect(s.current.id).toBe(open.id);
    expect(s).toMatchObject({ openCount: 1, awaitingApproval: 1, awaitingHandover: 0, totalCost: "100.00", nextPlanned: null });
    expect(s.lastMaintenance.id).toBe(closed.id);
    expect((await admin.post(`/api/vehicles/${vA.id}/archive`)).status).toBe(409);
    await db.update(vehicles).set({ status: "IN_MAINTENANCE" }).where(eq(vehicles.id, vA.id));
    expect((await pmc.patch(`/api/vehicles/${vA.id}`, { status: "AVAILABLE" })).status).toBe(409);
  });

  it("dashboard KPIs come from the database and respect scope", async () => {
    const { pm, tech, vA, pmc } = await setup();
    const other = await createVehicle((await createProject()).id);
    await createMaintenance(vA, pm.id, { status: "REQUESTED" });
    await createMaintenance(vA, pm.id, { status: "PENDING_APPROVAL", assignedTo: tech.id });
    await createMaintenance(vA, pm.id, { status: "IN_REPAIR", assignedTo: tech.id });
    await createMaintenance(vA, pm.id, { status: "READY_FOR_HANDOVER", assignedTo: tech.id });
    await createMaintenance(other, pm.id, { status: "REQUESTED" }); // other project
    const closed = await createMaintenance(vA, pm.id, { status: "CLOSED", closedAt: new Date("2026-06-10T10:00:00Z") });
    await db.insert(maintenanceParts).values({ organizationId: vA.organizationId, maintenanceRequestId: closed.id, partName: "x", quantity: "1", unitPrice: "75.50", total: "75.50" });
    const lastMonth = await createMaintenance(vA, pm.id, { status: "CLOSED", closedAt: new Date("2026-05-20T10:00:00Z") });
    await db.insert(maintenanceParts).values({ organizationId: vA.organizationId, maintenanceRequestId: lastMonth.id, partName: "x", quantity: "1", unitPrice: "999", total: "999.00" });
    const m = (await pmc.get("/api/dashboard")).body.data.maintenance;
    expect(m).toEqual({ open: 4, awaitingInspection: 1, inInspection: 0, awaitingApproval: 1, inRepair: 1, awaitingHandover: 1, costThisMonth: "75.50" });
    const { client: driver } = await userAndClient(["DRIVER"]);
    expect((await driver.get("/api/dashboard")).body.data.maintenance).toBeNull();
  });
});
