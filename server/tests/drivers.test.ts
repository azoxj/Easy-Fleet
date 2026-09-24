import { and, eq, isNull } from "drizzle-orm";
import request from "supertest";
import { afterEach, describe, expect, it } from "vitest";
import { db } from "../src/db/client.js";
import { notifications, vehicleDriverHistory, vehicles } from "../src/db/schema/index.js";
import { addDays, setClock, today } from "../src/lib/clock.js";
import { app, createDriverFor, createEmployee, createProject, createUser, createVehicle, login, uid, userAndClient } from "./helpers.js";

afterEach(() => setClock(null));

async function pmSetup() {
  const pm = await createUser(["PROJECT_MANAGER"]);
  const pA = await createProject({ managerId: pm.id });
  const pB = await createProject();
  return { pm, pA, pB, pmc: await login(pm.email) };
}

describe("drivers — CRUD & employee relationship", () => {
  it("creates a driver from an employee in scope; project comes from the employee", async () => {
    const { pmc, pA } = await pmSetup();
    const e = await createEmployee(pA.id);
    const expiry = addDays(today(), 400);
    const res = await pmc.post("/api/drivers", { employeeId: e.id, licenseNumber: `LIC-${uid()}`, licenseType: "PRIVATE", licenseIssueDate: "2024-01-01", licenseExpiryDate: expiry });
    expect(res.status).toBe(201);
    const d = await pmc.get(`/api/drivers/${res.body.data.id}`);
    expect(d.status).toBe(200);
    expect(d.body.data).toMatchObject({ employeeId: e.id, projectId: pA.id, status: "ACTIVE", licenseStatus: "ACTIVE", licenseType: "PRIVATE" });
    expect(d.body.data).not.toHaveProperty("nationalId");
    // one driver profile per employee
    expect((await pmc.post("/api/drivers", { employeeId: e.id })).status).toBe(409);
    // employee detail links back to the driver
    expect((await pmc.get(`/api/employees/${e.id}`)).body.data.driver.id).toBe(res.body.data.id);
  });

  it("validates input and relationship rules", async () => {
    const { pmc, pA, pB } = await pmSetup();
    const e = await createEmployee(pA.id);
    expect((await pmc.post("/api/drivers", { employeeId: "nope" })).status).toBe(400);
    expect((await pmc.post("/api/drivers", { employeeId: e.id, licenseType: "SPACESHIP" })).status).toBe(400);
    expect((await pmc.post("/api/drivers", { employeeId: e.id, licenseIssueDate: "2026-05-01", licenseExpiryDate: "2026-01-01" })).status).toBe(400);
    expect((await pmc.post("/api/drivers", { employeeId: e.id, status: "EXPIRED" })).status).toBe(400); // derived, never client-set
    const foreign = await createEmployee(pB.id);
    expect((await pmc.post("/api/drivers", { employeeId: foreign.id })).status).toBe(404);
    const inactive = await createEmployee(pA.id, { status: "SUSPENDED" });
    expect((await pmc.post("/api/drivers", { employeeId: inactive.id })).status).toBe(400);
  });

  it("status EXPIRED is computed from the license date and the server clock", async () => {
    const { pmc, pA } = await pmSetup();
    setClock(new Date("2026-06-15T09:00:00Z"));
    const d = await createDriverFor((await createEmployee(pA.id)).id, { licenseExpiryDate: "2026-06-20" });
    let r = await pmc.get(`/api/drivers/${d.id}`);
    expect(r.body.data).toMatchObject({ status: "ACTIVE", licenseStatus: "EXPIRING_SOON", licenseDaysLeft: 5 });
    expect(r.body.data.alerts[0].message).toContain("5");
    setClock(new Date("2026-06-21T09:00:00Z"));
    r = await pmc.get(`/api/drivers/${d.id}`);
    expect(r.body.data).toMatchObject({ status: "EXPIRED", licenseStatus: "EXPIRED" });
    expect(r.body.data.alerts[0].level).toBe("danger");
    const expired = await pmc.get("/api/drivers?status=EXPIRED&pageSize=100");
    expect(expired.body.data.map((x: { id: string }) => x.id)).toContain(d.id);
    const active = await pmc.get("/api/drivers?status=ACTIVE&pageSize=100");
    expect(active.body.data.map((x: { id: string }) => x.id)).not.toContain(d.id);
  });

  it("update, archive and their guards", async () => {
    const { client } = await userAndClient(["SUPER_ADMIN"]);
    const p = await createProject();
    const d = await createDriverFor((await createEmployee(p.id)).id);
    expect((await client.patch(`/api/drivers/${d.id}`, { status: "SUSPENDED", notes: "إيقاف مؤقت" })).status).toBe(200);
    expect((await client.get(`/api/drivers/${d.id}`)).body.data.status).toBe("SUSPENDED");
    expect((await client.patch(`/api/drivers/${d.id}`, { employeeId: d.id })).status).toBe(400); // employee link is immutable
    expect((await client.post(`/api/drivers/${d.id}/archive`)).status).toBe(200);
    expect((await client.patch(`/api/drivers/${d.id}`, { notes: "x" })).status).toBe(400);
    expect((await client.get("/api/drivers?pageSize=100")).body.data.map((x: { id: string }) => x.id)).not.toContain(d.id);
  });

  it("401 / 403 / 404", async () => {
    expect((await request(app).get("/api/drivers")).status).toBe(401);
    const { client: viewer } = await userAndClient(["VIEWER"]);
    expect((await viewer.get("/api/drivers")).status).toBe(403);
    const { client } = await userAndClient(["SUPER_ADMIN"]);
    expect((await client.get("/api/drivers/00000000-0000-4000-8000-000000000000")).status).toBe(404);
    expect((await client.get("/api/drivers/123")).status).toBe(400);
  });
});

