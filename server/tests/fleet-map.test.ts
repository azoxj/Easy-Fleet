import { eq } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { db } from "../src/db/client.js";
import { accidents, locationPings, trips, vehicleLocations, vehicles } from "../src/db/schema/index.js";
import { setClock } from "../src/lib/clock.js";
import { createDriverUser, createProject, createUser, createVehicle, login } from "./helpers.js";

/**
 * Fleet map data: /api/tracking/latest and the trip history must follow the
 * same server-side scope as the vehicle endpoints for every role.
 */
const NOW = new Date("2026-06-15T09:00:00Z");
beforeEach(() => setClock(NOW));
afterEach(() => setClock(null));

async function locate(v: { id: string; organizationId: string }, lat: number, lng: number, o: { minutesAgo?: number; speed?: string; tripId?: string | null; driverId?: string | null } = {}) {
  await db.insert(vehicleLocations).values({ vehicleId: v.id, organizationId: v.organizationId, driverId: o.driverId ?? null, tripId: o.tripId ?? null, latitude: lat.toFixed(6), longitude: lng.toFixed(6), speed: o.speed ?? null, heading: "90.00", recordedAt: new Date(NOW.getTime() - (o.minutesAgo ?? 1) * 60_000) });
}

async function world() {
  const pmA = await createUser(["PROJECT_MANAGER"]);
  const pmB = await createUser(["PROJECT_MANAGER"]);
  const viewer = await createUser(["VIEWER"]);
  const admin = await createUser(["SUPER_ADMIN"]);
  const pA = await createProject({ managerId: pmA.id, members: [viewer.id] });
  const pB = await createProject({ managerId: pmB.id });
  const vA = await createVehicle(pA.id);
  const vA2 = await createVehicle(pA.id); // never reported a position
  const vB = await createVehicle(pB.id);
  const drv = await createDriverUser(pA.id);
  await db.update(vehicles).set({ assignedDriverId: drv.driver.id, status: "ASSIGNED" }).where(eq(vehicles.id, vA.id));
  const [tA] = await db.insert(trips).values({ organizationId: vA.organizationId, driverId: drv.driver.id, vehicleId: vA.id, projectId: pA.id, userId: drv.user.id, status: "ENDED", startedAt: new Date(NOW.getTime() - 3_600_000), endedAt: new Date(NOW.getTime() - 1_800_000) }).returning();
  await db.insert(locationPings).values([12.5, 21.4, 8].map((speed, i) => ({ organizationId: vA.organizationId, tripId: tA!.id, driverId: drv.driver.id, vehicleId: vA.id, projectId: pA.id, latitude: (24.7 + i * 0.001).toFixed(6), longitude: "46.700000", speed: speed.toFixed(2), recordedAt: new Date(NOW.getTime() - 3_000_000 + i * 60_000) })));
  const drvB = await createDriverUser(pB.id);
  const [tB] = await db.insert(trips).values({ organizationId: vB.organizationId, driverId: drvB.driver.id, vehicleId: vB.id, projectId: pB.id, userId: drvB.user.id, status: "ENDED", startedAt: new Date(NOW.getTime() - 3_600_000), endedAt: new Date(NOW.getTime() - 1_800_000) }).returning();
  await locate(vA, 24.71, 46.67, { speed: "15.00", tripId: tA!.id, driverId: drv.driver.id });
  await locate(vB, 21.54, 39.17, { minutesAgo: 90, tripId: tB!.id });
  await db.insert(accidents).values({ organizationId: vB.organizationId, vehicleId: vB.id, projectId: pB.id, occurredAt: NOW, description: "test", severity: "MINOR", status: "OPEN", createdBy: pmB.id });
  return { pA, pB, vA, vA2, vB, tA: tA!, tB: tB!, drv, clients: { admin: await login(admin.email), pmA: await login(pmA.email), pmB: await login(pmB.email), viewer: await login(viewer.email), driver: await login(drv.user.email) } };
}

type Loc = { vehicleId: string; stale: boolean; openAccident: boolean; driverName: string | null; currentDriverName: string | null; speed: string | null; projectName: string | null };
const ids = (rows: Loc[]) => rows.map((r) => r.vehicleId);

