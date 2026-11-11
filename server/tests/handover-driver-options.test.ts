import { eq } from "drizzle-orm";
import { describe, expect, it } from "vitest";
import { db } from "../src/db/client.js";
import { drivers, employees, handoverSessions, organizations } from "../src/db/schema/index.js";
import { createDriverFor, createEmployee, createProject, createUser, createVehicle, login, uid, userAndClient, type Client } from "./helpers.js";

type Opt = { id: string; fullName: string; unavailable: string | null; currentVehiclePlate: string | null; projectName: string | null };
const options = async (c: Client, vehicleId: string) => {
  const r = await c.get(`/api/handovers/driver-options?vehicleId=${vehicleId}`);
  return { status: r.status, list: (r.body.data ?? []) as Opt[], busy: r.body.meta?.vehicleBusy as boolean | undefined };
};
const byId = (list: Opt[], id: string) => list.find((d) => d.id === id);
/** A driver profile (employee + driver) in a project or in none, with whatever licence data is given. */
async function driver(projectId: string | null, extra: Partial<typeof drivers.$inferInsert> = {}, emp: Partial<typeof employees.$inferInsert> = {}) {
  const e = await createEmployee(projectId, emp);
  return { emp: e, driver: await createDriverFor(e.id, { licenseNumber: null, licenseExpiryDate: null, ...extra }) };
}

describe("handover driver picker — who is listed", () => {
  it("lists every active driver the admin may read, whatever the project, vehicle or licence data (same as /drivers)", async () => {
    const { client: sa } = await userAndClient(["SUPER_ADMIN"]);
    const pA = await createProject();
    const projectless = await createVehicle(null);
    const dNone = await driver(null); // no project, no vehicle, no licence data
    const dA = await driver(pA.id);
    const dLic = await driver(null, { licenseNumber: `L-${uid()}`, licenseExpiryDate: "2099-01-01" });
    const page = (await sa.get("/api/drivers?status=ACTIVE&pageSize=100")).body.data as { id: string }[];
    const { status, list } = await options(sa, projectless.id); // a vehicle without a project used to give an empty list
    expect(status).toBe(200);
    for (const d of [dNone, dA, dLic]) {
      expect(byId(list, d.driver.id), d.emp.fullName).toBeTruthy();
      expect(list.every((x) => !!x.id)).toBe(true);
    }
    // everything the Drivers page lists as active is offered (page is capped at 100 rows)
    for (const d of page) expect(byId(list, d.id), d.id).toBeTruthy();
  });

  it("does not list archived, suspended, inactive or licence-expired drivers (not 'active' on the Drivers page either)", async () => {
    const { client: sa } = await userAndClient(["SUPER_ADMIN"]);
    const v = await createVehicle(null);
    const archived = await driver(null, { archivedAt: new Date() });
    const suspended = await driver(null, { status: "SUSPENDED" });
    const inactiveEmployee = await driver(null, {}, { status: "INACTIVE" });
    const expired = await driver(null, { licenseNumber: `L-${uid()}`, licenseExpiryDate: "2020-01-01" });
    const { list } = await options(sa, v.id);
    for (const d of [archived, suspended, inactiveEmployee, expired]) expect(byId(list, d.driver.id)).toBeUndefined();
  });

  it("never lists drivers of another organization, and the server refuses to hand over to one", async () => {
    const { client: sa } = await userAndClient(["SUPER_ADMIN"]);
    const v = await createVehicle(null);
    const [org2] = await db.insert(organizations).values({ name: `Org ${uid()}`, slug: `org-${uid()}` }).returning();
    const [e] = await db.insert(employees).values({ organizationId: org2!.id, employeeNumber: `E-${uid()}`, fullName: "سائق مؤسسة أخرى" }).returning();
    const [foreign] = await db.insert(drivers).values({ organizationId: org2!.id, employeeId: e!.id }).returning();
    const { list } = await options(sa, v.id);
    expect(byId(list, foreign!.id)).toBeUndefined();
    expect((await sa.post("/api/handovers", { vehicleId: v.id, driverId: foreign!.id })).status).toBe(404);
  });
});

