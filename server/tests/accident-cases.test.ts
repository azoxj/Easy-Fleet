import { eq, sql } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { db } from "../src/db/client.js";
import { accidentAssignments, accidentEstimates, accidentStageOfficers, accidentTransitions, accidents, notifications, users, vehicles } from "../src/db/schema/index.js";
import { setClock } from "../src/lib/clock.js";
import { setAccidentWorkflowFlag, setLegacySensitiveEnforcementFlag } from "../src/lib/feature-flags.js";
import { createDriverUser, createProject, createUser, createVehicle, login, PDF_BYTES, type Client } from "./helpers.js";
import { addEstimate, caseOf, claimBody, detail, documentRepair, draftBody, newDraft, REQUIRED, toClaim, toEstimates, toFinalClosure, toInsurance, toTechnical, upload, uploadRequired, vehicleOf, world, type W } from "./support/accident-world.js";

beforeAll(() => setAccidentWorkflowFlag(true));
afterAll(() => {
  setAccidentWorkflowFlag(null);
  setLegacySensitiveEnforcementFlag(null);
});
beforeEach(() => setClock(new Date("2026-06-15T09:00:00Z")));
afterEach(() => setClock(null));

describe("feature flag", () => {
  it("is off by default: every workflow route answers 404 and the legacy accident routes are unaffected", async () => {
    const w = await world(); // built with the flag on: designating officers is itself a workflow route
    setAccidentWorkflowFlag(null); // back to the configuration, which defaults to off
    try {
      for (const [m, url] of [["get", "/api/accident-cases"], ["post", "/api/accident-cases"], ["get", "/api/accident-cases/officers"], ["post", "/api/accident-cases/officers"], ["get", `/api/accident-cases/${w.vehicle.id}`], ["post", `/api/accident-cases/${w.vehicle.id}/submit`]] as const) {
        for (const who of ["sa", "pm", "manager"] as const) {
          const r = await (m === "get" ? w.c[who].get(url) : w.c[who].post(url, draftBody(w.vehicle.id)));
          expect(r.status, `${who} ${m} ${url}`).toBe(404);
        }
      }
      // the legacy path is unchanged
      const legacy = await w.c.pm.post("/api/accidents", { vehicleId: w.vehicle.id, occurredAt: "2026-06-14T18:00:00+03:00", description: "حادث بالمسار القديم", severity: "MINOR" });
      expect(legacy.status).toBe(201);
      expect((await caseOf(legacy.body.data.id)).workflowStage).toBeNull();
    } finally {
      setAccidentWorkflowFlag(true);
    }
  });

  it("the configuration default is false and an unknown override does not leak into other tests", async () => {
    const { config } = await import("../src/config.js");
    expect(config.ACCIDENT_WORKFLOW_ENABLED).toBe(false);
  });
});

describe("drafts", () => {
  it("a project manager creates, edits and lists a draft; the vehicle is NOT touched and nobody else sees it", async () => {
    const w = await world();
    const before = await vehicleOf(w.vehicle.id);
    const r = await w.c.pm.post("/api/accident-cases", draftBody(w.vehicle.id));
    expect(r.status).toBe(201);
    expect(r.body.data).toMatchObject({ workflowStage: "DRAFT", status: "OPEN", createdBy: w.pm.id, reportedBy: null });
    const id = r.body.data.id as string;
    expect(await vehicleOf(w.vehicle.id)).toMatchObject({ status: before.status, updatedAt: before.updatedAt });
    expect((await caseOf(id)).vehicleStatusBefore).toBeNull();
    expect((await w.c.pm.patch(`/api/accident-cases/${id}`, { description: "وصف معدّل للحادث", severity: "SEVERE" })).status).toBe(200);
    expect((await w.c.pm.get("/api/accident-cases?stage=DRAFT")).body.data.map((x: { id: string }) => x.id)).toContain(id);
    // private to the creator, the project's handlers and the managers
    for (const who of ["viewer", "tech", "finance", "insurer", "otherPm", "driver"] as const) {
      expect((await w.c[who].get(`/api/accident-cases/${id}`)).status, who).toBe(404);
      expect((await w.c[who].get("/api/accident-cases")).body.data.map((x: { id: string }) => x.id), who).not.toContain(id);
      expect((await w.c[who].get(`/api/accidents/${id}`)).status, `legacy ${who}`).toBe(404);
      expect((await w.c[who].get("/api/accidents")).body.data.map((x: { id: string }) => x.id), `legacy list ${who}`).not.toContain(id);
    }
    for (const who of ["manager", "sa"] as const) expect((await w.c[who].get(`/api/accident-cases/${id}`)).status, who).toBe(200);
    // a draft is not an open accident
    expect((await w.c.pm.get(`/api/accidents?open=true&projectId=${w.project.id}`)).body.data.map((x: { id: string }) => x.id)).not.toContain(id);
    const t = await db.select().from(accidentTransitions).where(eq(accidentTransitions.accidentId, id));
    expect(t.map((x) => [x.fromStage, x.toStage])).toEqual([[null, "DRAFT"]]);
  });

  it("a driver files a preliminary report on their own vehicle; the project manager completes and submits it", async () => {
    const w = await world();
    const r = await w.c.driver.post("/api/accident-cases", draftBody(w.vehicle.id));
    expect(r.status, JSON.stringify(r.body)).toBe(201);
    const id = r.body.data.id as string;
    expect(r.body.data).toMatchObject({ workflowStage: "DRAFT", reportedBy: w.drv.user.id, driverId: w.drv.driver.id });
    expect((await vehicleOf(w.vehicle.id)).status).toBe("ASSIGNED");
    // the driver completes what they know …
    expect((await w.c.driver.patch(`/api/accident-cases/${id}`, { location: "طريق الملك فهد" })).status).toBe(200);
    expect((await upload(w.c.driver, id, "DRIVER_ID")).status).toBe(201);
    // … cannot submit, and cannot file for a vehicle that is not theirs
    expect((await w.c.driver.post(`/api/accident-cases/${id}/submit`)).status).toBe(403);
    const other = await createVehicle(w.project.id);
    expect((await w.c.driver.post("/api/accident-cases", draftBody(other.id))).status).toBe(404);
    // the project manager sees the draft, completes the documents and submits
    expect((await detail(w.c.pm, id)).id).toBe(id);
    expect((await w.c.pm.patch(`/api/accident-cases/${id}`, { policeReportNumber: "PR-77" })).status).toBe(200);
    const early = await w.c.pm.post(`/api/accident-cases/${id}/submit`);
    expect(early.status).toBe(409);
    expect(early.body.error.code).toBe("REQUIREMENTS_NOT_MET");
    expect(early.body.error.details.missing.sort()).toEqual(["attachment:DRIVER_LICENSE", "attachment:NAJM_REPORT", "attachment:VEHICLE_REGISTRATION"]);
    for (const cat of ["NAJM_REPORT", "DRIVER_LICENSE", "VEHICLE_REGISTRATION"]) expect((await upload(w.c.pm, id, cat)).status).toBe(201);
    expect((await w.c.pm.post(`/api/accident-cases/${id}/submit`)).status).toBe(200);
    // after submission the driver cannot edit any more
    expect((await w.c.driver.patch(`/api/accident-cases/${id}`, { location: "موقع آخر" })).status).toBe(409);
  });

  it("the four documents are mandatory before submission; a re-upload supersedes the old file without deleting it", async () => {
    const w = await world();
    const id = await newDraft(w);
    const none = await w.c.pm.post(`/api/accident-cases/${id}/submit`);
    expect(none.status).toBe(409);
    expect(none.body.error.details.missing.sort()).toEqual(REQUIRED.map((c) => `attachment:${c}`).sort());
    for (const cat of REQUIRED.slice(0, 3)) await upload(w.c.pm, id, cat);
    expect((await w.c.pm.post(`/api/accident-cases/${id}/submit`)).body.error.details.missing).toEqual(["attachment:VEHICLE_REGISTRATION"]);
    // a PHOTO does not stand in for a required document
    await upload(w.c.pm, id, "PHOTO");
    expect((await w.c.pm.post(`/api/accident-cases/${id}/submit`)).status).toBe(409);
    await upload(w.c.pm, id, "VEHICLE_REGISTRATION");
    const second = await upload(w.c.pm, id, "DRIVER_ID", "new-id.pdf");
    expect(second.status).toBe(201);
    const atts = (await detail(w.c.pm, id)).attachments as { category: string; supersededAt: string | null }[];
    expect(atts.filter((a) => a.category === "DRIVER_ID")).toHaveLength(2);
    expect(atts.filter((a) => a.category === "DRIVER_ID" && a.supersededAt === null)).toHaveLength(1);
    expect((await w.c.pm.post(`/api/accident-cases/${id}/submit`)).status).toBe(200);
  });
});

