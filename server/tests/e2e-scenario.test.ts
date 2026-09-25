import request from "supertest";
import { eq } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { db } from "../src/db/client.js";
import { notifications, vehicles } from "../src/db/schema/index.js";
import { setClock } from "../src/lib/clock.js";
import { app, createUser, JPEG_BYTES, login, PDF_BYTES, PNG_BYTES, uid } from "./helpers.js";

/**
 * Spec §50 — end-to-end business scenario through the public API only
 * (every step as the role that performs it in real life).
 */
beforeEach(() => setClock(new Date("2026-06-15T09:00:00Z")));
afterEach(() => setClock(null));

const types = async (userId: string) => (await db.select().from(notifications).where(eq(notifications.userId, userId))).map((n) => n.type);

describe("E2E scenario (spec §50)", () => {
  it("project → vehicle/driver → maintenance (rejected handover once) → invoice to transfer → driver handover & return", async () => {
    const admin = await createUser(["SUPER_ADMIN"]);
    const pm = await createUser(["PROJECT_MANAGER"]);
    const tech = await createUser(["TECHNICAL"]);
    const fin = await createUser(["FINANCE"]);
    const driverUser = await createUser(["DRIVER"]);
    const ac = await login(admin.email);
    const pmc = await login(pm.email);
    const tc = await login(tech.email);
    const fc = await login(fin.email);

    // 1. Admin creates the project with the PM as manager and adds the technician
    const proj = await ac.post("/api/projects", { name: "مشروع نقل الموظفين", code: `E2E-${uid().toUpperCase()}`, managerId: pm.id, status: "ACTIVE", budget: "500000", contractValue: "750000" });
    expect(proj.status).toBe(201);
    const projectId = proj.body.data.id;
    expect((await ac.post(`/api/projects/${projectId}/members`, { userId: tech.id })).status).toBe(201);
    expect(await types(pm.id)).toContain("PROJECT_MANAGER_ASSIGNED");

    // 2. Vehicle in the project (admin), employee + driver (PM, project derived from scope)
    const veh = await ac.post("/api/vehicles", { plateNumber: `E2E-${uid()}`, plateArabic: "ر س ل 4455", make: "تويوتا", model: "هايس", year: 2024, currentOdometer: 20000, projectId });
    expect(veh.status).toBe(201);
    const vehicleId = veh.body.data.id;
    const emp = await pmc.post("/api/employees", { employeeNumber: `EMP-${uid()}`, fullName: "سالم السائق", projectId, phone: "+966500000001" });
    expect(emp.status).toBe(201);
    await ac.patch(`/api/employees/${emp.body.data.id}`, { userId: driverUser.id }); // link login account (admin only)
    const drv = await pmc.post("/api/drivers", { employeeId: emp.body.data.id, licenseNumber: `LIC-${uid()}`, licenseType: "PUBLIC", licenseIssueDate: "2024-01-01", licenseExpiryDate: "2029-01-01" });
    expect(drv.status).toBe(201);
    const driverId = drv.body.data.id;

    // 3. PM opens a maintenance request and assigns the technician
    const mr = await pmc.post("/api/maintenance", { vehicleId, issue: "ارتفاع حرارة المحرك", priority: "HIGH" });
    expect(mr.status).toBe(201);
    const mrId = mr.body.data.id;
    expect((await pmc.post(`/api/maintenance/${mrId}/assign`, { technicianId: tech.id })).status).toBe(200);
    expect(await types(tech.id)).toContain("MAINTENANCE_ASSIGNED");

    // 4. Technician inspects, diagnoses, adds parts/labor and submits a quote
    await tc.post(`/api/maintenance/${mrId}/start-inspection`);
    await tc.patch(`/api/maintenance/${mrId}`, { diagnosis: "تسريب في الرديتر" });
    expect((await tc.post(`/api/maintenance/${mrId}/complete-inspection`)).body.data.status).toBe("QUOTE_PENDING");
    await tc.post(`/api/maintenance/${mrId}/parts`, { partName: "رديتر", quantity: 1, unitPrice: "850" });
    await tc.post(`/api/maintenance/${mrId}/labor`, { description: "تركيب", hours: "2", hourlyRate: "75" });
    const q = (await tc.post(`/api/maintenance/${mrId}/quotes`, { quoteNumber: "Q-E2E", amount: "1000" })).body.data;
    await tc.post(`/api/maintenance-quotes/${q.id}/submit`);

    // 5. Finance approves the quote; PM approves the work
    await fc.post(`/api/maintenance-quotes/${q.id}/review`);
    expect((await fc.post(`/api/maintenance-quotes/${q.id}/approve`)).body.data.status).toBe("APPROVED");
    expect((await pmc.post(`/api/maintenance/${mrId}/approve`)).body.data.status).toBe("APPROVED");

    // 6. Repair → vehicle IN_MAINTENANCE → ready
    await tc.post(`/api/maintenance/${mrId}/start-repair`);
    expect((await db.select().from(vehicles).where(eq(vehicles.id, vehicleId)))[0]!.status).toBe("IN_MAINTENANCE");
    await tc.patch(`/api/maintenance/${mrId}`, { workPerformed: "تم تغيير الرديتر" });
    await tc.post(`/api/maintenance/${mrId}/mark-ready`);

    // 7. PM rejects the handover once, technician fixes, PM accepts → CLOSED
    expect((await pmc.post(`/api/maintenance/${mrId}/reject-handover`, { reason: "ما زالت الحرارة مرتفعة" })).body.data.status).toBe("IN_REPAIR");
    expect(await types(tech.id)).toContain("MAINTENANCE_RETURNED_FOR_REPAIR");
    await tc.post(`/api/maintenance/${mrId}/mark-ready`);
    expect((await pmc.post(`/api/maintenance/${mrId}/accept-handover`)).body.data.status).toBe("CLOSED");
    expect((await db.select().from(vehicles).where(eq(vehicles.id, vehicleId)))[0]!.status).toBe("AVAILABLE");

    // 8. Technician raises the workshop invoice (project from the request) → finance → transfer → paid
    const inv = await tc.post("/api/invoices", { maintenanceRequestId: mrId, amount: "1000", tax: "150", invoiceDate: "2026-06-15", invoiceNumber: "WS-1" });
    expect(inv.status).toBe(201);
    expect(inv.body.data.projectId).toBe(projectId);
    const invId = inv.body.data.id;
    expect((await tc.upload(`/api/invoices/${invId}/file`, PDF_BYTES)).status).toBe(201);
    await tc.post(`/api/invoices/${invId}/submit`);
    expect(await types(fin.id)).toContain("INVOICE_SUBMITTED");
    await fc.post(`/api/invoices/${invId}/start-review`);
    expect((await fc.post(`/api/invoices/${invId}/approve`)).body.data.status).toBe("TRANSFER_PENDING");
    const receipt = (await fc.upload(`/api/invoices/${invId}/receipt`, PDF_BYTES, "application/pdf", "post")).body.data;
    expect((await fc.post(`/api/invoices/${invId}/transfer`, { transferDate: "2026-06-15", amount: "1150.00", bank: "الأهلي", reference: "SNB-778", receiptFileId: receipt.receiptFileId })).body.data.status).toBe("TRANSFERRED");
    expect(await types(tech.id)).toContain("INVOICE_TRANSFERRED");

    // project financials include the closed maintenance cost
    const finSummary = (await pmc.get(`/api/projects/${projectId}/financials`)).body.data;
    expect(finSummary.totalCosts).toBe("1000.00"); // parts 850 + labor 150
    expect(finSummary.remainingBudget).toBe("499000.00");

    // 9. Driver handover through the secure link, then return with comparison
    const ho = (await pmc.post("/api/handovers", { vehicleId, driverId })).body.data;
    expect(await types(driverUser.id)).toContain("HANDOVER_REQUESTED");
    const put = (cat: string, bytes = JPEG_BYTES, type = "image/jpeg", qs = "") => request(app).put(`/api/public/handover/${ho.token}/photos/${cat}${qs}`).set("Content-Type", type).send(bytes);
    for (const c of ["FRONT", "REAR", "LEFT", "RIGHT", "INTERIOR", "ODOMETER", "TIRES"]) expect((await put(c)).status).toBe(201);
    await put("SIGNATURE", PNG_BYTES, "image/png");
    expect((await request(app).post(`/api/public/handover/${ho.token}/submit`).send({ odometer: 20010, confirm: true })).body.data.status).toBe("RETURN_PENDING");
    expect((await db.select().from(vehicles).where(eq(vehicles.id, vehicleId)))[0]!.assignedDriverId).toBe(driverId);
    for (const c of ["FRONT", "REAR", "LEFT", "RIGHT", "INTERIOR", "ODOMETER", "TIRES"]) await put(c, JPEG_BYTES, "image/jpeg", c === "FRONT" ? "?damage=true" : "");
    await put("SIGNATURE", PNG_BYTES, "image/png");
    expect((await request(app).post(`/api/public/handover/${ho.token}/submit`).send({ odometer: 20310, confirm: true })).body.data.status).toBe("RETURN_COMPLETED");
    const cmp = (await pmc.get(`/api/handovers/${ho.id}`)).body.data.comparison;
    expect(cmp.odometer.distance).toBe(300);
    expect(cmp.newDamageCount).toBe(1);
    expect((await pmc.post(`/api/handovers/${ho.id}/close`, { reviewNotes: "تحميل تكلفة الصدمة الأمامية" })).body.data.status).toBe("CLOSED");

    // 10. Vehicle timeline tells the whole story; dashboard reflects it
    const tl = (await pmc.get(`/api/vehicles/${vehicleId}/timeline`)).body.data.map((e: { action: string }) => e.action);
    expect(tl).toEqual(expect.arrayContaining(["VEHICLE_CREATED", "MAINTENANCE_CREATED", "MAINTENANCE_HANDOVER_REJECTED", "MAINTENANCE_CLOSED", "HANDOVER_COMPLETED", "HANDOVER_RETURN_COMPLETED", "HANDOVER_CLOSED"]));
    const dash = (await ac.get("/api/dashboard")).body.data;
    expect(dash.invoices.paid).toBeGreaterThanOrEqual(1);
  });
});
