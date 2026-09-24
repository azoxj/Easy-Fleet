import { describe, expect, it } from "vitest";
import { assignVehicle, createProject, createUser, createVehicle, login, userAndClient } from "./helpers.js";

describe("dashboard", () => {
  it("returns a role-specific view and never fakes metrics of future modules", async () => {
    const { client } = await userAndClient(["SUPER_ADMIN"]);
    const res = await client.get("/api/dashboard");
    expect(res.status).toBe(200);
    expect(res.body.data.view).toBe("admin");
    expect(res.body.data.vehicles.total).toBeGreaterThanOrEqual(0);
    expect(Object.values(res.body.data.upcoming).every((v) => v === null)).toBe(true);
    expect(Array.isArray(res.body.data.recentActivity)).toBe(true);
  });

  it("PROJECT_MANAGER numbers only cover their projects", async () => {
    const pm = await createUser(["PROJECT_MANAGER"]);
    const p = await createProject({ managerId: pm.id });
    await createVehicle(p.id);
    await createVehicle(p.id, { status: "IN_MAINTENANCE" });
    await createVehicle((await createProject()).id);
    const c = await login(pm.email);
    const res = await c.get("/api/dashboard");
    expect(res.body.data.view).toBe("project_manager");
    expect(res.body.data.vehicles).toMatchObject({ total: 2, active: 1, inMaintenance: 1 });
    expect(res.body.data.projects.total).toBe(1);
    expect(res.body.data.recentActivity).toBeNull();
  });

  it("DRIVER dashboard shows only assigned vehicles", async () => {
    const pm = await createUser(["PROJECT_MANAGER"]);
    const driver = await createUser(["DRIVER"]);
    const p = await createProject({ managerId: pm.id });
    const v = await createVehicle(p.id);
    await createVehicle(p.id);
    await assignVehicle(v, driver.id, pm.id);
    const c = await login(driver.email);
    const res = await c.get("/api/dashboard");
    expect(res.body.data.view).toBe("driver");
    expect(res.body.data.assignedVehicles.map((x: { id: string }) => x.id)).toEqual([v.id]);
    expect(res.body.data.projects).toBeNull();
    expect(res.body.data.myAssignments).toEqual({ PENDING: 1 });
  });

  it("FINANCE gets the finance view", async () => {
    const { client } = await userAndClient(["FINANCE"]);
    expect((await client.get("/api/dashboard")).body.data.view).toBe("finance");
  });
});

describe("global search", () => {
  it("is scoped exactly like the list endpoints", async () => {
    const pm = await createUser(["PROJECT_MANAGER"]);
    const p = await createProject({ managerId: pm.id });
    const mine = await createVehicle(p.id, { plateNumber: `SRCH-MINE-${Date.now()}` });
    const theirs = await createVehicle((await createProject()).id, { plateNumber: `SRCH-THEIRS-${Date.now()}` });
    const c = await login(pm.email);
    const res = await c.get("/api/search?q=SRCH-");
    const ids = res.body.data.vehicles.map((v: { id: string }) => v.id);
    expect(ids).toContain(mine.id);
    expect(ids).not.toContain(theirs.id);
    expect((await c.get("/api/search?q=a")).status).toBe(400);
  });
});
