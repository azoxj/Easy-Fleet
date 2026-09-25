import { eq } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { db } from "../src/db/client.js";
import { accidents, auditLogs, notifications, vehicles } from "../src/db/schema/index.js";
import { setClock } from "../src/lib/clock.js";
import { createDriverUser, createProject, createUser, createVehicle, login, PDF_BYTES, userAndClient } from "./helpers.js";

beforeEach(() => setClock(new Date("2026-06-15T09:00:00Z")));
afterEach(() => setClock(null));

const vehicleOf = async (id: string) => (await db.select().from(vehicles).where(eq(vehicles.id, id)))[0]!;
const notesOf = async (userId: string) => (await db.select().from(notifications).where(eq(notifications.userId, userId))).map((n) => n.type);

async function setup() {
  const pm = await createUser(["PROJECT_MANAGER"]);
  const pA = await createProject({ managerId: pm.id });
  const vA = await createVehicle(pA.id, { currentOdometer: 10000, status: "ASSIGNED" });
  const drv = await createDriverUser(pA.id);
  await db.update(vehicles).set({ assignedDriverId: drv.driver.id }).where(eq(vehicles.id, vA.id));
  const vOther = await createVehicle(pA.id);
  return { pm, pA, vA, vOther, drv, pmc: await login(pm.email), dc: await login(drv.user.email) };
}

describe("fuel", () => {
  it("driver records fuel for own vehicle; project/driver/total are server-derived; odometer rules", async () => {
    const { pA, vA, vOther, drv, dc, pmc } = await setup();
    const r = await dc.post("/api/fuel", { vehicleId: vA.id, fueledAt: "2026-06-14T08:00:00+03:00", liters: 40, pricePerLiter: 2.33, odometer: 10400, station: "محطة 1" });
    expect(r.status).toBe(201);
    expect(r.body.data).toMatchObject({ projectId: pA.id, driverId: drv.driver.id, total: "93.20", liters: "40.00" });
    expect((await vehicleOf(vA.id)).currentOdometer).toBe(10400);
    // cannot record for a vehicle not assigned to the driver (404 = no existence oracle)
    expect((await dc.post("/api/fuel", { vehicleId: vOther.id, fueledAt: "2026-06-14T08:00:00+03:00", liters: 1, pricePerLiter: 1 })).status).toBe(404);
    // cannot record in another driver's name
    const other = await createDriverUser(pA.id);
    expect((await dc.post("/api/fuel", { vehicleId: vA.id, driverId: other.driver.id, fueledAt: "2026-06-14T09:00:00+03:00", liters: 1, pricePerLiter: 1 })).status).toBe(403);
    // odometer lower than the previous fill-up → 400; future time → 400; total cannot be injected
    expect((await dc.post("/api/fuel", { vehicleId: vA.id, fueledAt: "2026-06-15T10:00:00+03:00", liters: 10, pricePerLiter: 2, odometer: 10300 })).status).toBe(400);
    expect((await dc.post("/api/fuel", { vehicleId: vA.id, fueledAt: "2026-06-20T10:00:00+03:00", liters: 10, pricePerLiter: 2 })).status).toBe(400);
    expect((await dc.post("/api/fuel", { vehicleId: vA.id, fueledAt: "2026-06-15T10:00:00+03:00", liters: 10, pricePerLiter: 2, total: 1 })).status).toBe(400);
    expect((await dc.post("/api/fuel", { vehicleId: vA.id, fueledAt: "2026-06-15T10:00:00+03:00", liters: 50, pricePerLiter: 2.33, odometer: 11000 })).status).toBe(201);
    // stats: 600 km on 50 L = 12 km/L
    const stats = (await pmc.get(`/api/fuel/stats?vehicleId=${vA.id}`)).body.data;
    expect(stats.totals).toMatchObject({ count: 2, liters: "90.00", cost: "209.70" });
    expect(stats.perVehicle[0]).toMatchObject({ distanceKm: 600, kmPerLiter: "12.00" });
    // receipt
    expect((await dc.upload(`/api/fuel/${r.body.data.id}/receipt`, PDF_BYTES)).status).toBe(201);
    expect((await pmc.get(`/api/fuel/${r.body.data.id}/receipt`)).status).toBe(200);
    // PM of another project sees nothing
    const { client: otherPm } = await userAndClient(["PROJECT_MANAGER"]);
    expect((await otherPm.get(`/api/fuel/${r.body.data.id}`)).status).toBe(404);
    expect((await otherPm.get(`/api/fuel/${r.body.data.id}/receipt`)).status).toBe(404);
    expect((await otherPm.get("/api/fuel")).body.data).toHaveLength(0);
  });
});

