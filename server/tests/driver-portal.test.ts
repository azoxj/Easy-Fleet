import { and, eq, inArray, sql } from "drizzle-orm";
import request from "supertest";
import { describe, expect, it } from "vitest";
import { db } from "../src/db/client.js";
import { auditLogs, driverPortalLinks, drivers, employees, handoverSessions, organizations, vehicles } from "../src/db/schema/index.js";
import { app, createDriverUser, createProject, createUser, createVehicle, JPEG_BYTES, login, uid, userAndClient, type Client } from "./helpers.js";

const REQUIRED = ["FRONT", "REAR", "LEFT", "RIGHT", "INTERIOR", "ODOMETER", "TIRES"];
type Drv = Awaited<ReturnType<typeof createDriverUser>>;

const tokenOf = (link: string) => link.split("/p/")[1]!;
const issue = async (admin: Client, driverId: string) => {
  const r = await admin.post(`/api/driver-portal/drivers/${driverId}/link`);
  expect([200, 201]).toContain(r.status);
  return tokenOf(r.body.data.link as string);
};
const get = (t: string) => request(app).get(`/api/portal/${t}`);
const take = (t: string, vehicleId: string, employeeNumber: string) => request(app).post(`/api/portal/${t}/vehicles/${vehicleId}/take`).send({ employeeNumber });
const photo = (t: string, sid: string, cat: string, bytes: Buffer = JPEG_BYTES) =>
  request(app).put(`/api/portal/${t}/sessions/${sid}/photos/${cat}`).set("Content-Type", "image/jpeg").set("X-File-Name", "p.jpg").send(bytes);
const submit = (t: string, sid: string, body: object) => request(app).post(`/api/portal/${t}/sessions/${sid}/submit`).send(body);
const photos = async (t: string, sid: string) => {
  for (const c of REQUIRED) expect((await photo(t, sid, c)).status, c).toBe(201);
};
/** Takes a vehicle and completes the pickup (7 photos + confirmation) → the session is RETURN_PENDING. */
async function pickUp(t: string, d: Drv, vehicleId: string, odometer = 100) {
  const r = await take(t, vehicleId, d.employee.employeeNumber);
  expect(r.status).toBe(201);
  const sid = r.body.data.sessionId as string;
  await photos(t, sid);
  expect((await submit(t, sid, { odometer, confirm: true, employeeNumber: d.employee.employeeNumber })).body.data.status).toBe("RETURN_PENDING");
  return sid;
}

async function world() {
  const { client: sa } = await userAndClient(["SUPER_ADMIN"]);
  const pA = await createProject();
  const pB = await createProject();
  const d = await createDriverUser(pA.id);
  return { sa, pA, pB, d, t: await issue(sa, d.driver.id) };
}

