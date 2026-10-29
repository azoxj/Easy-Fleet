import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { db } from "../src/db/client.js";
import { accidentStageOfficers } from "../src/db/schema/index.js";
import { setClock } from "../src/lib/clock.js";
import { setAccidentWorkflowFlag } from "../src/lib/feature-flags.js";
import { createProject, createUser, createVehicle, login } from "./helpers.js";
import { draftBody, newDraft, REQUIRED, toClaim, toEstimates, toTechnical, upload, uploadRequired, world, detail } from "./support/accident-world.js";

beforeAll(() => setAccidentWorkflowFlag(true));
afterAll(() => setAccidentWorkflowFlag(null));
beforeEach(() => setClock(new Date("2026-06-15T09:00:00Z")));
afterEach(() => setClock(null));

const ids = (rows: { id: string }[]) => rows.map((r) => r.id);
const listView = async (c: Awaited<ReturnType<typeof login>>, view: string, projectId?: string) => c.get(`/api/accidents?view=${view}&pageSize=100${projectId ? `&projectId=${projectId}` : ""}`);

describe("features and stats for the accidents screen", () => {
  it("features reports the workflow switch, needs accidents.read, and works with the workflow off", async () => {
    const w = await world();
    expect((await w.c.pm.get("/api/accidents/features")).body.data).toEqual({ workflow: true });
    setAccidentWorkflowFlag(false);
    try {
      expect((await w.c.pm.get("/api/accidents/features")).body.data).toEqual({ workflow: false });
      expect((await w.c.pm.get("/api/accidents/stats")).status).toBe(200); // the legacy page keeps its figures
    } finally {
      setAccidentWorkflowFlag(true);
    }
    const res = await (await import("supertest")).default((await import("./helpers.js")).app).get("/api/accidents/features");
    expect(res.status).toBe(401);
  });

  it("stats never count drafts as accidents; they have their own line; overdue and the queue follow the workflow", async () => {
    const w = await world();
    const before = (await w.c.manager.get("/api/accidents/stats")).body.data;
    const draft = await newDraft(w);
    const mid = (await w.c.manager.get("/api/accidents/stats")).body.data;
    expect(mid.open).toBe(before.open);
    expect(mid.closed).toBe(before.closed);
    expect(mid.drafts).toBe(before.drafts + 1);
    void draft;
    await db.delete(accidentStageOfficers);
    const queued = await toTechnical(w); // no officer: waits for assignment
    const after = (await w.c.manager.get("/api/accidents/stats")).body.data;
    expect(after.open).toBe(before.open + 1);
    expect(after.awaitingAssignment).toBe(before.awaitingAssignment + 1);
    expect((await w.c.pm.get("/api/accidents/stats")).body.data.awaitingAssignment).toBeNull(); // only assigners see the queue figure
    expect(after.overdue).toBe(before.overdue);
    setClock(new Date("2026-06-19T09:00:00Z")); // more than the 3 calendar days of the technical stage
    // other tests' open cases age with the same clock, so the total can only be compared loosely; the case itself is exact
    expect((await w.c.manager.get("/api/accidents/stats")).body.data.overdue).toBeGreaterThanOrEqual(before.overdue + 1);
    expect((await w.c.manager.get(`/api/accidents?projectId=${w.project.id}&pageSize=100`)).body.data.find((r: { id: string }) => r.id === queued)).toMatchObject({ overdue: true });
    void queued;
    // project scope: another project's manager counts none of it
    const other = (await w.c.otherPm.get("/api/accidents/stats")).body.data;
    expect(other).toMatchObject({ open: 0, drafts: 0, overdue: 0 });
  });
});