describe("accidents", () => {
  it("report → vehicle ACCIDENT → review → repair → close (resolution required) → vehicle restored", async () => {
    const { pm, vA, drv, dc, pmc } = await setup();
    const r = await dc.post("/api/accidents", { vehicleId: vA.id, occurredAt: "2026-06-14T18:00:00+03:00", description: "صدمة خلفية عند الإشارة", severity: "MODERATE", location: "الرياض", latitude: 24.7, longitude: 46.6 });
    expect(r.status).toBe(201);
    expect(r.body.data).toMatchObject({ status: "OPEN", driverId: drv.driver.id, label: expect.stringMatching(/^ACC-\d+$/) });
    const id = r.body.data.id;
    expect((await vehicleOf(vA.id)).status).toBe("ACCIDENT");
    expect(await notesOf(pm.id)).toContain("ACCIDENT_REPORTED");
    // driver may attach evidence but not change status
    expect((await dc.upload(`/api/accidents/${id}/attachments?category=PHOTO`, PDF_BYTES, "application/pdf", "post")).status).toBe(201);
    expect((await dc.post(`/api/accidents/${id}/status`, { to: "UNDER_REVIEW" })).status).toBe(403);
    // invalid transition
    expect((await pmc.post(`/api/accidents/${id}/status`, { to: "REPAIR" })).status).toBe(409);
    expect((await pmc.post(`/api/accidents/${id}/status`, { to: "UNDER_REVIEW" })).body.data.status).toBe("UNDER_REVIEW");
    expect((await pmc.patch(`/api/accidents/${id}`, { insuranceClaimNumber: "CLM-9", repairCost: "2500.00", responsibility: "THIRD_PARTY" })).status).toBe(200);
    expect((await pmc.post(`/api/accidents/${id}/status`, { to: "REPAIR" })).body.data.status).toBe("REPAIR");
    expect((await pmc.post(`/api/accidents/${id}/status`, { to: "CLOSED" })).status).toBe(400); // resolution required
    expect((await pmc.post(`/api/accidents/${id}/status`, { to: "CLOSED", resolution: "تم الإصلاح على حساب الطرف الثالث" })).body.data.status).toBe("CLOSED");
    expect((await vehicleOf(vA.id)).status).toBe("ASSIGNED"); // driver still assigned
    expect((await pmc.patch(`/api/accidents/${id}`, { description: "تعديل" })).status).toBe(409);
    const detail = (await pmc.get(`/api/accidents/${id}`)).body.data;
    expect(detail.attachments).toHaveLength(1);
    expect(detail.timeline.map((t: { action: string }) => t.action)).toEqual(expect.arrayContaining(["ACCIDENT_CREATED", "ACCIDENT_UPDATED", "ACCIDENT_STATUS_CHANGED"]));
    expect((await pmc.get(`/api/accident-attachments/${detail.attachments[0].id}/file`)).status).toBe(200);
    // other PM: nothing visible, file not downloadable
    const { client: otherPm } = await userAndClient(["PROJECT_MANAGER"]);
    expect((await otherPm.get(`/api/accidents/${id}`)).status).toBe(404);
    expect((await otherPm.get(`/api/accident-attachments/${detail.attachments[0].id}/file`)).status).toBe(404);
    // vehicle timeline shows the accident
    const tl = (await pmc.get(`/api/vehicles/${vA.id}/timeline`)).body.data.map((e: { action: string }) => e.action);
    expect(tl).toEqual(expect.arrayContaining(["ACCIDENT_CREATED", "ACCIDENT_STATUS_CHANGED"]));
  });

  it("vehicle stays ACCIDENT while another accident is still open", async () => {
    const { vA, pmc } = await setup();
    const a1 = (await pmc.post("/api/accidents", { vehicleId: vA.id, occurredAt: "2026-06-10T10:00:00Z", description: "حادث أول", severity: "MINOR" })).body.data;
    const a2 = (await pmc.post("/api/accidents", { vehicleId: vA.id, occurredAt: "2026-06-11T10:00:00Z", description: "حادث ثاني", severity: "MINOR" })).body.data;
    await pmc.post(`/api/accidents/${a1.id}/status`, { to: "CLOSED", resolution: "بسيط" });
    expect((await vehicleOf(vA.id)).status).toBe("ACCIDENT");
    await pmc.post(`/api/accidents/${a2.id}/status`, { to: "CLOSED", resolution: "بسيط" });
    expect((await vehicleOf(vA.id)).status).toBe("ASSIGNED");
    const [row] = await db.select().from(accidents).where(eq(accidents.id, a1.id));
    expect(row!.closedAt).toBeTruthy();
  });
});