describe("driver portal — the permanent link", () => {
  it("is created once (raw token shown once, only its hash stored), renewed, revoked and reopened by an admin; every step audited", async () => {
    const { sa, d, t } = await world();
    const [row] = await db.select().from(driverPortalLinks).where(eq(driverPortalLinks.driverId, d.driver.id));
    expect(row!.tokenHash).not.toContain(t);
    expect(row!.tokenHash).toHaveLength(64);
    expect((await get(t)).status).toBe(200);

    const t2 = await issue(sa, d.driver.id); // renew
    expect(t2).not.toBe(t);
    expect((await get(t)).status).toBe(404); // the old token is dead at once
    expect((await get(t2)).status).toBe(200);

    expect((await sa.post(`/api/driver-portal/drivers/${d.driver.id}/link/revoke`)).status).toBe(200);
    expect((await get(t2)).status).toBe(404);
    expect((await sa.post(`/api/driver-portal/drivers/${d.driver.id}/link/revoke`)).status).toBe(409); // nothing active to revoke
    const t3 = await issue(sa, d.driver.id); // reopen with a brand-new token
    expect((await get(t3)).status).toBe(200);
    expect((await get(t2)).status).toBe(404);

    const actions = (await db.select().from(auditLogs).where(eq(auditLogs.entityId, d.driver.id))).map((a) => a.action);
    expect(actions).toEqual(expect.arrayContaining(["DRIVER_PORTAL_LINK_CREATED", "DRIVER_PORTAL_LINK_RENEWED", "DRIVER_PORTAL_LINK_REVOKED", "DRIVER_PORTAL_TOKEN_INVALID"]));
    // one link per driver, whatever the number of renewals
    expect((await db.select().from(driverPortalLinks).where(eq(driverPortalLinks.driverId, d.driver.id))).length).toBe(1);
  });

  it("guessing: unknown and malformed tokens get the same answer and are rate limited", async () => {
    const bad = "A".repeat(43);
    for (const t of [bad, "short", "x".repeat(60), "a b"]) expect((await get(t)).status).toBe(404);
    let last = 0;
    for (let i = 0; i < 25; i++) last = (await get(bad)).status;
    expect(last).toBe(429);
  });

  it("needs handover.manage; a project manager manages only drivers of his projects", async () => {
    const pm = await createUser(["PROJECT_MANAGER"]);
    const mine = await createProject({ managerId: pm.id });
    const other = await createProject();
    const own = await createDriverUser(mine.id);
    const foreign = await createDriverUser(other.id);
    const c = await login(pm.email);
    expect((await c.post(`/api/driver-portal/drivers/${own.driver.id}/link`)).status).toBe(201);
    expect((await c.post(`/api/driver-portal/drivers/${foreign.driver.id}/link`)).status).toBe(404);
    const list = (await c.get("/api/driver-portal/drivers?pageSize=100")).body.data as { id: string }[];
    expect(list.map((x) => x.id)).toContain(own.driver.id);
    expect(list.map((x) => x.id)).not.toContain(foreign.driver.id);
    for (const role of ["VIEWER", "DRIVER", "FINANCE"] as const) {
      const { client } = await userAndClient([role]);
      expect((await client.post(`/api/driver-portal/drivers/${own.driver.id}/link`)).status, role).toBe(403);
    }
  });

  it("another organization's driver can be neither linked nor listed", async () => {
    const { sa } = await world();
    const [org2] = await db.insert(organizations).values({ name: `Org ${uid()}`, slug: `org-${uid()}` }).returning();
    const [e] = await db.insert(employees).values({ organizationId: org2!.id, employeeNumber: `E-${uid()}`, fullName: "سائق مؤسسة أخرى" }).returning();
    const [foreign] = await db.insert(drivers).values({ organizationId: org2!.id, employeeId: e!.id }).returning();
    expect((await sa.post(`/api/driver-portal/drivers/${foreign!.id}/link`)).status).toBe(404);
    const list = (await sa.get("/api/driver-portal/drivers?pageSize=100")).body.data as { id: string }[];
    expect(list.map((x) => x.id)).not.toContain(foreign!.id);
  });
});

describe("driver portal — the vehicles the driver sees", () => {
  it("shows only the vehicles of his current project, with their state; other projects never appear", async () => {
    const { pA, pB, d, t } = await world();
    const free = await createVehicle(pA.id);
    const inRepair = await createVehicle(pA.id, { status: "IN_MAINTENANCE" });
    const otherDriver = await createDriverUser(pA.id);
    const taken = await createVehicle(pA.id);
    const foreignVehicle = await createVehicle(pB.id);
    const sa2 = await userAndClient(["SUPER_ADMIN"]);
    const t2 = await issue(sa2.client, otherDriver.driver.id);
    await pickUp(t2, otherDriver, taken.id);

    const v = (await get(t)).body.data;
    const state = (id: string) => v.vehicles.find((x: { id: string }) => x.id === id)?.state;
    expect(state(free.id)).toBe("AVAILABLE");
    expect(v.vehicles.find((x: { id: string }) => x.id === free.id).canTake).toBe(true);
    expect(state(inRepair.id)).toBe("UNAVAILABLE");
    expect(state(taken.id)).toBe("TAKEN");
    expect(v.vehicles.find((x: { id: string }) => x.id === taken.id).canTake).toBe(false);
    expect(state(foreignVehicle.id)).toBeUndefined(); // never listed
    expect(JSON.stringify(v)).not.toContain(otherDriver.employee.fullName); // who holds it is not disclosed
    expect(v.driver.name).toBe(d.employee.fullName);
    expect((await take(t, foreignVehicle.id, d.employee.employeeNumber)).status).toBe(404); // and cannot be taken
  });

  it("a driver without a project sees no vehicles and cannot take any", async () => {
    const { sa } = await world();
    const e = await db.insert(employees).values({ organizationId: (await db.select().from(organizations).limit(1))[0]!.id, employeeNumber: `E-${uid()}`, fullName: "سائق بلا مشروع" }).returning();
    const [drv] = await db.insert(drivers).values({ organizationId: e[0]!.organizationId, employeeId: e[0]!.id }).returning();
    const t = await issue(sa, drv!.id);
    const v = (await get(t)).body.data;
    expect(v.project).toBeNull();
    expect(v.vehicles).toEqual([]);
    const some = await createVehicle(null);
    expect((await take(t, some.id, e[0]!.employeeNumber)).status).toBe(409);
  });
});