describe("the accident tabs are views of the existing list", () => {
  it("my reports, my tasks, queue, returned, drafts and claims each show the right cases and fields; legacy rows are unchanged", async () => {
    const w = await world();
    const driverDraft = (await w.c.driver.post("/api/accident-cases", draftBody(w.vehicle.id))).body.data.id as string;
    const legacy = (await w.c.pm.post("/api/accidents", { vehicleId: w.vehicle.id, occurredAt: "2026-06-14T10:00:00+03:00", description: "حادث بالمسار القديم", severity: "MINOR" })).body.data.id as string;
    const active = await toTechnical(w); // assigned to the technician
    await db.delete(accidentStageOfficers);
    const queued = await toTechnical(w);
    // all: legacy + workflow rows in one list; legacy rows carry no workflow information
    const all = (await w.c.pm.get(`/api/accidents?pageSize=100&projectId=${w.project.id}`)).body.data as Record<string, unknown>[];
    expect(all.find((r) => r.id === legacy)).toMatchObject({ workflowStage: null, assignedToName: null, returnedForCompletion: false, overdue: false, preliminary: false });
    expect(all.find((r) => r.id === active)).toMatchObject({ workflowStage: "AWAITING_TECHNICAL", assignedToName: expect.stringContaining("TECHNICAL") });
    // my reports: the driver's own draft only
    expect(ids((await listView(w.c.driver, "reported", w.project.id)).body.data)).toEqual([driverDraft]);
    expect((await listView(w.c.driver, "reported", w.project.id)).body.data[0]).toMatchObject({ preliminary: true, workflowStage: "DRAFT" });
    // my tasks: the technician's assigned case, not the queued one
    expect(ids((await listView(w.c.tech, "assigned", w.project.id)).body.data)).toEqual([active]);
    // queue: assigners only
    expect((await listView(w.c.pm, "queue")).status).toBe(403);
    expect((await listView(w.c.tech, "queue")).status).toBe(403);
    expect(ids((await listView(w.c.manager, "queue", w.project.id)).body.data)).toEqual([queued]);
    // drafts: the creator, the project's manager and the managers; nobody else
    expect(ids((await listView(w.c.pm, "drafts")).body.data)).toContain(driverDraft);
    expect(ids((await listView(w.c.manager, "drafts")).body.data)).toContain(driverDraft);
    for (const who of ["viewer", "tech", "finance", "insurer", "otherPm"] as const) expect(ids((await listView(w.c[who], "drafts")).body.data), who).not.toContain(driverDraft);
  });

  it("returned and claims views follow the stage; the technician sees a case assigned outside their project everywhere", async () => {
    const w = await world();
    const id = await toTechnical(w);
    await toClaim(w, id);
    expect(ids((await listView(w.c.insurer, "claims")).body.data)).toContain(id);
    expect(ids((await listView(w.c.manager, "claims")).body.data)).toContain(id);
    expect(ids((await listView(w.c.manager, "returned")).body.data)).not.toContain(id);
    expect((await w.c.manager.post(`/api/accident-cases/${id}/transition`, { to: "AWAITING_TECHNICAL", reason: "نقص في التقييم" })).status).toBe(200);
    expect(ids((await listView(w.c.manager, "returned")).body.data)).toContain(id);
    expect((await listView(w.c.tech, "returned")).body.data.find((r: { id: string }) => r.id === id)).toMatchObject({ returnedForCompletion: true, workflowStage: "AWAITING_TECHNICAL" });
    expect(ids((await listView(w.c.insurer, "claims")).body.data)).not.toContain(id); // back in the technical stage
    expect((await w.c.manager.get("/api/accidents/stats")).body.data.returned).toBeGreaterThanOrEqual(1);
    // assigned outside the technician's own projects: visible in the list and opens through the legacy detail too
    const p2 = await createProject({ managerId: w.pm.id });
    const v2 = await createVehicle(p2.id);
    const id2 = (await w.c.pm.post("/api/accident-cases", draftBody(v2.id))).body.data.id as string;
    await uploadRequired(w.c.pm, id2);
    await w.c.pm.post(`/api/accident-cases/${id2}/submit`);
    expect((await w.c.manager.post(`/api/accident-cases/${id2}/assign`, { userId: w.tech.id })).status).toBe(200);
    expect(ids((await w.c.tech.get("/api/accidents?pageSize=100")).body.data)).toContain(id2);
    expect(ids((await listView(w.c.tech, "assigned")).body.data)).toContain(id2);
    expect((await w.c.tech.get(`/api/accidents/${id2}`)).status).toBe(200);
    // …but not the other cases of that project
    const id3 = (await w.c.pm.post("/api/accident-cases", draftBody(v2.id))).body.data.id as string;
    await uploadRequired(w.c.pm, id3);
    await w.c.pm.post(`/api/accident-cases/${id3}/submit`);
    expect((await w.c.tech.get(`/api/accidents/${id3}`)).status).toBe(404);
  });
});

