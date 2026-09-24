import { eq } from "drizzle-orm";
import { describe, expect, it } from "vitest";
import { db } from "../src/db/client.js";
import { notifications } from "../src/db/schema/index.js";
import { createProject, createUser, createVehicle, login } from "./helpers.js";

describe("assignments", () => {
  async function setup() {
    const pm = await createUser(["PROJECT_MANAGER"]);
    const member = await createUser(["USER"]);
    const outsider = await createUser(["USER"]);
    const driver = await createUser(["DRIVER"]);
    const p = await createProject({ managerId: pm.id, members: [member.id] });
    const foreign = await createProject();
    return { pm, member, outsider, driver, p, foreign, pmc: await login(pm.email) };
  }

  it("PM assigns a TASK to a project member; assignee is notified and sees it in /mine", async () => {
    const { pmc, member, p } = await setup();
    const res = await pmc.post("/api/assignments", { type: "TASK", assignedTo: member.id, projectId: p.id, title: "متابعة صيانة", priority: "HIGH", dueDate: "2026-12-01" });
    expect(res.status).toBe(201);
    expect(res.body.data.status).toBe("PENDING");
    const notes = await db.select().from(notifications).where(eq(notifications.userId, member.id));
    expect(notes.map((n) => n.type)).toContain("ASSIGNMENT_CREATED");

    const mc = await login(member.email);
    const mine = await mc.get("/api/assignments/mine");
    expect(mine.body.data.map((a: { id: string }) => a.id)).toContain(res.body.data.id);
    expect(mine.body.summary.PENDING).toBe(1);
  });

  it("rejects assignees outside the project and projects outside scope", async () => {
    const { pmc, outsider, member, foreign, p } = await setup();
    expect((await pmc.post("/api/assignments", { type: "TASK", assignedTo: outsider.id, projectId: p.id, title: "مهمة" })).status).toBe(400);
    expect((await pmc.post("/api/assignments", { type: "TASK", assignedTo: member.id, projectId: foreign.id, title: "مهمة" })).status).toBe(403);
    expect((await pmc.post("/api/assignments", { type: "PROJECT", assignedTo: outsider.id, referenceId: p.id, title: "مشروع" })).status).toBe(400);
  });

  it("VEHICLE assignment derives project from the vehicle, never from the client", async () => {
    const { pmc, driver, p, foreign } = await setup();
    const v = await createVehicle(p.id);
    const res = await pmc.post("/api/assignments", { type: "VEHICLE", assignedTo: driver.id, referenceId: v.id, projectId: foreign.id, title: "تسليم" });
    expect(res.status).toBe(400); // conflicting client projectId is rejected
    const ok = await pmc.post("/api/assignments", { type: "VEHICLE", assignedTo: driver.id, referenceId: v.id, title: "تسليم" });
    expect(ok.status).toBe(201);
    expect(ok.body.data.projectId).toBe(p.id);
  });

  it("VEHICLE assignment gives the driver read access to that vehicle only", async () => {
    const { pmc, driver, p } = await setup();
    const v = await createVehicle(p.id);
    const res = await pmc.post("/api/assignments", { type: "VEHICLE", assignedTo: driver.id, referenceId: v.id, title: "استلام مركبة" });
    expect(res.status).toBe(201);
    expect(res.body.data.projectId).toBe(p.id);
    const dc = await login(driver.email);
    expect((await dc.get(`/api/vehicles/${v.id}`)).status).toBe(200);
    // Driver still has no general project access.
    expect((await dc.get(`/api/projects/${p.id}`)).status).toBe(403);
    // After cancellation the access disappears.
    expect((await pmc.patch(`/api/assignments/${res.body.data.id}/status`, { status: "CANCELLED" })).status).toBe(200);
    expect((await dc.get(`/api/vehicles/${v.id}`)).status).toBe(404);
  });

  it("PM cannot assign vehicles of foreign projects (404, no existence leak)", async () => {
    const { pmc, driver, foreign } = await setup();
    const v = await createVehicle(foreign.id);
    expect((await pmc.post("/api/assignments", { type: "VEHICLE", assignedTo: driver.id, referenceId: v.id, title: "تسليم" })).status).toBe(404);
  });

  it("types without a module yet are rejected", async () => {
    const { pmc, member, p } = await setup();
    expect((await pmc.post("/api/assignments", { type: "INVOICE", assignedTo: member.id, projectId: p.id, title: "فاتورة" })).status).toBe(400);
  });

  it("users without assignments.create cannot assign", async () => {
    const { member, p } = await setup();
    const mc = await login(member.email);
    expect((await mc.post("/api/assignments", { type: "TASK", assignedTo: member.id, projectId: p.id, title: "مهمة" })).status).toBe(403);
  });

  it("status workflow: only the assignee progresses; completion notifies the assigner", async () => {
    const { pm, pmc, member, outsider, p } = await setup();
    const a = (await pmc.post("/api/assignments", { type: "TASK", assignedTo: member.id, projectId: p.id, title: "مهمة" })).body.data;
    const mc = await login(member.email);
    const oc = await login(outsider.email);

    expect((await oc.patch(`/api/assignments/${a.id}/status`, { status: "COMPLETED" })).status).toBe(404);
    expect((await pmc.patch(`/api/assignments/${a.id}/status`, { status: "COMPLETED" })).status).toBe(403);
    expect((await mc.patch(`/api/assignments/${a.id}/status`, { status: "CANCELLED" })).status).toBe(403);
    expect((await mc.patch(`/api/assignments/${a.id}/status`, { status: "IN_PROGRESS" })).status).toBe(200);
    expect((await mc.patch(`/api/assignments/${a.id}/status`, { status: "PENDING" })).status).toBe(400);
    const done = await mc.patch(`/api/assignments/${a.id}/status`, { status: "COMPLETED" });
    expect(done.status).toBe(200);
    expect(done.body.data.completedAt).toBeTruthy();
    expect((await mc.patch(`/api/assignments/${a.id}/status`, { status: "IN_PROGRESS" })).status).toBe(400);

    const notes = await db.select().from(notifications).where(eq(notifications.userId, pm.id));
    expect(notes.map((n) => n.type)).toContain("ASSIGNMENT_COMPLETED");
  });

  it("assignment lists are scoped: outsiders never see others' assignments", async () => {
    const { pmc, member, outsider, p } = await setup();
    const a = (await pmc.post("/api/assignments", { type: "TASK", assignedTo: member.id, projectId: p.id, title: "مهمة" })).body.data;
    const oc = await login(outsider.email);
    const all = await oc.get("/api/assignments?pageSize=100");
    expect(all.body.data.map((x: { id: string }) => x.id)).not.toContain(a.id);
    const mine = await oc.get("/api/assignments/mine");
    expect(mine.body.data).toHaveLength(0);
    const pmList = await pmc.get(`/api/assignments?projectId=${p.id}`);
    expect(pmList.body.data.map((x: { id: string }) => x.id)).toContain(a.id);
  });
});
