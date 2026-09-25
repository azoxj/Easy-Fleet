import { eq } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { db } from "../src/db/client.js";
import { auditLogs, fuelTransactions, vehicles } from "../src/db/schema/index.js";
import { setClock } from "../src/lib/clock.js";
import { REPORT_KEYS, csvCell } from "../src/modules/reports/routes.js";
import { createDriverUser, createProject, createUser, createVehicle, defaultOrgId, login, userAndClient } from "./helpers.js";

beforeEach(() => setClock(new Date("2026-06-15T09:00:00Z")));
afterEach(() => setClock(null));

async function driverWithVehicle() {
  const pm = await createUser(["PROJECT_MANAGER"]);
  const pA = await createProject({ managerId: pm.id });
  const vA = await createVehicle(pA.id);
  const drv = await createDriverUser(pA.id);
  await db.update(vehicles).set({ assignedDriverId: drv.driver.id, status: "ASSIGNED" }).where(eq(vehicles.id, vA.id));
  return { pm, pA, vA, drv, pmc: await login(pm.email), dc: await login(drv.user.email) };
}

describe("QR codes", () => {
  it("returns an SVG with a random token; resolving requires scope", async () => {
    const { vA, pmc, dc } = await driverWithVehicle();
    const svg = await pmc.get(`/api/vehicles/${vA.id}/qr`);
    expect(svg.status).toBe(200);
    expect(svg.headers["content-type"]).toContain("image/svg+xml");
    expect(String(svg.text ?? svg.body)).toContain("<svg");
    const info = (await pmc.get(`/api/vehicles/${vA.id}/qr-info`)).body.data;
    expect(info.url).not.toContain(vA.id);
    const token = info.url.split("/q/")[1];
    expect((await pmc.get(`/api/qr/${token}`)).body.data.id).toBe(vA.id);
    expect((await dc.get(`/api/qr/${token}`)).body.data.id).toBe(vA.id); // driver of the vehicle
    const { client: otherPm } = await userAndClient(["PROJECT_MANAGER"]);
    expect((await otherPm.get(`/api/qr/${token}`)).status).toBe(404);
    expect((await otherPm.get(`/api/vehicles/${vA.id}/qr`)).status).toBe(404);
    expect((await pmc.get(`/api/vehicles/${vA.id}/qr?format=png`)).headers["content-type"]).toBe("image/png");
    // token is stable
    expect((await pmc.get(`/api/vehicles/${vA.id}/qr-info`)).body.data.url).toBe(info.url);
  });
});

describe("GPS tracking V1", () => {
  it("driver trip on own vehicle, batched points, distance, latest location scoped to the project", async () => {
    const { pA, vA, dc, pmc } = await driverWithVehicle();
    const vOther = await createVehicle(pA.id);
    expect((await dc.post("/api/tracking/trips", { vehicleId: vOther.id })).status).toBe(403);
    const t = await dc.post("/api/tracking/trips", { vehicleId: vA.id });
    expect(t.status).toBe(201);
    expect((await dc.post("/api/tracking/trips", { vehicleId: vA.id })).status).toBe(409);
    const id = t.body.data.id;
    setClock(new Date("2026-06-15T09:10:00Z")); // points are sent after they were recorded
    // ~1.11 km per 0.01° latitude
    const pts = [0, 1, 2].map((i) => ({ lat: 24.7 + i * 0.01, lng: 46.7, accuracy: 10, recordedAt: new Date(Date.UTC(2026, 5, 15, 9, i * 2)).toISOString() }));
    const r = await dc.post(`/api/tracking/trips/${id}/points`, { points: pts });
    expect(r.body.data).toMatchObject({ accepted: 3, ignored: 0 });
    expect(r.body.data.distanceAddedMeters).toBeGreaterThan(2200);
    expect(r.body.data.distanceAddedMeters).toBeLessThan(2250);
    // re-sending old points is ignored; implausible jump is not counted
    expect((await dc.post(`/api/tracking/trips/${id}/points`, { points: pts })).body.data.accepted).toBe(0);
    const jump = await dc.post(`/api/tracking/trips/${id}/points`, { points: [{ lat: 26.0, lng: 46.7, accuracy: 10, recordedAt: new Date(Date.UTC(2026, 5, 15, 9, 5)).toISOString() }] });
    expect(jump.body.data.distanceAddedMeters).toBe(0);
    // invalid coordinates rejected
    expect((await dc.post(`/api/tracking/trips/${id}/points`, { points: [{ lat: 95, lng: 0, recordedAt: new Date().toISOString() }] })).status).toBe(400);

    const latest = (await pmc.get("/api/tracking/latest")).body.data;
    expect(latest.find((l: { vehicleId: string }) => l.vehicleId === vA.id)).toMatchObject({ latitude: "26.000000", tripActive: true });
    const { client: otherPm } = await userAndClient(["PROJECT_MANAGER"]);
    expect((await otherPm.get("/api/tracking/latest")).body.data.find((l: { vehicleId: string }) => l.vehicleId === vA.id)).toBeUndefined();
    expect((await otherPm.get(`/api/tracking/trips/${id}/points`)).status).toBe(404);
    expect((await pmc.get(`/api/tracking/trips/${id}/points`)).body.data.points).toHaveLength(4);
    // a driver without gps.read cannot see the fleet map
    expect((await dc.get("/api/tracking/latest")).status).toBe(403);
    const end = await dc.post(`/api/tracking/trips/${id}/end`);
    expect(end.body.data.status).toBe("ENDED");
    expect((await dc.post(`/api/tracking/trips/${id}/points`, { points: pts })).status).toBe(409);
  });

  it("map config never exposes a provider key", async () => {
    const { client } = await userAndClient(["VIEWER"]);
    const m = (await client.get("/api/config/map")).body.data;
    expect(m.provider).toBe("osm");
    expect(m.tileUrl).toBe("https://tile.openstreetmap.org/{z}/{x}/{y}.png");
    expect((await client.get("/api/map/tiles/1/0/0")).status).toBe(404); // no proxy configured
  });
});