describe("driver portal — one vehicle per driver, one driver per vehicle", () => {
  it("taking needs the employee number; wrong answers lock the driver out", async () => {
    const { pA, d, t } = await world();
    const v = await createVehicle(pA.id);
    expect((await take(t, v.id, "wrong")).status).toBe(403);
    expect((await request(app).post(`/api/portal/${t}/vehicles/${v.id}/take`).send({})).status).toBe(400);
    for (let i = 0; i < 4; i++) await take(t, v.id, "wrong");
    expect((await take(t, v.id, d.employee.employeeNumber)).status).toBe(429); // locked, even for the right number
    expect((await db.select().from(handoverSessions).where(eq(handoverSessions.vehicleId, v.id))).length).toBe(0);
  });

  it("a driver holds one vehicle at a time, from the pickup until the return is confirmed", async () => {
    const { pA, d, t } = await world();
    const v1 = await createVehicle(pA.id);
    const v2 = await createVehicle(pA.id);
    const r1 = await take(t, v1.id, d.employee.employeeNumber);
    expect(r1.status).toBe(201);
    expect((await take(t, v2.id, d.employee.employeeNumber)).status).toBe(409); // pickup not even finished
    const sid = r1.body.data.sessionId as string;
    await photos(t, sid);
    await submit(t, sid, { odometer: 10, confirm: true, employeeNumber: d.employee.employeeNumber });
    const view = (await get(t)).body.data;
    expect(view.custody).toMatchObject({ sessionId: sid, status: "RETURN_PENDING" });
    expect(view.vehicles.find((x: { id: string }) => x.id === v1.id).state).toBe("MINE");
    expect(view.vehicles.find((x: { id: string }) => x.id === v2.id).canTake).toBe(false);
    const again = await take(t, v2.id, d.employee.employeeNumber);
    expect(again.status).toBe(409);
    expect(again.body.error.code).toBe("CUSTODY_OPEN");
    // the database says the same: a second active session for the driver / the vehicle cannot exist
    await expect(db.insert(handoverSessions).values({ organizationId: (await db.select().from(vehicles).where(eq(vehicles.id, v2.id)))[0]!.organizationId, vehicleId: v2.id, driverId: d.driver.id, projectId: pA.id, createdBy: (await db.select().from(driverPortalLinks))[0]!.createdBy, tokenHash: `h-${uid()}-${uid()}` })).rejects.toThrow();
  });

  it("concurrent requests: two drivers racing for one vehicle, or one driver for two vehicles, produce exactly one custody", async () => {
    const { sa, pA, d, t } = await world();
    const d2 = await createDriverUser(pA.id);
    const t2 = await issue(sa, d2.driver.id);
    const shared = await createVehicle(pA.id);
    const race = await Promise.all([take(t, shared.id, d.employee.employeeNumber), take(t2, shared.id, d2.employee.employeeNumber)]);
    expect(race.map((r) => r.status).sort()).toEqual([201, 409]);
    expect((await db.select().from(handoverSessions).where(eq(handoverSessions.vehicleId, shared.id))).length).toBe(1);

    const d3 = await createDriverUser(pA.id);
    const t3 = await issue(sa, d3.driver.id);
    const a = await createVehicle(pA.id);
    const b = await createVehicle(pA.id);
    const two = await Promise.all([take(t3, a.id, d3.employee.employeeNumber), take(t3, b.id, d3.employee.employeeNumber)]);
    expect(two.map((r) => r.status).sort()).toEqual([201, 409]);
    const mine = await db.select().from(handoverSessions).where(and(eq(handoverSessions.driverId, d3.driver.id), inArray(handoverSessions.status, ["PENDING_HANDOVER", "RETURN_PENDING"])));
    expect(mine).toHaveLength(1);
  });

  it("a vehicle in maintenance, or already assigned to a driver by an admin, cannot be taken", async () => {
    const { sa, pA, d, t } = await world();
    const repair = await createVehicle(pA.id, { status: "IN_MAINTENANCE" });
    expect((await take(t, repair.id, d.employee.employeeNumber)).status).toBe(409);
    const other = await createDriverUser(pA.id);
    const assigned = await createVehicle(pA.id);
    expect((await sa.put(`/api/vehicles/${assigned.id}/driver`, { driverId: other.driver.id })).status).toBe(200);
    expect((await take(t, assigned.id, d.employee.employeeNumber)).status).toBe(409);
  });

  it("an expired licence blocks a new pickup", async () => {
    const { pA, d, t } = await world();
    await db.update(drivers).set({ licenseExpiryDate: "2020-01-01" }).where(eq(drivers.id, d.driver.id));
    const v = await createVehicle(pA.id);
    expect((await take(t, v.id, d.employee.employeeNumber)).status).toBe(409);
  });
});