describe("handover driver picker — conflicts are shown and enforced", () => {
  it("marks drivers that cannot take the vehicle now, with the reason, and POST /handovers refuses them", async () => {
    const { client: sa } = await userAndClient(["SUPER_ADMIN"]);
    const pA = await createProject();
    const pB = await createProject();
    const vA = await createVehicle(pA.id);
    const busyVehicle = await createVehicle(pA.id);
    const heldVehicle = await createVehicle(pA.id);

    const dBusy = await driver(pA.id);
    expect((await sa.post("/api/handovers", { vehicleId: busyVehicle.id, driverId: dBusy.driver.id })).status).toBe(201);
    const dHolding = await driver(pA.id);
    expect((await sa.put(`/api/vehicles/${heldVehicle.id}/driver`, { driverId: dHolding.driver.id })).status).toBe(200);
    const dOtherProject = await driver(pB.id);
    const dFree = await driver(pA.id);

    const { list } = await options(sa, vA.id);
    expect(byId(list, dBusy.driver.id)!.unavailable).toBe("ACTIVE_HANDOVER");
    expect(byId(list, dHolding.driver.id)).toMatchObject({ unavailable: "HOLDS_OTHER_VEHICLE", currentVehiclePlate: heldVehicle.plateNumber });
    expect(byId(list, dOtherProject.driver.id)!.unavailable).toBe("OTHER_PROJECT");
    expect(byId(list, dFree.driver.id)!.unavailable).toBeNull();

    // the server applies the same rules
    expect((await sa.post("/api/handovers", { vehicleId: vA.id, driverId: dBusy.driver.id })).status).toBe(409);
    expect((await sa.post("/api/handovers", { vehicleId: vA.id, driverId: dHolding.driver.id })).status).toBe(409);
    expect((await sa.post("/api/handovers", { vehicleId: vA.id, driverId: dOtherProject.driver.id })).status).toBe(400);
  });

  it("flags a vehicle that already has an active handover, and a vehicle assigned to another driver", async () => {
    const { client: sa } = await userAndClient(["SUPER_ADMIN"]);
    const p = await createProject();
    const v = await createVehicle(p.id);
    const owner = await driver(p.id);
    const other = await driver(p.id);
    expect((await sa.put(`/api/vehicles/${v.id}/driver`, { driverId: owner.driver.id })).status).toBe(200);
    let r = await options(sa, v.id);
    expect(byId(r.list, other.driver.id)!.unavailable).toBe("VEHICLE_HAS_OTHER_DRIVER");
    expect(byId(r.list, owner.driver.id)!.unavailable).toBeNull();
    expect(r.busy).toBe(false);
    expect((await sa.post("/api/handovers", { vehicleId: v.id, driverId: owner.driver.id })).status).toBe(201);
    r = await options(sa, v.id);
    expect(r.busy).toBe(true);
  });
});

describe("handover driver picker — choosing a driver and creating the handover", () => {
  it("a driver without a project can take a vehicle (and the reverse); earlier handover records are untouched", async () => {
    const { client: sa } = await userAndClient(["SUPER_ADMIN"]);
    const p = await createProject();
    const projectVehicle = await createVehicle(p.id);
    const projectlessVehicle = await createVehicle(null);
    const dNone = await driver(null);
    const dProject = await driver(p.id);

    // an earlier handover of the same vehicle/driver, closed out by a cancel, must survive unchanged
    const old = await sa.post("/api/handovers", { vehicleId: projectVehicle.id, driverId: dNone.driver.id });
    expect(old.status).toBe(201);
    expect((await sa.post(`/api/handovers/${old.body.data.id}/cancel`, { reason: "إلغاء قبل التسليم" })).status).toBe(200);
    const [before] = await db.select().from(handoverSessions).where(eq(handoverSessions.id, old.body.data.id));
    const countBefore = (await db.select().from(handoverSessions)).length;

    const { list } = await options(sa, projectVehicle.id);
    expect(byId(list, dNone.driver.id)!.unavailable).toBeNull(); // listed and selectable although the driver has no project
    const created = await sa.post("/api/handovers", { vehicleId: projectVehicle.id, driverId: dNone.driver.id });
    expect(created.status).toBe(201);
    expect(created.body.data).toMatchObject({ vehicleId: projectVehicle.id, driverId: dNone.driver.id, status: "PENDING_HANDOVER" }); // the photo/documentation steps still follow
    const reverse = await sa.post("/api/handovers", { vehicleId: projectlessVehicle.id, driverId: dProject.driver.id });
    expect(reverse.status).toBe(201);

    const [after] = await db.select().from(handoverSessions).where(eq(handoverSessions.id, old.body.data.id));
    expect(after).toEqual(before); // untouched
    expect((await db.select().from(handoverSessions)).length).toBe(countBefore + 2); // only the two new sessions
  });

  it("a PROJECT_MANAGER sees only drivers of his own projects, and no options for a vehicle outside his scope", async () => {
    const pm = await createUser(["PROJECT_MANAGER"]);
    const mine = await createProject({ managerId: pm.id });
    const other = await createProject();
    const v = await createVehicle(mine.id);
    const vOther = await createVehicle(other.id);
    const vNone = await createVehicle(null);
    const own = await driver(mine.id);
    const foreign = await driver(other.id);
    const none = await driver(null);
    const c = await login(pm.email);
    const { status, list } = await options(c, v.id);
    expect(status).toBe(200);
    expect(byId(list, own.driver.id)).toBeTruthy();
    expect(byId(list, foreign.driver.id)).toBeUndefined();
    expect(byId(list, none.driver.id)).toBeUndefined(); // outside his project scope: not widened
    expect((await options(c, vOther.id)).status).toBe(404);
    expect((await options(c, vNone.id)).status).toBe(404);
    expect((await c.post("/api/handovers", { vehicleId: v.id, driverId: foreign.driver.id })).status).toBe(404);
    expect((await c.post("/api/handovers", { vehicleId: v.id, driverId: own.driver.id })).status).toBe(201);
  });

  it("needs handover.create", async () => {
    const v = await createVehicle(null);
    for (const role of ["VIEWER", "DRIVER", "FINANCE"] as const) {
      const { client } = await userAndClient([role]);
      expect((await options(client, v.id)).status, role).toBe(403);
    }
  });
});
