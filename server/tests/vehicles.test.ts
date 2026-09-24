import { and, eq } from "drizzle-orm";
import { describe, expect, it } from "vitest";
import { db } from "../src/db/client.js";
import { auditLogs, notifications, vehicles } from "../src/db/schema/index.js";
import { assignVehicle, createProject, createUser, createVehicle, linkDriver, login, uid, userAndClient } from "./helpers.js";

describe("vehicles", () => {
  it("SUPER_ADMIN creates a vehicle; audit + PM notification", async () => {
    const { client } = await userAndClient(["SUPER_ADMIN"]);
    const pm = await createUser(["PROJECT_MANAGER"]);
    const p = await createProject({ managerId: pm.id });
    const res = await client.post("/api/vehicles", { plateNumber: `ABC-${uid()}`, make: "تويوتا", model: "هايلكس", year: 2024, projectId: p.id, vin: "jtdkb20u093012345" });
    expect(res.status).toBe(201);
    expect(res.body.data.status).toBe("AVAILABLE");
    expect(res.body.data.vin).toBe("JTDKB20U093012345");
    const logs = await db.select().from(auditLogs).where(and(eq(auditLogs.entity, "vehicle"), eq(auditLogs.entityId, res.body.data.id)));
    expect(logs.map((l) => l.action)).toEqual(["VEHICLE_CREATED"]);
    const notes = await db.select().from(notifications).where(eq(notifications.userId, pm.id));
    expect(notes.map((n) => n.type)).toContain("VEHICLE_ADDED_TO_PROJECT");
  });

  it("validates input and uniqueness", async () => {
    const { client } = await userAndClient(["SUPER_ADMIN"]);
    const plate = `DUP-${uid()}`;
    expect((await client.post("/api/vehicles", { plateNumber: plate, make: "a", model: "b" })).status).toBe(201);
    expect((await client.post("/api/vehicles", { plateNumber: plate, make: "a", model: "b" })).status).toBe(409);
    expect((await client.post("/api/vehicles", { plateNumber: `V-${uid()}`, make: "a", model: "b", vin: "SHORT" })).status).toBe(400);
    expect((await client.post("/api/vehicles", { plateNumber: `V-${uid()}`, make: "a", model: "b", year: 1900 })).status).toBe(400);
    expect((await client.post("/api/vehicles", { plateNumber: `V-${uid()}`, make: "a", model: "b", currentOdometer: -1 })).status).toBe(400);
    // workflow-driven statuses cannot be set by hand
    expect((await client.post("/api/vehicles", { plateNumber: `V-${uid()}`, make: "a", model: "b", status: "IN_MAINTENANCE" })).status).toBe(400);
  });

  it("PROJECT_MANAGER only sees vehicles of own projects; other vehicles are 404", async () => {
    const pm = await createUser(["PROJECT_MANAGER"]);
    const mine = await createProject({ managerId: pm.id });
    const other = await createProject();
    const v1 = await createVehicle(mine.id);
    const v2 = await createVehicle(other.id);
    const pool = await createVehicle(null);
    const c = await login(pm.email);
    const list = await c.get("/api/vehicles?pageSize=100");
    const ids = list.body.data.map((v: { id: string }) => v.id);
    expect(ids).toContain(v1.id);
    expect(ids).not.toContain(v2.id);
    expect(ids).not.toContain(pool.id);
    expect((await c.get(`/api/vehicles/${v2.id}`)).status).toBe(404);
    expect((await c.patch(`/api/vehicles/${v2.id}`, { notes: "x" })).status).toBe(404);
    expect((await c.get(`/api/vehicles/${v2.id}/timeline`)).status).toBe(404);
    // filtering by a foreign projectId must not bypass scope
    const filtered = await c.get(`/api/vehicles?projectId=${other.id}`);
    expect(filtered.body.data).toHaveLength(0);
  });

  it("PROJECT_MANAGER cannot create vehicles or move them to foreign projects", async () => {
    const pm = await createUser(["PROJECT_MANAGER"]);
    const mine = await createProject({ managerId: pm.id });
    const other = await createProject();
    const v = await createVehicle(mine.id);
    const c = await login(pm.email);
    expect((await c.post("/api/vehicles", { plateNumber: `X-${uid()}`, make: "a", model: "b", projectId: mine.id })).status).toBe(403);
    expect((await c.patch(`/api/vehicles/${v.id}`, { projectId: other.id })).status).toBe(403);
    expect((await c.patch(`/api/vehicles/${v.id}`, { projectId: null })).status).toBe(403);
    const [row] = await db.select().from(vehicles).where(eq(vehicles.id, v.id));
    expect(row!.projectId).toBe(mine.id);
  });

  it("PROJECT_MANAGER updates own vehicles; odometer cannot go backwards", async () => {
    const pm = await createUser(["PROJECT_MANAGER"]);
    const p = await createProject({ managerId: pm.id });
    const v = await createVehicle(p.id, { currentOdometer: 1000 });
    const c = await login(pm.email);
    const ok = await c.patch(`/api/vehicles/${v.id}`, { currentOdometer: 1500, status: "OUT_OF_SERVICE" });
    expect(ok.status).toBe(200);
    expect((await c.patch(`/api/vehicles/${v.id}`, { currentOdometer: 900 })).status).toBe(400);
    expect((await c.patch(`/api/vehicles/${v.id}`, { status: "ACCIDENT" })).status).toBe(400);
    expect((await c.patch(`/api/vehicles/${v.id}`, { organizationId: p.id })).status).toBe(400);
    const log = await db.select().from(auditLogs).where(and(eq(auditLogs.entityId, v.id), eq(auditLogs.action, "VEHICLE_UPDATED")));
    expect(log[0]!.metadata).toEqual({ changes: { currentOdometer: { from: 1000, to: 1500 }, status: { from: "AVAILABLE", to: "OUT_OF_SERVICE" } } });
  });

  it("archived vehicles are read-only and hidden by default", async () => {
    const { client } = await userAndClient(["SUPER_ADMIN"]);
    const v = await createVehicle(null);
    const archived = await client.post(`/api/vehicles/${v.id}/archive`, { reason: "بيع" });
    expect(archived.status).toBe(200);
    expect(archived.body.data.status).toBe("ARCHIVED");
    expect((await client.patch(`/api/vehicles/${v.id}`, { notes: "x" })).status).toBe(400);
    expect((await client.post(`/api/vehicles/${v.id}/archive`)).status).toBe(400);
    const list = await client.get("/api/vehicles?pageSize=100");
    expect(list.body.data.map((x: { id: string }) => x.id)).not.toContain(v.id);
    const withArchived = await client.get("/api/vehicles?pageSize=100&includeArchived=true");
    expect(withArchived.body.data.map((x: { id: string }) => x.id)).toContain(v.id);
  });

  it("DRIVER sees only vehicles assigned to them, and only while in the assignment's project", async () => {
    const pm = await createUser(["PROJECT_MANAGER"]);
    const driver = await createUser(["DRIVER"]);
    const p = await createProject({ managerId: pm.id });
    const p2 = await createProject();
    const assigned = await createVehicle(p.id);
    const notAssigned = await createVehicle(p.id);
    await assignVehicle(assigned, driver.id, pm.id);

    const c = await login(driver.email);
    const list = await c.get("/api/vehicles");
    expect(list.body.data.map((v: { id: string }) => v.id)).toEqual([assigned.id]);
    expect((await c.get(`/api/vehicles/${notAssigned.id}`)).status).toBe(404);
    expect((await c.patch(`/api/vehicles/${assigned.id}`, { notes: "x" })).status).toBe(403); // no update permission

    // Moving the vehicle to another project invalidates the stale assignment.
    await db.update(vehicles).set({ projectId: p2.id }).where(eq(vehicles.id, assigned.id));
    expect((await c.get(`/api/vehicles/${assigned.id}`)).status).toBe(404);
  });

  it("DRIVER linked as the vehicle's assigned driver can read it", async () => {
    const driver = await createUser(["DRIVER"]);
    const v = await createVehicle(null);
    const c = await login(driver.email);
    expect((await c.get(`/api/vehicles/${v.id}`)).status).toBe(404);
    await linkDriver(driver.id, v.id);
    expect((await c.get(`/api/vehicles/${v.id}`)).status).toBe(200);
  });

  it("TECHNICAL (ASSIGNED update scope) may only update odometer/notes of assigned vehicles", async () => {
    const tech = await createUser(["TECHNICAL"]);
    const admin = await createUser(["SUPER_ADMIN"]);
    const p = await createProject({ members: [tech.id] });
    const v = await createVehicle(p.id, { currentOdometer: 10 });
    const other = await createVehicle(p.id);
    await assignVehicle(v, tech.id, admin.id);
    const c = await login(tech.email);
    expect((await c.get(`/api/vehicles/${other.id}`)).status).toBe(200); // project read scope
    expect((await c.patch(`/api/vehicles/${other.id}`, { notes: "x" })).status).toBe(404); // not in update scope
    expect((await c.patch(`/api/vehicles/${v.id}`, { currentOdometer: 20, notes: "تم الفحص" })).status).toBe(200);
    expect((await c.patch(`/api/vehicles/${v.id}`, { make: "تغيير" })).status).toBe(403);
    const detail = await c.get(`/api/vehicles/${v.id}`);
    expect(detail.body.data.capabilities).toEqual({ update: true, archive: false });
  });

  it("FINANCE can read all vehicles but not modify them", async () => {
    const { client } = await userAndClient(["FINANCE"]);
    const v = await createVehicle((await createProject()).id);
    expect((await client.get(`/api/vehicles/${v.id}`)).status).toBe(200);
    expect((await client.patch(`/api/vehicles/${v.id}`, { notes: "x" })).status).toBe(403);
    expect((await client.post(`/api/vehicles/${v.id}/archive`)).status).toBe(403);
  });

  it("timeline returns the vehicle's audit history", async () => {
    const { client } = await userAndClient(["SUPER_ADMIN"]);
    const created = await client.post("/api/vehicles", { plateNumber: `TL-${uid()}`, make: "a", model: "b" });
    await client.patch(`/api/vehicles/${created.body.data.id}`, { color: "أبيض" });
    const tl = await client.get(`/api/vehicles/${created.body.data.id}/timeline`);
    expect(tl.body.data.map((e: { action: string }) => e.action)).toEqual(["VEHICLE_UPDATED", "VEHICLE_CREATED"]);
  });
});