describe("driver portal — pickup and return", () => {
  it("full cycle with no signature: pickup → custody → return → vehicle free again; replays and other drivers' sessions are refused", async () => {
    const { sa, pA, d, t } = await world();
    const v = await createVehicle(pA.id, { currentOdometer: 50 });
    const sid = await pickUp(t, d, v.id, 60);
    const [afterPickup] = await db.select().from(vehicles).where(eq(vehicles.id, v.id));
    expect(afterPickup).toMatchObject({ assignedDriverId: d.driver.id, status: "ASSIGNED", currentOdometer: 60 });
    const [s1] = await db.select().from(handoverSessions).where(eq(handoverSessions.id, sid));
    expect(s1).toMatchObject({ viaPortal: true, status: "RETURN_PENDING", handoverOdometer: 60, linkStatus: "REVOKED" });
    expect(s1!.handoverAt).toBeTruthy(); // date and time kept

    // replay of the same submission, and a signature, are refused
    expect((await submit(t, sid, { odometer: 60, confirm: true, employeeNumber: d.employee.employeeNumber })).status).toBe(400); // return photos are missing now
    expect((await photo(t, sid, "SIGNATURE")).status).toBe(400);
    // another driver cannot touch this session, even with his own valid link
    const intruder = await createDriverUser(pA.id);
    const ti = await issue(sa, intruder.driver.id);
    expect((await photo(ti, sid, "FRONT")).status).toBe(404);
    expect((await submit(ti, sid, { odometer: 99, confirm: true, employeeNumber: intruder.employee.employeeNumber })).status).toBe(404);

    // return: photos, confirmation needs the employee number, then the custody closes
    await photos(t, sid);
    expect((await submit(t, sid, { odometer: 70, confirm: true })).status).toBe(403);
    expect((await submit(t, sid, { odometer: 40, confirm: true, employeeNumber: d.employee.employeeNumber })).status).toBe(400); // below the pickup reading
    const done = await submit(t, sid, { odometer: 70, confirm: true, employeeNumber: d.employee.employeeNumber });
    expect(done.body.data.status).toBe("RETURN_COMPLETED");
    expect((await submit(t, sid, { odometer: 70, confirm: true, employeeNumber: d.employee.employeeNumber })).status).toBe(404); // no double submit
    const [back] = await db.select().from(vehicles).where(eq(vehicles.id, v.id));
    expect(back).toMatchObject({ assignedDriverId: null, status: "AVAILABLE", currentOdometer: 70 });
    const [s2] = await db.select().from(handoverSessions).where(eq(handoverSessions.id, sid));
    expect(s2).toMatchObject({ status: "RETURN_COMPLETED", returnOdometer: 70 });
    expect(s2!.returnAt).toBeTruthy();
    expect(s2!.handoverAt).toEqual(s1!.handoverAt); // history kept

    // the driver is free: another vehicle can be taken now
    const next = await createVehicle(pA.id);
    expect((await take(t, next.id, d.employee.employeeNumber)).status).toBe(201);
    const actions = (await db.select().from(auditLogs).where(eq(auditLogs.entityId, sid))).map((a) => a.action);
    expect(actions).toEqual(expect.arrayContaining(["HANDOVER_CREATED", "HANDOVER_COMPLETED", "HANDOVER_RETURN_COMPLETED"]));
  });

  it("the pickup needs all seven photos, and can be cancelled only before it is confirmed", async () => {
    const { pA, d, t } = await world();
    const v = await createVehicle(pA.id);
    const sid = (await take(t, v.id, d.employee.employeeNumber)).body.data.sessionId as string;
    await photo(t, sid, "FRONT");
    const early = await submit(t, sid, { odometer: 5, confirm: true, employeeNumber: d.employee.employeeNumber });
    expect(early.status).toBe(400);
    expect(early.body.error.details.missing).toEqual(expect.arrayContaining(["REAR", "TIRES"]));
    expect(early.body.error.details.missing).not.toContain("SIGNATURE");
    expect((await request(app).post(`/api/portal/${t}/sessions/${sid}/cancel`).send({})).status).toBe(403); // identity needed
    expect((await request(app).post(`/api/portal/${t}/sessions/${sid}/cancel`).send({ employeeNumber: d.employee.employeeNumber })).status).toBe(200);
    expect((await take(t, v.id, d.employee.employeeNumber)).status).toBe(201); // free again

    const w = await world();
    const v2 = await createVehicle(w.pA.id);
    const sid2 = await pickUp(w.t, w.d, v2.id);
    expect((await request(app).post(`/api/portal/${w.t}/sessions/${sid2}/cancel`).send({ employeeNumber: w.d.employee.employeeNumber })).status).toBe(409); // already in custody
  });

  it("changing the driver's project while he holds a vehicle: the old vehicle stays returnable, no new pickup until it is closed", async () => {
    const { pA, pB, d, t } = await world();
    const old = await createVehicle(pA.id);
    const sid = await pickUp(t, d, old.id);
    await db.update(employees).set({ projectId: pB.id }).where(eq(employees.id, d.employee.id)); // moved to another project
    const newVehicle = await createVehicle(pB.id);
    const view = (await get(t)).body.data;
    expect(view.project.name).toBeTruthy();
    expect(view.custody.sessionId).toBe(sid);
    expect(view.vehicles.find((x: { id: string }) => x.id === old.id).state).toBe("MINE"); // still listed, still his
    expect(view.vehicles.find((x: { id: string }) => x.id === newVehicle.id)).toMatchObject({ state: "AVAILABLE", canTake: false });
    const blocked = await take(t, newVehicle.id, d.employee.employeeNumber);
    expect(blocked.status).toBe(409);
    expect(blocked.body.error.code).toBe("CUSTODY_OPEN");
    // the old vehicle can be returned
    await photos(t, sid);
    expect((await submit(t, sid, { odometer: 200, confirm: true, employeeNumber: d.employee.employeeNumber })).body.data.status).toBe("RETURN_COMPLETED");
    expect((await take(t, newVehicle.id, d.employee.employeeNumber)).status).toBe(201); // and now the new project's vehicle can be taken
    // a project change needs no new link: the same token now shows project B's vehicles
    expect((await get(t)).body.data.vehicles.some((x: { id: string }) => x.id === old.id)).toBe(false);
  });

  it("a revoked link stops everything, but the custody records stay", async () => {
    const { sa, pA, d, t } = await world();
    const v = await createVehicle(pA.id);
    const sid = await pickUp(t, d, v.id);
    expect((await sa.post(`/api/driver-portal/drivers/${d.driver.id}/link/revoke`)).status).toBe(200);
    expect((await photo(t, sid, "FRONT")).status).toBe(404);
    expect((await take(t, v.id, d.employee.employeeNumber)).status).toBe(404);
    expect((await db.select().from(handoverSessions).where(eq(handoverSessions.id, sid))).length).toBe(1);
  });
});