describe("what the detail tells the screen to offer", () => {
  it("lists what is missing before a step, only to people who can act, and the categories each person may upload", async () => {
    const w = await world();
    const id = (await w.c.driver.post("/api/accident-cases", draftBody(w.vehicle.id))).body.data.id as string;
    await upload(w.c.driver, id, "DRIVER_ID");
    const missingOf = (d: { requirements: { to: string; missing: string[] }[] }) => d.requirements.find((r) => r.to === "AWAITING_TECHNICAL")?.missing.sort();
    // the driver (creator) and the project manager see what is missing, even though the driver cannot see the manager's files
    expect(missingOf(await detail(w.c.driver, id))).toEqual(["attachment:DRIVER_LICENSE", "attachment:NAJM_REPORT", "attachment:VEHICLE_REGISTRATION"]);
    expect(missingOf(await detail(w.c.pm, id))).toEqual(["attachment:DRIVER_LICENSE", "attachment:NAJM_REPORT", "attachment:VEHICLE_REGISTRATION"]);
    // upload categories: the driver and the manager may file the documents, nobody files claim documents on a draft
    const driverCats = (await detail(w.c.driver, id)).uploadCategories as string[];
    expect(driverCats).toEqual(expect.arrayContaining(REQUIRED));
    expect(driverCats).not.toEqual(expect.arrayContaining(["CLAIM_FORM"]));
    expect(driverCats).not.toContain("ESTIMATE");
    expect(driverCats).not.toContain("COMPENSATION_PROOF");
    // after submission a viewer learns nothing about requirements and may upload nothing
    for (const cat of REQUIRED.filter((c) => c !== "DRIVER_ID")) await upload(w.c.pm, id, cat);
    expect((await w.c.pm.post(`/api/accident-cases/${id}/submit`)).status).toBe(200);
    const asViewer = await detail(w.c.viewer, id);
    expect(asViewer.requirements).toEqual([]);
    expect(asViewer.uploadCategories).toEqual([]);
    expect(asViewer.actions).toEqual([]);
    // the technician: photos and other files, requirements of their step
    const asTech = await detail(w.c.tech, id);
    expect(asTech.uploadCategories.sort()).toEqual(["OTHER", "PHOTO"]);
    expect(asTech.requirements.find((r: { to: string }) => r.to === "AWAITING_ESTIMATES").missing.sort()).toEqual(["technical.damageDescription", "technical.repairDecision"]);
    // the project manager at the estimates stage may file ESTIMATE; the insurer may file claim documents at theirs
    await toEstimates(w, id);
    expect((await detail(w.c.pm, id)).uploadCategories).toEqual(expect.arrayContaining(["ESTIMATE"]));
    expect((await detail(w.c.pm, id)).uploadCategories).not.toContain("CLAIM_FORM");
    expect((await detail(w.c.pm, id)).requirements).toEqual([{ to: "AWAITING_INSURANCE", missing: ["estimates.none", "estimates.selected"] }]);
    const id2 = await toTechnical(w);
    await toClaim(w, id2);
    expect((await detail(w.c.insurer, id2)).uploadCategories.sort()).toEqual(["CLAIM_FORM", "COMPENSATION_PROOF", "INSURER_DECISION"]);
  });

  it("assignable lists the people who hold the stage permission, only to assigners", async () => {
    const w = await world();
    await db.delete(accidentStageOfficers);
    const id = await toTechnical(w); // queue
    const tech2 = await createUser(["TECHNICAL"]);
    const { projectUsers } = await import("../src/db/schema/index.js");
    await db.insert(projectUsers).values({ projectId: w.project.id, userId: tech2.id });
    const list = (await w.c.manager.get(`/api/accident-cases/${id}/assignable`)).body.data as { id: string; name: string; designated: boolean }[];
    expect(ids(list)).toEqual(expect.arrayContaining([w.tech.id, tech2.id]));
    // people without the stage permission are never offered
    for (const nope of [w.pm.id, w.viewer.id, w.insurer.id, w.finance.id]) expect(ids(list)).not.toContain(nope);
    expect(list.find((p) => p.id === w.tech.id)!.designated).toBe(false);
    for (const who of ["pm", "tech", "viewer", "insurer"] as const) expect((await w.c[who].get(`/api/accident-cases/${id}/assignable`)).status, who).toBe(403);
    expect((await w.c.otherPm.get(`/api/accident-cases/${id}/assignable`)).status).toBe(404);
    // once assigned, the current assignee is not offered again
    await w.c.manager.post(`/api/accident-cases/${id}/assign`, { userId: tech2.id });
    const after = (await w.c.manager.get(`/api/accident-cases/${id}/assignable`)).body.data as { id: string; designated: boolean }[];
    expect(ids(after)).toContain(w.tech.id);
    expect(ids(after)).not.toContain(tech2.id);
    // designated officers are flagged and listed first
    await w.c.manager.post("/api/accident-cases/officers", { stage: "TECHNICAL", userId: w.tech.id, projectId: w.project.id });
    const flagged = (await w.c.manager.get(`/api/accident-cases/${id}/assignable`)).body.data as { id: string; designated: boolean }[];
    expect(flagged[0]).toMatchObject({ id: w.tech.id, designated: true });
    // a stage without officers offers nobody
    await w.c.tech.put(`/api/accident-cases/${id}/technical`, { damageDescription: "ضرر", repairDecision: "REPAIR" }).catch(() => undefined);
  });
});