describe("violations", () => {
  it("create (driver resolved from assignment history) → dispute → reopen → pay; terminal states; duplicate numbers", async () => {
    const { pm, vA, drv, pmc, dc } = await setup();
    // assignment history drives the default driver
    await db.execute(`insert into vehicle_driver_history (organization_id, vehicle_id, driver_id, assigned_at) values ('${pm.orgId}', '${vA.id}', '${drv.driver.id}', '2026-06-01T00:00:00Z')`);
    const c = await pmc.post("/api/violations", { vehicleId: vA.id, violationNumber: "V-100", violationDate: "2026-06-12", type: "تجاوز السرعة", amount: "300", authority: "المرور" });
    expect(c.status).toBe(201);
    expect(c.body.data).toMatchObject({ status: "OPEN", driverId: drv.driver.id });
    expect(await notesOf(drv.user.id)).toContain("VIOLATION_RECORDED");
    expect((await pmc.post("/api/violations", { vehicleId: vA.id, violationNumber: "V-100", violationDate: "2026-06-12", type: "سرعة", amount: "1" })).status).toBe(409);
    const id = c.body.data.id;
    // driver can read own violations but not change them
    expect((await dc.get(`/api/violations/${id}`)).status).toBe(200);
    expect((await dc.post(`/api/violations/${id}/pay`, { paymentDate: "2026-06-14" })).status).toBe(403);
    expect((await pmc.post(`/api/violations/${id}/reopen`)).status).toBe(409);
    expect((await pmc.post(`/api/violations/${id}/dispute`, { reason: "المركبة كانت متوقفة" })).body.data.status).toBe("DISPUTED");
    expect((await pmc.post(`/api/violations/${id}/reopen`)).body.data.status).toBe("OPEN");
    expect((await pmc.post(`/api/violations/${id}/pay`, {})).status).toBe(400);
    expect((await pmc.post(`/api/violations/${id}/pay`, { paymentDate: "2026-06-10" })).status).toBe(400); // before violation date
    expect((await pmc.post(`/api/violations/${id}/pay`, { paymentDate: "2026-06-14" })).body.data.status).toBe("PAID");
    expect((await pmc.post(`/api/violations/${id}/cancel`, { reason: "خطأ" })).status).toBe(409);
    expect((await pmc.patch(`/api/violations/${id}`, { amount: "1" })).status).toBe(409);
    const list = await pmc.get(`/api/violations?vehicleId=${vA.id}`);
    expect(list.body.summary).toMatchObject({ paidAmount: "300.00" });
    const audits = (await db.select().from(auditLogs).where(eq(auditLogs.entityId, id))).map((a) => a.action);
    expect(audits.filter((a) => a === "VIOLATION_STATUS_CHANGED")).toHaveLength(3);
    // FINANCE (violations.update ALL) can pay; VIEWER cannot
    const v2 = (await pmc.post("/api/violations", { vehicleId: vA.id, violationDate: "2026-06-12", type: "وقوف", amount: "100" })).body.data;
    const { client: fc } = await userAndClient(["FINANCE"]);
    expect((await fc.post(`/api/violations/${v2.id}/pay`, { paymentDate: "2026-06-15" })).status).toBe(200);
    const viewer = await createUser(["VIEWER"]);
    await db.execute(`insert into project_users (project_id, user_id) values ('${vA.projectId}', '${viewer.id}')`);
    const vc = await login(viewer.email);
    expect((await vc.get(`/api/violations/${v2.id}`)).status).toBe(200);
    expect((await vc.post(`/api/violations/${v2.id}/dispute`, { reason: "xxx" })).status).toBe(403);
  });
});