describe("driver portal — administration", () => {
  it("shows each project's vehicles (available / occupied by whom / unavailable) and the drivers' custody; scoped for a project manager", async () => {
    const { sa, pA, d, t } = await world();
    const free = await createVehicle(pA.id);
    const used = await createVehicle(pA.id);
    const repair = await createVehicle(pA.id, { status: "IN_MAINTENANCE" });
    await pickUp(t, d, used.id);
    const r = await sa.get(`/api/driver-portal/projects/${pA.id}/vehicles`);
    expect(r.status).toBe(200);
    const by = (id: string) => r.body.data.find((x: { id: string }) => x.id === id);
    expect(by(free.id).state).toBe("AVAILABLE");
    expect(by(used.id)).toMatchObject({ state: "OCCUPIED", driverName: d.employee.fullName, sessionStatus: "RETURN_PENDING" });
    expect(by(repair.id).state).toBe("UNAVAILABLE");
    expect(r.body.meta).toMatchObject({ available: 1, occupied: 1, unavailable: 1 });
    const drivers = (await sa.get(`/api/driver-portal/drivers?projectId=${pA.id}&pageSize=100`)).body.data as { id: string; link: { status: string }; custody: { plateNumber: string } | null }[];
    const row = drivers.find((x) => x.id === d.driver.id)!;
    expect(row.link.status).toBe("ACTIVE");
    expect(row.custody!.plateNumber).toBe(used.plateNumber);

    const pm = await createUser(["PROJECT_MANAGER"]);
    const other = await createProject({ managerId: pm.id });
    const c = await login(pm.email);
    expect((await c.get(`/api/driver-portal/projects/${pA.id}/vehicles`)).status).toBe(404);
    expect((await c.get(`/api/driver-portal/projects/${other.id}/vehicles`)).status).toBe(200);
  });

  it("exceptional administrative return: reason required, documented, frees the vehicle, nothing deleted", async () => {
    const { sa, pA, d, t } = await world();
    const v = await createVehicle(pA.id);
    const sid = await pickUp(t, d, v.id, 30);
    expect((await sa.post(`/api/handovers/${sid}/force-return`, {})).status).toBe(400); // reason is mandatory
    const ok = await sa.post(`/api/handovers/${sid}/force-return`, { reason: "فقد السائق الرابط", odometer: 45 });
    expect(ok.status).toBe(200);
    expect(ok.body.data.status).toBe("RETURN_COMPLETED");
    const [back] = await db.select().from(vehicles).where(eq(vehicles.id, v.id));
    expect(back).toMatchObject({ assignedDriverId: null, status: "AVAILABLE", currentOdometer: 45 });
    const [s] = await db.select().from(handoverSessions).where(eq(handoverSessions.id, sid));
    expect(s!.returnNotes).toContain("فقد السائق الرابط");
    expect(s!.handoverOdometer).toBe(30); // pickup record untouched
    const log = (await db.select().from(auditLogs).where(eq(auditLogs.entityId, sid))).find((a) => a.action === "HANDOVER_FORCE_RETURNED")!;
    expect(log.metadata).toMatchObject({ reason: "فقد السائق الرابط" });
    expect((await sa.post(`/api/handovers/${sid}/force-return`, { reason: "مرة ثانية" })).status).toBe(409); // not in custody any more
    // the driver is free again
    expect((await take(t, (await createVehicle(pA.id)).id, d.employee.employeeNumber)).status).toBe(201);

    // not for a manager of another project, and not before the pickup is confirmed
    const pm = await createUser(["PROJECT_MANAGER"]);
    await createProject({ managerId: pm.id });
    const c = await login(pm.email);
    const w = await world();
    const v2 = await createVehicle(w.pA.id);
    const sid2 = await pickUp(w.t, w.d, v2.id);
    expect((await c.post(`/api/handovers/${sid2}/force-return`, { reason: "محاولة خارج النطاق" })).status).toBe(404);
    const w2 = await world();
    const sid3 = (await take(w2.t, (await createVehicle(w2.pA.id)).id, w2.d.employee.employeeNumber)).body.data.sessionId as string;
    expect((await sa.post(`/api/handovers/${sid3}/force-return`, { reason: "قبل التسليم" })).status).toBe(409);
  });

  it("old handover records and the admin-created link flow keep working", async () => {
    const { sa, pA } = await world();
    const drv = await createDriverUser(pA.id);
    const v = await createVehicle(pA.id);
    const c = await sa.post("/api/handovers", { vehicleId: v.id, driverId: drv.driver.id });
    expect(c.status).toBe(201);
    const token = c.body.data.token as string;
    for (const cat of REQUIRED) expect((await request(app).put(`/api/public/handover/${token}/photos/${cat}`).set("Content-Type", "image/jpeg").send(JPEG_BYTES)).status).toBe(201);
    const done = await request(app).post(`/api/public/handover/${token}/submit`).send({ odometer: 1, confirm: true });
    expect(done.body.data.status).toBe("RETURN_PENDING"); // no signature needed there either
    const [row] = await db.select({ n: sql<number>`count(*)::int` }).from(handoverSessions).where(eq(handoverSessions.vehicleId, v.id));
    expect(row!.n).toBe(1);
    expect((await db.select().from(handoverSessions).where(eq(handoverSessions.id, c.body.data.id)))[0]!.viaPortal).toBe(false);
  });
});