describe("submission, vehicle status and assignment", () => {
  it("submit flags the vehicle ACCIDENT, stores its previous status, mirrors the legacy status and auto-assigns the one officer", async () => {
    const w = await world();
    const id = await newDraft(w);
    expect((await vehicleOf(w.vehicle.id)).status).toBe("ASSIGNED");
    await uploadRequired(w.c.pm, id);
    expect((await w.c.pm.post(`/api/accident-cases/${id}/submit`)).status).toBe(200);
    const acc = await caseOf(id);
    expect(acc).toMatchObject({ workflowStage: "AWAITING_TECHNICAL", status: "UNDER_REVIEW", assignedTo: w.tech.id, assignmentMode: "AUTO", vehicleStatusBefore: "ASSIGNED" });
    expect((await vehicleOf(w.vehicle.id)).status).toBe("ACCIDENT");
    const log = await db.select().from(accidentAssignments).where(eq(accidentAssignments.accidentId, id));
    expect(log).toHaveLength(1);
    expect(log[0]).toMatchObject({ stage: "AWAITING_TECHNICAL", assignedTo: w.tech.id, assignedBy: null, mode: "AUTO" });
    const notes = await db.select().from(notifications).where(eq(notifications.userId, w.tech.id));
    expect(notes.map((n) => n.type)).toContain("ACCIDENT_CASE_ASSIGNED");
    const d = await detail(w.c.pm, id);
    expect(d.transitions.map((t: { toStage: string }) => t.toStage)).toEqual(["DRAFT", "AWAITING_TECHNICAL"]);
    expect(d.assignments).toHaveLength(1);
  });

  it("no designated officer, several officers, or an unusable officer: the case goes to the queue (never a random pick)", async () => {
    const w = await world();
    // none
    await db.delete(accidentStageOfficers);
    const a = await toTechnical(w);
    expect(await caseOf(a)).toMatchObject({ assignedTo: null, assignmentMode: "QUEUE" });
    const queue = (await w.c.manager.get("/api/accident-cases?queue=true")).body.data.map((x: { id: string }) => x.id);
    expect(queue).toContain(a);
    expect((await w.c.pm.get("/api/accident-cases?queue=true")).status).toBe(403);
    const managerNotes = await db.select().from(notifications).where(eq(notifications.userId, (await db.select().from(users).where(eq(users.email, w.manager.email)))[0]!.id));
    void managerNotes;
    // several at the project level
    const tech2 = await createUser(["TECHNICAL"]);
    for (const u of [w.tech, tech2]) expect((await w.c.manager.post("/api/accident-cases/officers", { stage: "TECHNICAL", userId: u.id, projectId: w.project.id })).status).toBe(201);
    const b = await toTechnical(w);
    expect(await caseOf(b)).toMatchObject({ assignedTo: null, assignmentMode: "QUEUE" });
    expect((await db.select().from(accidentAssignments).where(eq(accidentAssignments.accidentId, b)))[0]).toMatchObject({ mode: "QUEUE", reason: "MULTIPLE_OFFICERS" });
    // a designated officer that is disabled is not eligible
    await db.delete(accidentStageOfficers);
    expect((await w.c.manager.post("/api/accident-cases/officers", { stage: "TECHNICAL", userId: w.tech.id, projectId: w.project.id })).status).toBe(201);
    await db.update(users).set({ status: "DISABLED" }).where(eq(users.id, w.tech.id));
    const c2 = await toTechnical(w);
    expect(await caseOf(c2)).toMatchObject({ assignedTo: null, assignmentMode: "QUEUE" });
    await db.update(users).set({ status: "ACTIVE" }).where(eq(users.id, w.tech.id));
  });

  it("officers can only be designated for people who hold the stage permission, by someone with accidents.assign", async () => {
    const w = await world();
    expect((await w.c.manager.post("/api/accident-cases/officers", { stage: "INSURANCE", userId: w.viewer.id })).status).toBe(400);
    expect((await w.c.manager.post("/api/accident-cases/officers", { stage: "TECHNICAL", userId: w.pm.id })).status).toBe(400);
    for (const who of ["pm", "tech", "insurer", "viewer", "finance"] as const) expect((await w.c[who].post("/api/accident-cases/officers", { stage: "TECHNICAL", userId: w.tech.id })).status, who).toBe(403);
    expect((await w.c.manager.post("/api/accident-cases/officers", { stage: "INSURANCE", userId: w.insurer.id })).status).toBe(409); // already designated
    const list = (await w.c.manager.get("/api/accident-cases/officers")).body.data as { id: string; userId: string }[];
    expect(list.map((o) => o.userId).sort()).toEqual([w.tech.id, w.insurer.id].sort());
    expect((await w.c.pm.get("/api/accident-cases/officers")).status).toBe(403);
    expect((await w.c.manager.delete(`/api/accident-cases/officers/${list[0]!.id}`)).status).toBe(200);
  });

  it("manual assignment and reassignment by accidents.assign; everything is logged and the assignee is notified", async () => {
    const w = await world();
    await db.delete(accidentStageOfficers);
    const id = await toTechnical(w); // queue
    const tech2 = await createUser(["TECHNICAL"]);
    const t2c = await login(tech2.email);
    // not an assigner / not allowed for this stage / not qualified
    expect((await w.c.pm.post(`/api/accident-cases/${id}/assign`, { userId: w.tech.id })).status).toBe(403);
    expect((await w.c.tech.post(`/api/accident-cases/${id}/assign`, { userId: w.tech.id })).status).toBe(403);
    expect((await w.c.manager.post(`/api/accident-cases/${id}/assign`, { userId: w.viewer.id })).status).toBe(400);
    expect((await w.c.manager.post(`/api/accident-cases/${id}/assign`, { userId: w.insurer.id })).status).toBe(400);
    // the unassigned technician cannot work the case yet
    expect((await w.c.tech.put(`/api/accident-cases/${id}/technical`, { damageDescription: "ضرر", repairDecision: "REPAIR" })).status).toBe(403);
    expect((await w.c.manager.post(`/api/accident-cases/${id}/assign`, { userId: w.tech.id, reason: "الأقرب للموقع" })).status).toBe(200);
    expect(await caseOf(id)).toMatchObject({ assignedTo: w.tech.id, assignmentMode: "MANUAL" });
    expect((await w.c.manager.post(`/api/accident-cases/${id}/assign`, { userId: w.tech.id })).status).toBe(409);
    expect((await w.c.manager.post(`/api/accident-cases/${id}/assign`, { userId: tech2.id })).status).toBe(200);
    // the previous assignee loses the right to act, the new one has it
    expect((await w.c.tech.put(`/api/accident-cases/${id}/technical`, { damageDescription: "ضرر", repairDecision: "REPAIR" })).status).toBe(403);
    expect((await t2c.put(`/api/accident-cases/${id}/technical`, { damageDescription: "ضرر في الصدام", repairDecision: "REPAIR" })).status).toBe(200);
    const log = await db.select().from(accidentAssignments).where(eq(accidentAssignments.accidentId, id)).orderBy(accidentAssignments.createdAt);
    expect(log.map((l) => [l.mode, l.assignedTo])).toEqual([["QUEUE", null], ["MANUAL", w.tech.id], ["MANUAL", tech2.id]]);
    expect(log[1]!.assignedBy).not.toBeNull();
    expect((await db.select().from(notifications).where(eq(notifications.userId, tech2.id))).map((n) => n.type)).toContain("ACCIDENT_CASE_ASSIGNED");
  });

  it("a stage that has no officer cannot be assigned", async () => {
    const w = await world();
    const id = await toTechnical(w);
    await toEstimates(w, id);
    expect((await w.c.manager.post(`/api/accident-cases/${id}/assign`, { userId: w.tech.id })).status).toBe(409);
    expect((await w.c.manager.post(`/api/accident-cases/${id}/assign`, { userId: crypto.randomUUID() })).status).toBe(409);
  });
});