describe("drivers — project scope & IDOR", () => {
  it("PM sees only drivers of their projects; others are 404 for read/update", async () => {
    const { pmc, pA, pB } = await pmSetup();
    const mine = await createDriverFor((await createEmployee(pA.id)).id);
    const theirs = await createDriverFor((await createEmployee(pB.id)).id);
    const ids = (await pmc.get("/api/drivers?pageSize=100")).body.data.map((x: { id: string }) => x.id);
    expect(ids).toContain(mine.id);
    expect(ids).not.toContain(theirs.id);
    expect((await pmc.get(`/api/drivers/${theirs.id}`)).status).toBe(404);
    expect((await pmc.patch(`/api/drivers/${theirs.id}`, { notes: "x" })).status).toBe(404);
  });

  it("DRIVER sees only their own driver profile", async () => {
    const u = await createUser(["DRIVER"]);
    const p = await createProject();
    const own = await createDriverFor((await createEmployee(p.id, { userId: u.id })).id);
    const other = await createDriverFor((await createEmployee(p.id)).id);
    const c = await login(u.email);
    expect((await c.get("/api/drivers")).body.data.map((x: { id: string }) => x.id)).toEqual([own.id]);
    expect((await c.get(`/api/drivers/${other.id}`)).status).toBe(404);
    expect((await c.patch(`/api/drivers/${own.id}`, { notes: "x" })).status).toBe(403);
  });
});