describe("fleet map data scope", () => {
  it("SUPER_ADMIN sees every vehicle position with map fields and the scope total", async () => {
    const w = await world();
    const r = await w.clients.admin.get("/api/tracking/latest");
    expect(r.status).toBe(200);
    expect(ids(r.body.data)).toEqual(expect.arrayContaining([w.vA.id, w.vB.id]));
    expect(ids(r.body.data)).not.toContain(w.vA2.id); // no invented position for a vehicle that never reported
    const a = r.body.data.find((l: Loc) => l.vehicleId === w.vA.id) as Loc;
    const b = r.body.data.find((l: Loc) => l.vehicleId === w.vB.id) as Loc;
    expect(a).toMatchObject({ stale: false, openAccident: false, speed: "15.00", driverName: expect.any(String), currentDriverName: expect.any(String), projectName: w.pA.name });
    expect(b).toMatchObject({ stale: true, openAccident: true });
    expect(r.body.meta).toMatchObject({ staleMinutes: 15, speedUnit: "m/s", serverTime: NOW.toISOString() });
    expect(r.body.meta.total).toBeGreaterThanOrEqual(3);
  });

  it("PROJECT_MANAGER only receives positions and trips of vehicles in their projects — filters cannot widen it", async () => {
    const w = await world();
    const pm = w.clients.pmA;
    const r = await pm.get("/api/tracking/latest");
    expect(ids(r.body.data)).toContain(w.vA.id);
    expect(ids(r.body.data)).not.toContain(w.vB.id);
    expect(r.body.meta.total).toBe(2); // vA + vA2
    expect(r.body.data.every((l: Loc) => l.projectName === w.pA.name)).toBe(true);
    const byProject = await pm.get(`/api/tracking/latest?projectId=${w.pB.id}`);
    expect(byProject.status).toBe(200);
    expect(byProject.body.data).toEqual([]);
    expect(byProject.body.meta.total).toBe(0);
    expect((await pm.get(`/api/tracking/latest?vehicleId=${w.vB.id}`)).body.data).toEqual([]);
    expect(ids((await pm.get(`/api/tracking/latest?vehicleId=${w.vA.id}`)).body.data)).toEqual([w.vA.id]);
    // trip history
    const trips = await pm.get(`/api/tracking/trips?vehicleId=${w.vA.id}`);
    expect(trips.body.data).toHaveLength(1);
    expect(Number(trips.body.data[0].maxSpeed)).toBe(21.4);
    expect((await pm.get(`/api/tracking/trips?vehicleId=${w.vB.id}`)).body.data).toEqual([]);
    expect((await pm.get(`/api/tracking/trips/${w.tB.id}/points`)).status).toBe(404);
    expect((await pm.get(`/api/tracking/trips/${w.tA.id}/points`)).body.data.points).toHaveLength(3);
    // and the other project's manager sees the mirror image
    expect(ids((await w.clients.pmB.get("/api/tracking/latest")).body.data)).toEqual([w.vB.id]);
  });

  it("DRIVER cannot read the fleet map and only sees their own trips", async () => {
    const w = await world();
    const d = w.clients.driver;
    expect((await d.get("/api/tracking/latest")).status).toBe(403);
    expect((await d.get(`/api/tracking/latest?vehicleId=${w.vA.id}`)).status).toBe(403);
    const own = await d.get("/api/tracking/trips");
    expect(own.status).toBe(200);
    expect(own.body.data.map((t: { id: string }) => t.id)).toEqual([w.tA.id]);
    expect((await d.get(`/api/tracking/trips/${w.tB.id}/points`)).status).toBe(404);
  });

  it("VIEWER (no gps.read) gets no positions or trips, even for a project they belong to", async () => {
    const w = await world();
    const v = w.clients.viewer;
    expect((await v.get("/api/tracking/latest")).status).toBe(403);
    expect((await v.get(`/api/tracking/latest?projectId=${w.pA.id}`)).status).toBe(403);
    expect((await v.get(`/api/tracking/trips?vehicleId=${w.vA.id}`)).status).toBe(403);
    expect((await v.get(`/api/tracking/trips/${w.tA.id}/points`)).status).toBe(403);
  });

  it("rejects malformed filters", async () => {
    const w = await world();
    expect((await w.clients.admin.get("/api/tracking/latest?vehicleId=not-a-uuid")).status).toBe(400);
    expect((await w.clients.admin.get("/api/tracking/latest?projectId=1")).status).toBe(400);
  });
});