describe("technical review", () => {
  it("only the assigned technician records damage, notes and repairability, and can only refer to estimates when repairable", async () => {
    const w = await world();
    const id = await toTechnical(w);
    // visible to the assigned technician; not workable by others
    expect((await w.c.tech.get("/api/accident-cases?mine=true")).body.data.map((x: { id: string }) => x.id)).toContain(id);
    for (const who of ["pm", "insurer", "viewer", "finance", "driver"] as const) expect((await w.c[who].put(`/api/accident-cases/${id}/technical`, { damageDescription: "ضرر", repairDecision: "REPAIR" })).status, who).toBe(403);
    expect((await w.c.otherPm.put(`/api/accident-cases/${id}/technical`, { damageDescription: "ضرر", repairDecision: "REPAIR" })).status).toBe(404);
    // nothing recorded yet → cannot move on
    const early = await w.c.tech.post(`/api/accident-cases/${id}/transition`, { to: "AWAITING_ESTIMATES" });
    expect(early.status).toBe(409);
    expect(early.body.error.details.missing).toEqual(expect.arrayContaining(["technical.damageDescription", "technical.repairDecision"]));
    expect((await w.c.tech.put(`/api/accident-cases/${id}/technical`, { damageDescription: "تلف الصدام والمصباح", technicalNotes: "قطع متوفرة", repairDecision: "NOT_REPAIRABLE" })).status).toBe(200);
    // not repairable → estimates make no sense
    expect((await w.c.tech.post(`/api/accident-cases/${id}/transition`, { to: "AWAITING_ESTIMATES" })).status).toBe(409);
    expect((await w.c.tech.put(`/api/accident-cases/${id}/technical`, { damageDescription: "تلف الصدام والمصباح", technicalNotes: "قطع متوفرة", repairDecision: "REPAIR" })).status).toBe(200);
    expect((await w.c.tech.post(`/api/accident-cases/${id}/transition`, { to: "AWAITING_INSURANCE" })).status).toBe(409); // repairable: needs estimates first
    const ok = await w.c.tech.post(`/api/accident-cases/${id}/transition`, { to: "AWAITING_ESTIMATES" });
    expect(ok.status).toBe(200);
    expect(await caseOf(id)).toMatchObject({ workflowStage: "AWAITING_ESTIMATES", status: "UNDER_REVIEW", assignedTo: null, damageDescription: "تلف الصدام والمصباح", repairDecision: "REPAIR" });
    // the technician's step is over: the case is no longer theirs
    expect((await w.c.tech.put(`/api/accident-cases/${id}/technical`, { damageDescription: "ضرر", repairDecision: "REPAIR" })).status).toBe(403);
    expect((await w.c.sa.put(`/api/accident-cases/${id}/technical`, { damageDescription: "ضرر", repairDecision: "REPAIR" })).status).toBe(409);
  });

  it("a vehicle that is not repairable skips the estimates and goes straight to insurance", async () => {
    const w = await world();
    const id = await toTechnical(w);
    expect((await w.c.tech.put(`/api/accident-cases/${id}/technical`, { damageDescription: "تلف كامل للهيكل", technicalNotes: "الهيكل غير قابل للإصلاح اقتصاديًا", repairDecision: "NOT_REPAIRABLE" })).status).toBe(200);
    expect((await w.c.tech.post(`/api/accident-cases/${id}/transition`, { to: "AWAITING_INSURANCE" })).status).toBe(200);
    expect(await caseOf(id)).toMatchObject({ workflowStage: "AWAITING_INSURANCE", assignedTo: w.insurer.id, assignmentMode: "AUTO", status: "INSURANCE" });
  });
});