describe("vehicle ↔ driver assignment", () => {
  it("assigns a driver, records history, updates status, notifies and appears in the timeline", async () => {
    const { pmc, pA } = await pmSetup();
    const driverUser = await createUser(["DRIVER"]);
    const d = await createDriverFor((await createEmployee(pA.id, { userId: driverUser.id })).id, { licenseExpiryDate: addDays(today(), 200) });
    const v = await createVehicle(pA.id);
    const res = await pmc.put(`/api/vehicles/${v.id}/driver`, { driverId: d.id });
    expect(res.status).toBe(200);
    expect(res.body.data).toMatchObject({ assignedDriverId: d.id, status: "ASSIGNED" });
    const hist = await db.select().from(vehicleDriverHistory).where(eq(vehicleDriverHistory.vehicleId, v.id));
    expect(hist).toHaveLength(1);
    expect((await db.select().from(notifications).where(eq(notifications.userId, driverUser.id))).map((n) => n.type)).toContain("VEHICLE_DRIVER_ASSIGNED");
    // the driver can now see the vehicle (ASSIGNED scope via driver link)
    expect((await (await login(driverUser.email)).get(`/api/vehicles/${v.id}`)).status).toBe(200);

    const detail = await pmc.get(`/api/vehicles/${v.id}`);
    expect(detail.body.data.currentDriver.id).toBe(d.id);
    const drv = await pmc.get(`/api/drivers/${d.id}`);
    expect(drv.body.data.currentVehicleId).toBe(v.id);

    // unassign → history closed, status back to AVAILABLE
    const un = await pmc.put(`/api/vehicles/${v.id}/driver`, { driverId: null });
    expect(un.body.data).toMatchObject({ assignedDriverId: null, status: "AVAILABLE" });
    const open = await db.select().from(vehicleDriverHistory).where(and(eq(vehicleDriverHistory.vehicleId, v.id), isNull(vehicleDriverHistory.unassignedAt)));
    expect(open).toHaveLength(0);
    const history = (await pmc.get(`/api/drivers/${d.id}`)).body.data.history;
    expect(history).toHaveLength(1);
    expect(history[0].plateNumber).toBe(v.plateNumber);

    const tl = (await pmc.get(`/api/vehicles/${v.id}/timeline`)).body.data;
    const driverEvents = tl.filter((e: { action: string }) => e.action === "VEHICLE_DRIVER_CHANGED");
    expect(driverEvents).toHaveLength(2);
    expect(driverEvents[1].description).toContain("إسناد السائق");
    expect(driverEvents[0].description).toContain("إلغاء إسناد السائق");
    expect(driverEvents[0].actor).toBeTruthy();
  });

  it("enforces project match, license validity and one vehicle per driver", async () => {
    const { pmc, pA, pB } = await pmSetup();
    const v1 = await createVehicle(pA.id);
    const v2 = await createVehicle(pA.id);
    const foreignDriver = await createDriverFor((await createEmployee(pB.id)).id);
    expect((await pmc.put(`/api/vehicles/${v1.id}/driver`, { driverId: foreignDriver.id })).status).toBe(404);

    const expired = await createDriverFor((await createEmployee(pA.id)).id, { licenseExpiryDate: addDays(today(), -1) });
    expect((await pmc.put(`/api/vehicles/${v1.id}/driver`, { driverId: expired.id })).status).toBe(400);

    const ok = await createDriverFor((await createEmployee(pA.id)).id);
    expect((await pmc.put(`/api/vehicles/${v1.id}/driver`, { driverId: ok.id })).status).toBe(200);
    expect((await pmc.put(`/api/vehicles/${v2.id}/driver`, { driverId: ok.id })).status).toBe(409);
    // driver holding a vehicle cannot be suspended or archived; vehicle cannot be archived
    expect((await pmc.patch(`/api/drivers/${ok.id}`, { status: "SUSPENDED" })).status).toBe(409);
    const { client: admin } = await userAndClient(["SUPER_ADMIN"]);
    expect((await admin.post(`/api/drivers/${ok.id}/archive`)).status).toBe(409);
    expect((await admin.post(`/api/vehicles/${v1.id}/archive`)).status).toBe(409);
  });

  it("PM cannot change the driver of a foreign vehicle; TECHNICAL cannot change drivers", async () => {
    const { pmc, pB } = await pmSetup();
    const v = await createVehicle(pB.id);
    const d = await createDriverFor((await createEmployee(pB.id)).id);
    expect((await pmc.put(`/api/vehicles/${v.id}/driver`, { driverId: d.id })).status).toBe(404);
    const { client: tech } = await userAndClient(["TECHNICAL"]);
    expect((await tech.put(`/api/vehicles/${v.id}/driver`, { driverId: d.id })).status).toBe(403);
    const [row] = await db.select().from(vehicles).where(eq(vehicles.id, v.id));
    expect(row!.assignedDriverId).toBeNull();
  });

  it("driver history hides vehicles outside the caller's vehicle scope", async () => {
    const { pmc, pA, pB } = await pmSetup();
    const { client: admin } = await userAndClient(["SUPER_ADMIN"]);
    const e = await createEmployee(pB.id);
    const d = await createDriverFor(e.id);
    const vB = await createVehicle(pB.id);
    expect((await admin.put(`/api/vehicles/${vB.id}/driver`, { driverId: d.id })).status).toBe(200);
    expect((await admin.put(`/api/vehicles/${vB.id}/driver`, { driverId: null })).status).toBe(200);
    // employee moves to project A (PM's project)
    expect((await admin.patch(`/api/employees/${e.id}`, { projectId: pA.id })).status).toBe(200);
    const h = (await pmc.get(`/api/drivers/${d.id}`)).body.data.history;
    expect(h).toHaveLength(1);
    expect(h[0].plateNumber).toBeNull();
    expect(h[0].vehicleId).toBeNull();
  });
});
