import { and, eq } from "drizzle-orm";
import { describe, expect, it } from "vitest";
import { db } from "../src/db/client.js";
import { auditLogs, notifications } from "../src/db/schema/index.js";
import { createProject, createUser, createVehicle, login, uid, userAndClient } from "./helpers.js";

describe("projects", () => {
  it("SUPER_ADMIN creates a project; manager becomes member and is notified", async () => {
    const { client } = await userAndClient(["SUPER_ADMIN"]);
    const pm = await createUser(["PROJECT_MANAGER"]);
    const code = `hosp-${uid()}`;
    const res = await client.post("/api/projects", { name: "المستشفى العسكري", code, managerId: pm.id, budget: "150000.50", startDate: "2026-01-01" });
    expect(res.status).toBe(201);
    expect(res.body.data.code).toBe(code.toUpperCase());
    expect(res.body.data.budget).toBe("150000.50");

    const pmc = await login(pm.email);
    const list = await pmc.get("/api/projects");
    expect(list.body.data.map((p: { id: string }) => p.id)).toContain(res.body.data.id);
    const notes = await db.select().from(notifications).where(eq(notifications.userId, pm.id));
    expect(notes.some((n) => n.type === "PROJECT_MANAGER_ASSIGNED")).toBe(true);
    const logs = await db.select().from(auditLogs).where(and(eq(auditLogs.entity, "project"), eq(auditLogs.entityId, res.body.data.id)));
    expect(logs[0]!.action).toBe("PROJECT_CREATED");
  });

  it("rejects duplicate codes, bad dates and negative budgets", async () => {
    const { client } = await userAndClient(["SUPER_ADMIN"]);
    const code = `DUP-${uid()}`;
    expect((await client.post("/api/projects", { name: "أ", code })).status).toBe(400); // name too short
    expect((await client.post("/api/projects", { name: "مشروع", code })).status).toBe(201);
    expect((await client.post("/api/projects", { name: "مشروع", code })).status).toBe(409);
    expect((await client.post("/api/projects", { name: "مشروع", code: `D2-${uid()}`, startDate: "2026-05-01", endDate: "2026-01-01" })).status).toBe(400);
    expect((await client.post("/api/projects", { name: "مشروع", code: `D3-${uid()}`, budget: "-5" })).status).toBe(400);
  });

  it("only SUPER_ADMIN can create projects", async () => {
    const { client } = await userAndClient(["PROJECT_MANAGER"]);
    expect((await client.post("/api/projects", { name: "مشروع", code: `X-${uid()}` })).status).toBe(403);
  });

  it("PROJECT_MANAGER sees only assigned projects; others are 404 (no IDOR)", async () => {
    const pm = await createUser(["PROJECT_MANAGER"]);
    const mine = await createProject({ managerId: pm.id });
    const other = await createProject();
    const c = await login(pm.email);
    const list = await c.get("/api/projects?pageSize=100");
    const ids = list.body.data.map((p: { id: string }) => p.id);
    expect(ids).toEqual([mine.id]);
    expect((await c.get(`/api/projects/${mine.id}`)).status).toBe(200);
    expect((await c.get(`/api/projects/${other.id}`)).status).toBe(404);
    expect((await c.get(`/api/projects/${other.id}/members`)).status).toBe(404);
    expect((await c.patch(`/api/projects/${other.id}`, { name: "اختراق" })).status).toBe(404);
  });

  it("PROJECT_MANAGER may edit basic fields of own project but not budget/code/manager", async () => {
    const pm = await createUser(["PROJECT_MANAGER"]);
    const p = await createProject({ managerId: pm.id });
    const c = await login(pm.email);
    expect((await c.patch(`/api/projects/${p.id}`, { description: "وصف محدث" })).status).toBe(200);
    expect((await c.patch(`/api/projects/${p.id}`, { budget: "999999" })).status).toBe(403);
    expect((await c.patch(`/api/projects/${p.id}`, { managerId: pm.id })).status).toBe(403);
    const detail = await c.get(`/api/projects/${p.id}`);
    expect(detail.body.data.capabilities).toEqual({ update: true, updateSensitive: false, manageMembers: false });
  });

  it("VIEWER in a project can read it but not modify it", async () => {
    const v = await createUser(["VIEWER"]);
    const p = await createProject({ members: [v.id] });
    const c = await login(v.email);
    expect((await c.get(`/api/projects/${p.id}`)).status).toBe(200);
    expect((await c.patch(`/api/projects/${p.id}`, { description: "x" })).status).toBe(403);
  });

  it("DRIVER cannot list projects at all", async () => {
    const { client } = await userAndClient(["DRIVER"]);
    expect((await client.get("/api/projects")).status).toBe(403);
  });

  it("member management: add notifies, duplicates rejected, manager cannot be removed", async () => {
    const { client } = await userAndClient(["SUPER_ADMIN"]);
    const pm = await createUser(["PROJECT_MANAGER"]);
    const u = await createUser(["USER"]);
    const p = await createProject({ managerId: pm.id });

    expect((await client.post(`/api/projects/${p.id}/members`, { userId: u.id })).status).toBe(201);
    expect((await client.post(`/api/projects/${p.id}/members`, { userId: u.id })).status).toBe(400);
    const notes = await db.select().from(notifications).where(eq(notifications.userId, u.id));
    expect(notes.map((n) => n.type)).toContain("PROJECT_MEMBER_ADDED");

    const members = await client.get(`/api/projects/${p.id}/members`);
    expect(members.body.data.find((m: { id: string }) => m.id === pm.id).isManager).toBe(true);

    expect((await client.delete(`/api/projects/${p.id}/members/${pm.id}`)).status).toBe(400);
    expect((await client.delete(`/api/projects/${p.id}/members/${u.id}`)).status).toBe(204);
    expect((await client.delete(`/api/projects/${p.id}/members/${u.id}`)).status).toBe(404);
  });

  it("PROJECT_MANAGER cannot manage members (even in own project)", async () => {
    const pm = await createUser(["PROJECT_MANAGER"]);
    const u = await createUser(["USER"]);
    const p = await createProject({ managerId: pm.id });
    const c = await login(pm.email);
    expect((await c.post(`/api/projects/${p.id}/members`, { userId: u.id })).status).toBe(403);
  });

  it("project detail shows scoped vehicle counts", async () => {
    const { client } = await userAndClient(["SUPER_ADMIN"]);
    const p = await createProject();
    await createVehicle(p.id);
    await createVehicle(p.id, { status: "OUT_OF_SERVICE" });
    const res = await client.get(`/api/projects/${p.id}`);
    expect(res.body.data.vehicleCount).toBe(2);
    expect(res.body.data.vehicleStats).toEqual({ AVAILABLE: 1, OUT_OF_SERVICE: 1 });
  });
});