describe("estimates", () => {
  it("the project manager uploads estimate reports and amounts, keeps several, approves one, deletes none", async () => {
    const w = await world();
    const id = await toTechnical(w);
    await toEstimates(w, id);
    // others cannot
    const att = await upload(w.c.pm, id, "ESTIMATE", "a.pdf");
    expect(att.status).toBe(201);
    expect((await upload(w.c.tech, id, "ESTIMATE")).status).toBe(403);
    expect((await upload(w.c.insurer, id, "ESTIMATE")).status).toBe(403);
    expect((await w.c.tech.post(`/api/accident-cases/${id}/estimates`, { vendorName: "ورشة", amount: "10", attachmentId: att.body.data.id })).status).toBe(403);
    // an estimate needs its report file
    expect((await w.c.pm.post(`/api/accident-cases/${id}/estimates`, { vendorName: "ورشة الأمل", amount: "100", attachmentId: crypto.randomUUID() })).status).toBe(400);
    expect((await w.c.pm.post(`/api/accident-cases/${id}/estimates`, { vendorName: "ورشة الأمل", amount: "-5", attachmentId: att.body.data.id })).status).toBe(400);
    // cannot leave without a chosen estimate
    const none = await w.c.pm.post(`/api/accident-cases/${id}/transition`, { to: "AWAITING_INSURANCE" });
    expect(none.body.error.details.missing).toContain("estimates.none");
    const e1 = (await w.c.pm.post(`/api/accident-cases/${id}/estimates`, { vendorName: "ورشة الأمل", amount: "2500.00", notes: "قطع أصلية", attachmentId: att.body.data.id })).body.data.id as string;
    const e2 = await addEstimate(w, id, "ورشة النور", "1900.50");
    const unselected = await w.c.pm.post(`/api/accident-cases/${id}/transition`, { to: "AWAITING_INSURANCE" });
    expect(unselected.body.error.details.missing).toContain("estimates.selected");
    expect((await w.c.pm.post(`/api/accident-cases/${id}/estimates/${e1}/select`)).status).toBe(200);
    expect((await w.c.pm.post(`/api/accident-cases/${id}/estimates/${e2}/select`)).status).toBe(200);
    const rows = await db.select().from(accidentEstimates).where(eq(accidentEstimates.accidentId, id));
    expect(rows).toHaveLength(2);
    expect(rows.filter((r) => r.selected).map((r) => r.id)).toEqual([e2]);
    expect((await caseOf(id)).repairCost).toBe("1900.50");
    expect((await w.c.pm.delete(`/api/accident-cases/${id}/estimates/${e1}`)).status).toBe(404); // there is no delete
    expect((await detail(w.c.pm, id)).estimates).toHaveLength(2);
    expect((await w.c.pm.post(`/api/accident-cases/${id}/transition`, { to: "AWAITING_INSURANCE" })).status).toBe(200);
    // after the stage, estimates are frozen
    expect((await w.c.pm.post(`/api/accident-cases/${id}/estimates/${e1}/select`)).status).toBe(409);
    // the other project's manager cannot touch it
    expect((await w.c.otherPm.post(`/api/accident-cases/${id}/estimates/${e1}/select`)).status).toBe(404);
  });

  it("concurrent selection of two estimates leaves exactly one selected", async () => {
    const w = await world();
    const id = await toTechnical(w);
    await toEstimates(w, id);
    const e1 = await addEstimate(w, id, "ورشة 1", "100");
    const e2 = await addEstimate(w, id, "ورشة 2", "200");
    const [a, b] = await Promise.all([w.c.pm.post(`/api/accident-cases/${id}/estimates/${e1}/select`), w.c.pm.post(`/api/accident-cases/${id}/estimates/${e2}/select`)]);
    expect([a.status, b.status]).toEqual([200, 200]);
    expect((await db.select().from(accidentEstimates).where(eq(accidentEstimates.accidentId, id))).filter((r) => r.selected)).toHaveLength(1);
  });
});

describe("insurance claim", () => {
  it("the insurance officer registers company, claim number and date; the claim runs through its statuses to the compensation proof", async () => {
    const w = await world();
    const id = await toTechnical(w);
    await toInsurance(w, id);
    expect(await caseOf(id)).toMatchObject({ workflowStage: "AWAITING_INSURANCE", assignedTo: w.insurer.id, assignmentMode: "AUTO", status: "INSURANCE" });
    // only the claims officer registers the claim
    for (const who of ["pm", "tech", "viewer", "finance", "driver"] as const) expect((await w.c[who].put(`/api/accident-cases/${id}/claim`, claimBody)).status, who).toBe(403);
    expect((await w.c.insurer.put(`/api/accident-cases/${id}/claim`, { insurerName: "التعاونية", claimNumber: "", filedAt: "2026-06-15" })).status).toBe(400);
    expect((await w.c.insurer.put(`/api/accident-cases/${id}/claim`, { ...claimBody, filedAt: "2026-07-30" })).status).toBe(400); // future
    const reg = await w.c.insurer.put(`/api/accident-cases/${id}/claim`, claimBody);
    expect(reg.status, JSON.stringify(reg.body)).toBe(200);
    expect(reg.body.data).toMatchObject({ status: "FILED", insurerName: "التعاونية", claimNumber: "CLM-1001" });
    expect(await caseOf(id)).toMatchObject({ workflowStage: "CLAIM_IN_PROGRESS", insuranceClaimNumber: "CLM-1001", assignedTo: w.insurer.id });
    // status graph
    expect((await w.c.insurer.post(`/api/accident-cases/${id}/claim/status`, { status: "COMPENSATION_RECEIVED", receivedAmount: "1" })).status).toBe(409);
    expect((await w.c.pm.post(`/api/accident-cases/${id}/claim/status`, { status: "PROCESSING" })).status).toBe(403);
    expect((await w.c.insurer.post(`/api/accident-cases/${id}/claim/status`, { status: "PROCESSING" })).status).toBe(200);
    expect((await w.c.insurer.post(`/api/accident-cases/${id}/claim/status`, { status: "PROCESSING" })).status).toBe(409);
    const approved = await w.c.insurer.post(`/api/accident-cases/${id}/claim/status`, { status: "APPROVED", approvedAmount: "2400.00" });
    expect(approved.status).toBe(200);
    expect(approved.body.data).toMatchObject({ status: "APPROVED", approvedAmount: "2400.00" });
    expect(await caseOf(id)).toMatchObject({ workflowStage: "AWAITING_COMPENSATION_PROOF", status: "INSURANCE" });
    // compensation needs the proof and the amount
    const noProof = await w.c.insurer.post(`/api/accident-cases/${id}/claim/status`, { status: "COMPENSATION_RECEIVED", receivedAmount: "2400.00" });
    expect(noProof.status).toBe(409);
    expect(noProof.body.error.details.missing).toEqual(["attachment:COMPENSATION_PROOF"]);
    expect((await upload(w.c.pm, id, "COMPENSATION_PROOF")).status).toBe(403); // only the claims officer files it
    expect((await upload(w.c.insurer, id, "COMPENSATION_PROOF")).status).toBe(201);
    expect((await w.c.insurer.post(`/api/accident-cases/${id}/claim/status`, { status: "COMPENSATION_RECEIVED" })).body.error.details.missing).toEqual(["claim.receivedAmount"]);
    const got = await w.c.insurer.post(`/api/accident-cases/${id}/claim/status`, { status: "COMPENSATION_RECEIVED", receivedAmount: "2400.00" });
    expect(got.status).toBe(200);
    expect(got.body.data).toMatchObject({ status: "COMPENSATION_RECEIVED", receivedAmount: "2400.00" });
    expect(await caseOf(id)).toMatchObject({ workflowStage: "AWAITING_FINAL_CLOSURE", status: "UNDER_REVIEW", assignedTo: null });
  });

  it("a rejection or 'not covered' needs a reason and a supporting document, then goes to final closure", async () => {
    const w = await world();
    const id = await toTechnical(w);
    await toClaim(w, id);
    const noReason = await w.c.insurer.post(`/api/accident-cases/${id}/claim/status`, { status: "REJECTED" });
    expect(noReason.status).toBe(409);
    expect(noReason.body.error.details.missing.sort()).toEqual(["attachment:INSURER_DECISION", "claim.rejectionReason"]);
    expect((await w.c.insurer.post(`/api/accident-cases/${id}/claim/status`, { status: "REJECTED", reason: "الحادث غير مشمول بالوثيقة" })).body.error.details.missing).toEqual(["attachment:INSURER_DECISION"]);
    expect((await upload(w.c.insurer, id, "INSURER_DECISION")).status).toBe(201);
    const r = await w.c.insurer.post(`/api/accident-cases/${id}/claim/status`, { status: "REJECTED", reason: "الحادث غير مشمول بالوثيقة" });
    expect(r.status, JSON.stringify(r.body)).toBe(200);
    expect(r.body.data).toMatchObject({ status: "REJECTED", rejectionReason: "الحادث غير مشمول بالوثيقة" });
    expect(await caseOf(id)).toMatchObject({ workflowStage: "AWAITING_FINAL_CLOSURE" });
    // the claim officer's step is over: the case is no longer theirs; nobody can reverse the decision
    expect((await w.c.insurer.post(`/api/accident-cases/${id}/claim/status`, { status: "APPROVED" })).status).toBe(403);
    expect((await w.c.sa.post(`/api/accident-cases/${id}/claim/status`, { status: "APPROVED" })).status).toBe(409);
  });
});