describe("reports", () => {
  it("admin can run all 12 reports; CSV has BOM, escaping and audit; totals computed", async () => {
    const { client: admin, user } = await userAndClient(["SUPER_ADMIN"]);
    const list = (await admin.get("/api/reports")).body;
    expect(list.data.map((r: { key: string }) => r.key).sort()).toEqual([...REPORT_KEYS].sort());
    expect(REPORT_KEYS).toHaveLength(12);
    for (const key of REPORT_KEYS) {
      const r = await admin.get(`/api/reports/${key}?from=2026-01-01&to=2026-12-31`);
      expect(r.status, key).toBe(200);
      expect(Array.isArray(r.body.data)).toBe(true);
    }
    const p = await createProject();
    const v = await createVehicle(p.id);
    await db.insert(fuelTransactions).values({ organizationId: await defaultOrgId(), vehicleId: v.id, projectId: p.id, fueledAt: new Date("2026-06-01T10:00:00Z"), liters: "10.00", pricePerLiter: "2.000", total: "20.00", station: "=HYPERLINK(\"x\")", createdBy: user.id });
    const fuel = (await admin.get(`/api/reports/fuel?projectId=${p.id}`)).body;
    expect(fuel.meta.totals).toMatchObject({ liters: "10.0", total: "20.00" });
    const csv = await admin.get(`/api/reports/fuel?projectId=${p.id}&format=csv`);
    expect(csv.headers["content-type"]).toContain("text/csv");
    expect(csv.text.charCodeAt(0)).toBe(0xfeff);
    expect(csv.text).toContain(`"'=HYPERLINK(""x"")"`);
    expect((await db.select().from(auditLogs).where(eq(auditLogs.action, "REPORT_EXPORTED"))).length).toBeGreaterThan(0);
    expect((await admin.get("/api/reports/fuel?status=OPEN")).status).toBe(400);
    expect((await admin.get("/api/reports/nope")).status).toBe(404);
    expect(csvCell("-2+3")).toBe("'-2+3");
  });

  it("scope and permissions: viewer cannot export, PM rows limited to own project, driver has no reports", async () => {
    const pm = await createUser(["PROJECT_MANAGER"]);
    const pA = await createProject({ managerId: pm.id });
    await createVehicle(pA.id, { plateNumber: "PM-OWN-1" });
    await createVehicle((await createProject()).id, { plateNumber: "PM-FOREIGN-1" });
    const pmc = await login(pm.email);
    const rows = (await pmc.get("/api/reports/vehicles")).body.data.map((r: { plateNumber: string }) => r.plateNumber);
    expect(rows).toContain("PM-OWN-1");
    expect(rows).not.toContain("PM-FOREIGN-1");
    const viewer = await createUser(["VIEWER"]);
    const vc = await login(viewer.email);
    expect((await vc.get("/api/reports/vehicles")).status).toBe(200);
    expect((await vc.get("/api/reports/vehicles?format=csv")).status).toBe(403);
    expect((await vc.get("/api/reports/invoices")).status).toBe(403); // no invoices.read
    const { client: dc } = await userAndClient(["DRIVER"]);
    expect((await dc.get("/api/reports")).status).toBe(403);
  });
});