describe("final closure, reopening and the vehicle", () => {
  it("only accidents.close closes, and only when complete; the vehicle is restored unless another accident is open", async () => {
    const w = await world();
    const id = await toTechnical(w);
    await toFinalClosure(w, id);
    await documentRepair(w, id);
    expect((await vehicleOf(w.vehicle.id)).status).toBe("ACCIDENT");
    for (const who of ["pm", "tech", "insurer", "viewer", "finance", "driver"] as const) expect((await w.c[who].post(`/api/accident-cases/${id}/transition`, { to: "CLOSED", resolution: "تم" })).status, who).toBe(403);
    const noRes = await w.c.manager.post(`/api/accident-cases/${id}/transition`, { to: "CLOSED" });
    expect(noRes.status).toBe(409);
    expect(noRes.body.error.details.missing).toEqual(["resolution"]);
    expect((await caseOf(id)).workflowStage).toBe("AWAITING_FINAL_CLOSURE");
    // a second open accident on the same vehicle keeps it flagged
    const legacy = await w.c.pm.post("/api/accidents", { vehicleId: w.vehicle.id, occurredAt: "2026-06-14T10:00:00+03:00", description: "حادث قديم مفتوح", severity: "MINOR" });
    expect(legacy.status).toBe(201);
    const closed = await w.c.manager.post(`/api/accident-cases/${id}/transition`, { to: "CLOSED", resolution: "اكتملت المطالبة وسُلّم التعويض" });
    expect(closed.status, JSON.stringify(closed.body)).toBe(200);
    expect(await caseOf(id)).toMatchObject({ workflowStage: "CLOSED", status: "CLOSED", resolution: "اكتملت المطالبة وسُلّم التعويض", closedBy: (await db.select().from(users).where(eq(users.email, w.manager.email)))[0]!.id });
    expect((await caseOf(id)).closedAt).not.toBeNull();
    expect((await vehicleOf(w.vehicle.id)).status).toBe("ACCIDENT");
    // closing the legacy one releases the vehicle
    await w.c.pm.post(`/api/accidents/${legacy.body.data.id}/status`, { to: "CLOSED", resolution: "تم" });
    expect((await vehicleOf(w.vehicle.id)).status).toBe("ASSIGNED");
    // a closed case takes no more files or changes
    expect((await upload(w.c.pm, id, "PHOTO")).status).toBe(409);
    expect((await w.c.manager.post(`/api/accident-cases/${id}/transition`, { to: "CLOSED", resolution: "مرة أخرى" })).status).toBe(409);
  });

  it("only accidents.reopen reopens (with a reason) and the vehicle is flagged again", async () => {
    const w = await world();
    const id = await toTechnical(w);
    await toFinalClosure(w, id);
    await documentRepair(w, id);
    expect((await w.c.manager.post(`/api/accident-cases/${id}/transition`, { to: "CLOSED", resolution: "تم الإغلاق" })).status).toBe(200);
    expect((await vehicleOf(w.vehicle.id)).status).toBe("ASSIGNED");
    for (const who of ["pm", "insurer", "finance"] as const) expect((await w.c[who].post(`/api/accident-cases/${id}/transition`, { to: "AWAITING_FINAL_CLOSURE", reason: "ظهرت مستندات" })).status, who).toBe(403);
    expect((await w.c.manager.post(`/api/accident-cases/${id}/transition`, { to: "AWAITING_FINAL_CLOSURE" })).status).toBe(409); // reason required
    expect((await w.c.manager.post(`/api/accident-cases/${id}/transition`, { to: "AWAITING_FINAL_CLOSURE", reason: "ظهرت مستندات جديدة" })).status).toBe(200);
    expect(await caseOf(id)).toMatchObject({ workflowStage: "AWAITING_FINAL_CLOSURE", status: "UNDER_REVIEW", closedAt: null, closedBy: null });
    expect((await vehicleOf(w.vehicle.id)).status).toBe("ACCIDENT");
    const t = (await detail(w.c.manager, id)).transitions as { toStage: string; reason: string | null }[];
    expect(t[t.length - 1]).toMatchObject({ toStage: "AWAITING_FINAL_CLOSURE", reason: "ظهرت مستندات جديدة" });
  });

  it("returning to an earlier stage needs accidents.reopen and a reason, and re-runs the assignment", async () => {
    const w = await world();
    const id = await toTechnical(w);
    await toClaim(w, id);
    expect((await w.c.pm.post(`/api/accident-cases/${id}/transition`, { to: "AWAITING_TECHNICAL", reason: "نقص" })).status).toBe(403);
    expect((await w.c.manager.post(`/api/accident-cases/${id}/transition`, { to: "AWAITING_TECHNICAL" })).status).toBe(409);
    const r = await w.c.manager.post(`/api/accident-cases/${id}/transition`, { to: "AWAITING_TECHNICAL", reason: "التقييم الفني ناقص" });
    expect(r.status, JSON.stringify(r.body)).toBe(200);
    expect(await caseOf(id)).toMatchObject({ workflowStage: "AWAITING_TECHNICAL", assignedTo: w.tech.id, assignmentMode: "AUTO", returnedToStage: "AWAITING_TECHNICAL", returnedReason: "التقييم الفني ناقص" });
    expect((await vehicleOf(w.vehicle.id)).status).toBe("ACCIDENT");
  });
});

describe("transitions that must not happen", () => {
  it("skipping stages, going backwards without rights, and moves reserved for other endpoints are refused", async () => {
    const w = await world();
    const id = await newDraft(w);
    for (const to of ["AWAITING_TECHNICAL", "AWAITING_ESTIMATES", "AWAITING_INSURANCE", "CLAIM_IN_PROGRESS", "AWAITING_FINAL_CLOSURE", "CLOSED", "RETURNED", "DRAFT"]) {
      const r = await w.c.sa.post(`/api/accident-cases/${id}/transition`, { to, reason: "اختبار" });
      expect(r.status, `DRAFT → ${to}`).toBe(409);
    }
    expect((await caseOf(id)).workflowStage).toBe("DRAFT");
    await uploadRequired(w.c.pm, id);
    await w.c.pm.post(`/api/accident-cases/${id}/submit`);
    for (const to of ["AWAITING_INSURANCE", "CLAIM_IN_PROGRESS", "AWAITING_COMPENSATION_PROOF", "AWAITING_FINAL_CLOSURE", "CLOSED"]) {
      const r = await w.c.sa.post(`/api/accident-cases/${id}/transition`, { to, resolution: "x", reason: "x" });
      expect(r.status, `TECHNICAL → ${to}`).toBe(409);
    }
    expect((await w.c.pm.post(`/api/accident-cases/${id}/submit`)).status).toBe(409); // not a draft any more
    expect((await caseOf(id)).workflowStage).toBe("AWAITING_TECHNICAL");
    // the claim stages are only entered through the claim endpoints
    await toEstimates({ ...w } as W, id);
    await addEstimate(w, id, "ورشة", "10").then(async (e) => w.c.pm.post(`/api/accident-cases/${id}/estimates/${e}/select`));
    await w.c.pm.post(`/api/accident-cases/${id}/transition`, { to: "AWAITING_INSURANCE" });
    expect((await w.c.sa.post(`/api/accident-cases/${id}/transition`, { to: "CLAIM_IN_PROGRESS" })).status).toBe(409);
    expect((await w.c.insurer.put(`/api/accident-cases/${id}/claim/status`, { status: "APPROVED" })).status).toBe(404);
    expect((await w.c.insurer.post(`/api/accident-cases/${id}/claim/status`, { status: "APPROVED" })).status).toBe(409); // no claim yet
  });

  it("concurrent identical moves: exactly one wins and the history has one entry", async () => {
    const w = await world();
    const id = await newDraft(w);
    await uploadRequired(w.c.pm, id);
    const results = await Promise.all([1, 2, 3].map(() => w.c.pm.post(`/api/accident-cases/${id}/submit`)));
    expect(results.map((r) => r.status).sort()).toEqual([200, 409, 409]);
    const t = await db.select().from(accidentTransitions).where(eq(accidentTransitions.accidentId, id));
    expect(t.map((x) => x.toStage).sort()).toEqual(["AWAITING_TECHNICAL", "DRAFT"]);
    expect(await db.select().from(accidentAssignments).where(eq(accidentAssignments.accidentId, id))).toHaveLength(1);
    expect((await vehicleOf(w.vehicle.id)).status).toBe("ACCIDENT");
    expect((await caseOf(id)).vehicleStatusBefore).toBe("ASSIGNED");
  });

  it("concurrent assignments: the same target is assigned once; different targets are applied one after the other and the log matches the result", async () => {
    const w = await world();
    await db.delete(accidentStageOfficers);
    const id = await toTechnical(w); // queue
    const tech2 = await createUser(["TECHNICAL"]);
    const same = await Promise.all([1, 2, 3].map(() => w.c.manager.post(`/api/accident-cases/${id}/assign`, { userId: w.tech.id })));
    expect(same.map((r) => r.status).sort()).toEqual([200, 409, 409]);
    const mixed = await Promise.all([w.c.manager.post(`/api/accident-cases/${id}/assign`, { userId: tech2.id }), w.c.sa.post(`/api/accident-cases/${id}/assign`, { userId: w.tech.id })]);
    expect(mixed.map((r) => r.status).every((s) => s === 200 || s === 409)).toBe(true);
    const log = await db.select().from(accidentAssignments).where(eq(accidentAssignments.accidentId, id)).orderBy(accidentAssignments.createdAt);
    expect((await caseOf(id)).assignedTo).toBe(log[log.length - 1]!.assignedTo);
    expect(log.filter((l) => l.mode === "MANUAL").length).toBe(1 + mixed.filter((r) => r.status === 200).length);
  });
});

describe("scope and permissions", () => {
  it("cases are limited to their project; officers and managers see what they are given", async () => {
    const w = await world();
    const id = await toTechnical(w);
    expect((await w.c.otherPm.get(`/api/accident-cases/${id}`)).status).toBe(404);
    expect((await w.c.otherPm.get("/api/accident-cases")).body.data.map((x: { id: string }) => x.id)).not.toContain(id);
    // project member readers, the assigned technician, the insurance officer (ALL) and the manager see it
    for (const who of ["pm", "tech", "viewer", "finance", "insurer", "manager", "sa"] as const) expect((await w.c[who].get(`/api/accident-cases/${id}`)).status, who).toBe(200);
    // a driver of another vehicle sees nothing; the case's own driver sees it through the legacy scope
    const otherDriver = await createDriverUser(w.project.id);
    expect((await (await login(otherDriver.user.email)).get(`/api/accident-cases/${id}`)).status).toBe(404);
    // the technician reaches a case of another project only when it is assigned to them
    const p2 = await createProject({ managerId: w.pm.id });
    const v2 = await createVehicle(p2.id);
    const id2 = (await w.c.pm.post("/api/accident-cases", draftBody(v2.id))).body.data.id as string;
    await uploadRequired(w.c.pm, id2);
    await w.c.pm.post(`/api/accident-cases/${id2}/submit`);
    expect((await caseOf(id2)).assignedTo).toBeNull(); // the technician is designated for the first project only
    expect((await w.c.tech.get(`/api/accident-cases/${id2}`)).status).toBe(404);
    expect((await w.c.manager.post(`/api/accident-cases/${id2}/assign`, { userId: w.tech.id })).status).toBe(200);
    expect((await w.c.tech.get(`/api/accident-cases/${id2}`)).status).toBe(200);
    // writes by readers
    for (const who of ["viewer", "finance"] as const) {
      expect((await w.c[who].post("/api/accident-cases", draftBody(w.vehicle.id))).status, who).toBe(403);
      expect((await upload(w.c[who], id, "PHOTO")).status, who).toBe(403);
    }
  });

  it("SLA: calendar days from the stage start, overdue after the limit", async () => {
    const w = await world();
    const id = await toTechnical(w);
    const d = await detail(w.c.tech, id);
    expect(d.slaDueAt).toBe("2026-06-18T09:00:00.000Z");
    expect(d.overdue).toBe(false);
    setClock(new Date("2026-06-18T09:00:01Z"));
    expect((await detail(w.c.tech, id)).overdue).toBe(true);
    const list = (await w.c.manager.get("/api/accident-cases?stage=AWAITING_TECHNICAL")).body.data as { id: string; overdue: boolean }[];
    expect(list.find((x) => x.id === id)!.overdue).toBe(true);
  });
});

describe("sensitive documents", () => {
  const names = { id: "secret-driver-id-4411.pdf", lic: "secret-licence-4412.pdf", reg: "secret-registration-4413.pdf", police: "secret-police-4414.pdf", ins: "secret-policy-4415.pdf" };

  async function caseWithDocs(w: W, submit = false) {
    const id = (await w.c.driver.post("/api/accident-cases", draftBody(w.vehicle.id))).body.data.id as string;
    const driverId = (await upload(w.c.driver, id, "DRIVER_ID", names.id)).body.data.id as string;
    await upload(w.c.pm, id, "DRIVER_LICENSE", names.lic);
    const reg = (await upload(w.c.pm, id, "VEHICLE_REGISTRATION", names.reg)).body.data.id as string;
    await upload(w.c.pm, id, "NAJM_REPORT", "najm-report.pdf");
    const police = (await upload(w.c.pm, id, "POLICE_REPORT", names.police)).body.data.id as string;
    const ins = (await upload(w.c.pm, id, "INSURANCE", names.ins)).body.data.id as string;
    const photo = (await upload(w.c.pm, id, "PHOTO", "front.pdf")).body.data.id as string;
    if (submit) expect((await w.c.pm.post(`/api/accident-cases/${id}/submit`)).status).toBe(200);
    return { id, driverId, reg, police, ins, photo };
  }
  const listed = async (c: Client, id: string) => ((await detail(c, id)).attachments as { id: string; category: string }[]).map((a) => a.category).sort();
  const download = (c: Client, id: string, attId: string) => c.get(`/api/accident-cases/${id}/attachments/${attId}/file`);

  it("visibility matrix by role: permission is necessary, participation is required, the uploader sees their own", async () => {
    const w = await world();
    const k = await caseWithDocs(w);
    const everything = ["DRIVER_ID", "DRIVER_LICENSE", "INSURANCE", "NAJM_REPORT", "PHOTO", "POLICE_REPORT", "VEHICLE_REGISTRATION"];
    // project manager (handles the project, holds the permission): everything
    expect(await listed(w.c.pm, k.id)).toEqual(everything);
    // the driver: only their own upload plus the non-sensitive files
    expect(await listed(w.c.driver, k.id)).toEqual(["DRIVER_ID", "NAJM_REPORT", "PHOTO"]);
    expect((await download(w.c.driver, k.id, k.driverId)).status).toBe(200);
    for (const [label, attId] of [["registration", k.reg], ["police", k.police], ["insurance", k.ins]] as const) expect((await download(w.c.driver, k.id, attId)).status, label).toBe(404);
    expect((await download(w.c.driver, k.id, k.photo)).status).toBe(200);
    // the manager and SUPER_ADMIN
    for (const who of ["manager", "sa"] as const) expect(await listed(w.c[who], k.id), who).toEqual(everything);
    // before submission the technician, the insurance officer, viewers and finance cannot even see the draft
    for (const who of ["tech", "insurer", "viewer", "finance"] as const) expect((await w.c[who].get(`/api/accident-cases/${k.id}`)).status, who).toBe(404);
    // submit: the technician becomes the assignee (participant) and sees the documents; the insurer is not one yet
    expect((await w.c.pm.post(`/api/accident-cases/${k.id}/submit`)).status).toBe(200);
    expect(await listed(w.c.tech, k.id)).toEqual(everything);
    expect(await listed(w.c.insurer, k.id)).toEqual(["NAJM_REPORT", "PHOTO"]);
    expect((await download(w.c.insurer, k.id, k.reg)).status).toBe(404);
    // roles that read the case but are not participants
    for (const who of ["viewer", "finance"] as const) {
      expect(await listed(w.c[who], k.id), who).toEqual(["NAJM_REPORT", "PHOTO"]);
      for (const attId of [k.driverId, k.reg, k.police, k.ins]) expect((await download(w.c[who], k.id, attId)).status, who).toBe(404);
      expect((await download(w.c[who], k.id, k.photo)).status, who).toBe(200);
    }
    // the driver still sees only their own upload after submission
    expect(await listed(w.c.driver, k.id)).toEqual(["DRIVER_ID", "NAJM_REPORT", "PHOTO"]);
    // a technician who never touched the case, even in the project, sees only the open files
    const stranger = await createUser(["TECHNICAL"]);
    await db.insert((await import("../src/db/schema/index.js")).projectUsers).values({ projectId: w.project.id, userId: stranger.id });
    const sc = await login(stranger.email);
    expect(await listed(sc, k.id)).toEqual(["NAJM_REPORT", "PHOTO"]);
    expect((await download(sc, k.id, k.reg)).status).toBe(404);
    // the claims officer becomes a participant when the case reaches insurance
    const technical = await w.c.tech.put(`/api/accident-cases/${k.id}/technical`, { damageDescription: "ضرر جسيم", technicalNotes: "غير قابلة للإصلاح", repairDecision: "NOT_REPAIRABLE" });
    expect(technical.status).toBe(200);
    expect((await w.c.tech.post(`/api/accident-cases/${k.id}/transition`, { to: "AWAITING_INSURANCE" })).status).toBe(200);
    expect(await listed(w.c.insurer, k.id)).toEqual(everything);
    expect((await download(w.c.insurer, k.id, k.police)).status).toBe(200);
  });

  it("the vehicle timeline hides another user's draft and never lists workflow file events", async () => {
    const w = await world();
    const id = (await w.c.driver.post("/api/accident-cases", draftBody(w.vehicle.id))).body.data.id as string;
    const events = async (c: Client) => ((await c.get(`/api/vehicles/${w.vehicle.id}/timeline`)).body.data as { action: string; description: string }[]);
    await upload(w.c.driver, id, "DRIVER_ID", "secret-id-9001.pdf");
    expect((await events(w.c.viewer)).map((e) => e.action)).not.toContain("ACCIDENT_CASE_CREATED");
    expect((await events(w.c.pm)).map((e) => e.action)).toContain("ACCIDENT_CASE_CREATED");
    for (const cat of ["NAJM_REPORT", "DRIVER_LICENSE", "VEHICLE_REGISTRATION"]) await upload(w.c.pm, id, cat);
    expect((await w.c.pm.post(`/api/accident-cases/${id}/submit`)).status).toBe(200);
    const viewer = await events(w.c.viewer);
    expect(viewer.map((e) => e.action)).toEqual(expect.arrayContaining(["ACCIDENT_CASE_CREATED", "ACCIDENT_CASE_STAGE_CHANGED"]));
    expect(viewer.map((e) => e.action)).not.toContain("FILE_UPLOADED");
    expect(JSON.stringify(viewer)).not.toContain("secret-id-9001");
  });

  it("a hidden file answers exactly like one that does not exist and is named nowhere in the response", async () => {
    const w = await world();
    const k = await caseWithDocs(w, true);
    const missing = await download(w.c.viewer, k.id, crypto.randomUUID());
    const hidden = await download(w.c.viewer, k.id, k.reg);
    expect(hidden.status).toBe(404);
    expect(hidden.status).toBe(missing.status);
    expect(hidden.body).toEqual(missing.body);
    // wrong case for a real file: same answer
    const other = await newDraft(w);
    expect((await download(w.c.pm, other, k.reg)).status).toBe(404);
    // nothing in what the viewer, finance and the driver receive names or counts the hidden files
    for (const who of ["viewer", "finance"] as const) {
      const body = JSON.stringify((await w.c[who].get(`/api/accident-cases/${k.id}`)).body);
      for (const secret of Object.values(names)) expect(body, `${who} ${secret}`).not.toContain(secret);
      expect(body).not.toContain(k.reg);
      expect(body).not.toContain(k.police);
      const legacy = JSON.stringify((await w.c[who].get(`/api/accidents/${k.id}`)).body);
      for (const secret of Object.values(names)) expect(legacy, `legacy ${who} ${secret}`).not.toContain(secret);
      expect(legacy).not.toContain(k.reg);
    }
    // the audit trail never carries file names of workflow uploads
    const audits = JSON.stringify((await w.c.pm.get(`/api/accidents/${k.id}`)).body.data.timeline);
    for (const secret of Object.values(names)) expect(audits).not.toContain(secret);
  });

  it("the legacy routes obey the same rule for workflow cases, and for legacy cases only under their own switch", async () => {
    const w = await world();
    const k = await caseWithDocs(w, true);
    // legacy detail and download of a workflow case
    const legacy = (await w.c.viewer.get(`/api/accidents/${k.id}`)).body.data;
    expect((legacy.attachments as { category: string }[]).map((a) => a.category).sort()).toEqual(["NAJM_REPORT", "PHOTO"]);
    expect((await w.c.viewer.get(`/api/accident-attachments/${k.police}/file`)).status).toBe(404);
    expect((await w.c.pm.get(`/api/accident-attachments/${k.police}/file`)).status).toBe(200);
    // a legacy accident with a police report. With the workflow on but the legacy switch off nothing changes for it (see the separate test);
    // under the legacy switch the project manager (handler) and the uploader keep it; finance and viewers do not.
    setLegacySensitiveEnforcementFlag(true);
    const leg = (await w.c.pm.post("/api/accidents", { vehicleId: w.vehicle.id, occurredAt: "2026-06-14T10:00:00+03:00", description: "حادث بالمسار القديم", severity: "MINOR" })).body.data.id as string;
    const pr = (await w.c.pm.upload(`/api/accidents/${leg}/attachments?category=POLICE_REPORT`, PDF_BYTES, "application/pdf", "post")).body.data.id as string;
    const ph = (await w.c.pm.upload(`/api/accidents/${leg}/attachments?category=PHOTO`, PDF_BYTES, "application/pdf", "post")).body.data.id as string;
    const file = (c: Client, id: string) => c.get(`/api/accident-attachments/${id}/file`);
    expect((await file(w.c.pm, pr)).status).toBe(200);
    expect((await file(w.c.finance, pr)).status).toBe(404);
    expect((await file(w.c.viewer, pr)).status).toBe(404);
    expect((await file(w.c.finance, ph)).status).toBe(200);
    expect((await w.c.finance.get(`/api/accidents/${leg}`)).body.data.attachments).toHaveLength(1);
    expect((await w.c.pm.get(`/api/accidents/${leg}`)).body.data.attachments).toHaveLength(2);
    // legacy switch off: legacy cases behave exactly as before this feature
    setLegacySensitiveEnforcementFlag(false);
    try {
      expect((await file(w.c.finance, pr)).status).toBe(200);
      expect((await w.c.finance.get(`/api/accidents/${leg}`)).body.data.attachments).toHaveLength(2);
      // …but a workflow case that already exists stays protected
      expect((await file(w.c.viewer, k.police)).status).toBe(404);
    } finally {
      setLegacySensitiveEnforcementFlag(null);
    }
  });

  it("uploads are limited by stage and role: claim documents only by the claims officer, nothing after closing", async () => {
    const w = await world();
    const id = await toTechnical(w);
    for (const cat of ["CLAIM_FORM", "INSURER_DECISION", "COMPENSATION_PROOF"]) {
      for (const who of ["pm", "tech", "viewer", "manager", "sa"] as const) expect((await upload(w.c[who], id, cat)).status, `${who} ${cat}`).toBe(403);
    }
    expect((await upload(w.c.tech, id, "PHOTO")).status).toBe(201); // the assigned technician adds photos
    expect((await upload(w.c.tech, id, "DRIVER_ID")).status).toBe(403);
    expect((await upload(w.c.insurer, id, "PHOTO")).status).toBe(403);
    expect((await upload(w.c.otherPm, id, "PHOTO")).status).toBe(404);
    const bad = await w.c.pm.agent.post(`/api/accident-cases/${id}/attachments?category=NOT_A_CATEGORY`).set("X-CSRF-Token", w.c.pm.csrf).set("Content-Type", "application/pdf").send(PDF_BYTES);
    expect(bad.status).toBe(400);
    expect((await w.c.pm.agent.post(`/api/accident-cases/${id}/attachments?category=PHOTO`).set("X-CSRF-Token", w.c.pm.csrf).set("Content-Type", "application/pdf").send(Buffer.from("not a pdf"))).status).toBe(400);
  });
});

describe("compatibility with legacy accidents", () => {
  it("a legacy accident is created, edited and closed exactly as before while the workflow is on", async () => {
    const w = await world();
    const r = await w.c.pm.post("/api/accidents", { vehicleId: w.vehicle.id, occurredAt: "2026-06-14T18:00:00+03:00", description: "حادث قديم عادي", severity: "MODERATE" });
    expect(r.status).toBe(201);
    const id = r.body.data.id as string;
    expect((await caseOf(id)).workflowStage).toBeNull();
    expect((await vehicleOf(w.vehicle.id)).status).toBe("ACCIDENT");
    expect((await w.c.pm.patch(`/api/accidents/${id}`, { description: "وصف معدل للحادث القديم" })).status).toBe(200);
    expect((await w.c.pm.post(`/api/accidents/${id}/status`, { to: "UNDER_REVIEW" })).status).toBe(200);
    expect((await w.c.pm.post(`/api/accidents/${id}/status`, { to: "CLOSED", resolution: "تم" })).status).toBe(200);
    expect((await vehicleOf(w.vehicle.id)).status).toBe("ASSIGNED");
    // the workflow endpoints do not see legacy accidents
    expect((await w.c.sa.get(`/api/accident-cases/${id}`)).status).toBe(404);
    expect((await w.c.sa.post(`/api/accident-cases/${id}/transition`, { to: "CLOSED", resolution: "x" })).status).toBe(404);
    expect((await w.c.sa.get("/api/accident-cases")).body.data.map((x: { id: string }) => x.id)).not.toContain(id);
  });

  it("workflow cases cannot be moved through the legacy routes, and they count as open accidents once submitted", async () => {
    const w = await world();
    const id = await toTechnical(w);
    expect((await w.c.sa.post(`/api/accidents/${id}/status`, { to: "CLOSED", resolution: "x" })).status).toBe(409);
    expect((await w.c.sa.patch(`/api/accidents/${id}`, { description: "تعديل من المسار القديم" })).status).toBe(409);
    expect((await w.c.sa.upload(`/api/accidents/${id}/attachments?category=PHOTO`, PDF_BYTES, "application/pdf", "post")).status).toBe(409);
    expect((await w.c.pm.get(`/api/accidents?open=true&projectId=${w.project.id}`)).body.data.map((x: { id: string }) => x.id)).toContain(id);
    expect((await w.c.pm.get(`/api/projects/${w.project.id}/dashboard`)).body.data.counts.openAccidents).toBe(1);
    expect((await caseOf(id)).workflowStage).toBe("AWAITING_TECHNICAL");
  });
});
void sql;
