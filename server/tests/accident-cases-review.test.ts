import { execFileSync } from "node:child_process";
import { and, eq, isNull, sql } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { db } from "../src/db/client.js";
import { syncCatalog } from "../src/db/bootstrap.js";
import { accidentStageOfficers, accidentTransitions, notifications, permissions, rolePermissions, roles } from "../src/db/schema/index.js";
import { setClock } from "../src/lib/clock.js";
import { config } from "../src/config.js";
import { setAccidentWorkflowFlag, setLegacySensitiveEnforcementFlag } from "../src/lib/feature-flags.js";
import { assertPlanScope, planAccidentCatalog, readCatalogState } from "../src/services/accident-catalog-sync.js";
import { createProject, createUser, createVehicle, login, PDF_BYTES, type Client } from "./helpers.js";
import { addEstimate, caseOf, claimBody, detail, documentRepair, draftBody, newDraft, toClaim, toEstimates, toFinalClosure, toInsurance, toTechnical, upload, uploadRequired, world, type W } from "./support/accident-world.js";

beforeAll(() => setAccidentWorkflowFlag(true));
afterAll(() => {
  setAccidentWorkflowFlag(null);
  setLegacySensitiveEnforcementFlag(null);
});
beforeEach(() => setClock(new Date("2026-06-15T09:00:00Z")));
afterEach(() => setClock(null));

const ids = (rows: { id: string }[]) => rows.map((r) => r.id);
const notesFor = async (userId: string) => db.select().from(notifications).where(eq(notifications.userId, userId));
const transition = (c: Client, id: string, body: object) => c.post(`/api/accident-cases/${id}/transition`, body);

describe("returned for completion", () => {
  it("a return shows the marker with reason, who must act and when; the stage and the whole history are kept; the next forward move clears it", async () => {
    const w = await world();
    const id = await toTechnical(w);
    await toClaim(w, id);
    expect((await detail(w.c.manager, id)).returnedForCompletion).toBeNull();
    setClock(new Date("2026-06-20T10:30:00Z"));
    const before = (await detail(w.c.manager, id)).transitions.length;
    expect((await transition(w.c.manager, id, { to: "AWAITING_TECHNICAL", reason: "التقييم الفني ناقص: يلزم تصوير الهيكل" })).status).toBe(200);
    const d = await detail(w.c.tech, id);
    expect(d.workflowStage).toBe("AWAITING_TECHNICAL");
    expect(d.returnedForCompletion).toMatchObject({
      stage: "AWAITING_TECHNICAL",
      reason: "التقييم الفني ناقص: يلزم تصوير الهيكل",
      returnedAt: "2026-06-20T10:30:00.000Z",
      returnedBy: { id: expect.any(String), name: expect.stringContaining("ACCIDENT_MANAGER") },
      requiredAction: { type: "USER", permission: "accidents.review.technical", userId: w.tech.id, name: expect.stringContaining("TECHNICAL") },
    });
    // nothing was lost: every earlier move is still there, plus the return with its reason
    expect(d.transitions).toHaveLength(before + 1);
    expect(d.transitions[d.transitions.length - 1]).toMatchObject({ fromStage: "CLAIM_IN_PROGRESS", toStage: "AWAITING_TECHNICAL", reason: "التقييم الفني ناقص: يلزم تصوير الهيكل" });
    expect(d.transitions.slice(0, 3).map((t: { toStage: string }) => t.toStage)).toEqual(["DRAFT", "AWAITING_TECHNICAL", "AWAITING_ESTIMATES"]);
    // visible in lists and filterable; the person who has to act is told, the person who returned it is not
    const row = (await w.c.tech.get("/api/accident-cases?returned=true")).body.data.find((r: { id: string }) => r.id === id);
    expect(row).toMatchObject({ returnedForCompletion: true, stage: "AWAITING_TECHNICAL" });
    expect(ids((await w.c.tech.get("/api/accident-cases?mine=true")).body.data)).toContain(id);
    const note = (await notesFor(w.tech.id)).find((n) => n.type === "ACCIDENT_CASE_RETURNED");
    expect(note).toMatchObject({ link: `/accidents/${id}` });
    expect((await notesFor((await db.query.users.findFirst({ where: (u, { eq }) => eq(u.email, w.manager.email) }))!.id)).map((n) => n.type)).not.toContain("ACCIDENT_CASE_RETURNED");
    // a case that was never returned has no marker and is not in the filter
    const other = await toTechnical(w);
    expect((await detail(w.c.tech, other)).returnedForCompletion).toBeNull();
    expect(ids((await w.c.tech.get("/api/accident-cases?returned=true")).body.data)).not.toContain(other);
    // the technician completes the work: the marker goes, the history stays
    expect((await w.c.tech.put(`/api/accident-cases/${id}/technical`, { damageDescription: "تلف الصدام بعد التصوير", technicalNotes: "صور مرفقة", repairDecision: "REPAIR" })).status).toBe(200);
    expect((await detail(w.c.tech, id)).returnedForCompletion).not.toBeNull(); // saving is not completing
    expect((await transition(w.c.tech, id, { to: "AWAITING_ESTIMATES" })).status).toBe(200);
    const after = await detail(w.c.pm, id);
    expect(after.returnedForCompletion).toBeNull();
    expect(after.transitions).toHaveLength(before + 2);
    expect(ids((await w.c.pm.get("/api/accident-cases?returned=true")).body.data)).not.toContain(id);
  });

  it("returned to the estimates stage the project manager is the one asked; returned with nobody designated it waits in the queue", async () => {
    const w = await world();
    const id = await toTechnical(w);
    await toInsurance(w, id);
    expect((await transition(w.c.manager, id, { to: "AWAITING_ESTIMATES", reason: "التقدير لا يشمل ضريبة القيمة المضافة" })).status).toBe(200);
    const d = await detail(w.c.pm, id);
    expect(d.returnedForCompletion).toMatchObject({ stage: "AWAITING_ESTIMATES", reason: "التقدير لا يشمل ضريبة القيمة المضافة", requiredAction: { type: "PROJECT_MANAGER", permission: "accidents.update", userId: w.pm.id } });
    expect((await notesFor(w.pm.id)).map((n) => n.type)).toContain("ACCIDENT_CASE_RETURNED");
    // the estimates already filed stay; the manager adds a corrected one and moves on
    expect(d.estimates).toHaveLength(1);
    await addEstimate(w, id, "ورشة بديلة", "2900.00");
    expect((await detail(w.c.pm, id)).estimates).toHaveLength(2);
    // nobody designated for the technician stage → back in the queue, marker says so
    const id2 = await toTechnical(w);
    await toInsurance(w, id2);
    await db.delete(accidentStageOfficers).where(eq(accidentStageOfficers.stage, "TECHNICAL"));
    expect((await transition(w.c.manager, id2, { to: "AWAITING_TECHNICAL", reason: "مراجعة الأضرار" })).status).toBe(200);
    expect((await detail(w.c.manager, id2)).returnedForCompletion).toMatchObject({ requiredAction: { type: "QUEUE", permission: "accidents.assign", userId: null } });
  });

  it("a reopened case carries the marker too, asking the closer", async () => {
    const w = await world();
    const id = await toTechnical(w);
    await toFinalClosure(w, id);
    await documentRepair(w, id);
    expect((await transition(w.c.manager, id, { to: "CLOSED", resolution: "تم الإغلاق" })).status).toBe(200);
    expect((await detail(w.c.manager, id)).returnedForCompletion).toBeNull();
    expect((await transition(w.c.manager, id, { to: "AWAITING_FINAL_CLOSURE", reason: "ظهر مستند جديد" })).status).toBe(200);
    expect((await detail(w.c.manager, id)).returnedForCompletion).toMatchObject({ stage: "AWAITING_FINAL_CLOSURE", reason: "ظهر مستند جديد", requiredAction: { type: "ROLE", permission: "accidents.close" } });
    expect((await transition(w.c.manager, id, { to: "CLOSED", resolution: "أُغلق مجددًا" })).status).toBe(200);
    expect((await detail(w.c.manager, id)).returnedForCompletion).toBeNull();
    expect((await db.select().from(accidentTransitions).where(eq(accidentTransitions.accidentId, id))).length).toBeGreaterThanOrEqual(10);
  });
});

describe("final closure requires the repair outcome, not just a finished claim", () => {
  it("a finished claim without repair documentation cannot close a repaired case; documenting it (invoice or completion proof) can", async () => {
    const w = await world();
    const id = await toTechnical(w);
    await toFinalClosure(w, id); // claim finished, decision REPAIR, nothing documented
    const r = await transition(w.c.manager, id, { to: "CLOSED", resolution: "اكتملت المطالبة" });
    expect(r.status).toBe(409);
    expect(r.body.error.details.missing).toEqual(["repair.documentation"]);
    expect((await caseOf(id)).workflowStage).toBe("AWAITING_FINAL_CLOSURE");
    // a photo or the estimate is not proof of repair
    expect((await upload(w.c.pm, id, "PHOTO")).status).toBe(201);
    expect((await transition(w.c.manager, id, { to: "CLOSED", resolution: "x" })).body.error.details.missing).toEqual(["repair.documentation"]);
    // only the people who complete the case can file it; the technician and the claims officer cannot
    for (const who of ["tech", "insurer", "viewer", "driver"] as const) expect((await upload(w.c[who], id, "REPAIR_COMPLETION")).status, who).toBe(403);
    expect((await upload(w.c.pm, id, "REPAIR_INVOICE")).status).toBe(201);
    expect((await transition(w.c.manager, id, { to: "CLOSED", resolution: "اكتملت المطالبة وتم الإصلاح" })).status).toBe(200);
    expect((await caseOf(id)).workflowStage).toBe("CLOSED");
  });

  it("a vehicle that cannot be repaired closes on the technician's explained decision, with no repair file", async () => {
    const w = await world();
    const id = await toTechnical(w);
    // an unexplained decision does not even leave the technical stage
    expect((await w.c.tech.put(`/api/accident-cases/${id}/technical`, { damageDescription: "تلف كامل", repairDecision: "NOT_REPAIRABLE" })).status).toBe(200);
    const noWhy = await transition(w.c.tech, id, { to: "AWAITING_INSURANCE" });
    expect(noWhy.status).toBe(409);
    expect(noWhy.body.error.details.missing).toEqual(["technical.notes"]);
    expect((await w.c.tech.put(`/api/accident-cases/${id}/technical`, { damageDescription: "تلف كامل", technicalNotes: "تكلفة الإصلاح تفوق قيمة المركبة", repairDecision: "NOT_REPAIRABLE" })).status).toBe(200);
    expect((await transition(w.c.tech, id, { to: "AWAITING_INSURANCE" })).status).toBe(200);
    expect((await w.c.insurer.put(`/api/accident-cases/${id}/claim`, claimBody)).status).toBe(200);
    expect((await upload(w.c.insurer, id, "INSURER_DECISION")).status).toBe(201);
    expect((await w.c.insurer.post(`/api/accident-cases/${id}/claim/status`, { status: "REJECTED", reason: "المركبة خارج التغطية" })).status).toBe(200);
    const closed = await transition(w.c.manager, id, { to: "CLOSED", resolution: "قرار فني بعدم إمكانية الإصلاح" });
    expect(closed.status, JSON.stringify(closed.body)).toBe(200);
    expect(await caseOf(id)).toMatchObject({ workflowStage: "CLOSED", repairDecision: "NOT_REPAIRABLE", repairable: false });
  });

  it("'no repair needed' is a decision too: it needs its explanation, and then closes without a repair file", async () => {
    const w = await world();
    const id = await toTechnical(w);
    expect((await w.c.tech.put(`/api/accident-cases/${id}/technical`, { damageDescription: "خدش سطحي", technicalNotes: "لا يؤثر على السلامة ولا حاجة للإصلاح", repairDecision: "NOT_NEEDED" })).status).toBe(200);
    expect((await transition(w.c.tech, id, { to: "AWAITING_ESTIMATES" })).status).toBe(409); // no estimates for a repair nobody does
    expect((await transition(w.c.tech, id, { to: "AWAITING_INSURANCE" })).status).toBe(200);
    expect((await w.c.insurer.put(`/api/accident-cases/${id}/claim`, claimBody)).status).toBe(200);
    expect((await w.c.insurer.post(`/api/accident-cases/${id}/claim/status`, { status: "APPROVED", approvedAmount: "100" })).status).toBe(200);
    expect((await upload(w.c.insurer, id, "COMPENSATION_PROOF")).status).toBe(201);
    expect((await w.c.insurer.post(`/api/accident-cases/${id}/claim/status`, { status: "COMPENSATION_RECEIVED", receivedAmount: "100" })).status).toBe(200);
    expect((await transition(w.c.manager, id, { to: "CLOSED", resolution: "تم التعويض ولا حاجة للإصلاح" })).status).toBe(200);
  });

  it("a REPAIR decision cannot be closed on the strength of an explanation alone, and a missing decision blocks closure", async () => {
    const w = await world();
    const id = await toTechnical(w);
    await toFinalClosure(w, id);
    await db.execute(sql`update accidents set technical_notes = 'ملاحظات طويلة' where id = ${id}`);
    expect((await transition(w.c.manager, id, { to: "CLOSED", resolution: "x" })).body.error.details.missing).toEqual(["repair.documentation"]);
    await db.execute(sql`update accidents set repair_decision = null where id = ${id}`);
    expect((await transition(w.c.manager, id, { to: "CLOSED", resolution: "x" })).body.error.details.missing).toEqual(["repair.decision"]);
  });
});

describe("preliminary reports and drafts: who may see and complete them", () => {
  it("the project's manager completes a driver's report; managers of other projects see nothing of it", async () => {
    const w = await world();
    const memberPm = await createUser(["PROJECT_MANAGER"]);
    const project2 = await createProject({ managerId: memberPm.id });
    void project2;
    const r = await w.c.driver.post("/api/accident-cases", draftBody(w.vehicle.id));
    expect(r.status).toBe(201);
    const id = r.body.data.id as string;
    await upload(w.c.driver, id, "DRIVER_ID");
    // the right project manager is told and finds it among the drafts, marked as a preliminary report
    expect((await notesFor(w.pm.id)).map((n) => n.type)).toContain("ACCIDENT_CASE_DRAFT");
    const mine = (await w.c.pm.get("/api/accident-cases?stage=DRAFT")).body.data as { id: string; preliminary: boolean }[];
    expect(mine.find((x) => x.id === id)).toMatchObject({ preliminary: true });
    // other projects' managers: no list entry, no detail, no legacy view, no timeline event, no action, no notification
    const other = w.c.otherPm;
    expect(ids((await other.get("/api/accident-cases?stage=DRAFT")).body.data)).not.toContain(id);
    expect(ids((await other.get("/api/accident-cases")).body.data)).not.toContain(id);
    expect(ids((await other.get("/api/accidents")).body.data)).not.toContain(id);
    for (const [label, res] of [
      ["detail", await other.get(`/api/accident-cases/${id}`)],
      ["legacy detail", await other.get(`/api/accidents/${id}`)],
      ["patch", await other.patch(`/api/accident-cases/${id}`, { description: "محاولة تعديل" })],
      ["upload", await upload(other, id, "NAJM_REPORT")],
      ["submit", await other.post(`/api/accident-cases/${id}/submit`)],
      ["transition", await transition(other, id, { to: "AWAITING_TECHNICAL" })],
      ["technical", await other.put(`/api/accident-cases/${id}/technical`, { damageDescription: "ضرر", repairDecision: "REPAIR" })],
    ] as const) expect(res.status, label).toBe(404);
    expect(((await other.get(`/api/vehicles/${w.vehicle.id}/timeline`)).body.data ?? []).map((e: { action: string }) => e.action)).not.toContain("ACCIDENT_CASE_CREATED");
    const otherUser = await db.query.users.findFirst({ where: (u, { eq: e }) => e(u.email, w.otherPm.email) });
    expect((await notesFor(otherUser!.id)).map((n) => n.type)).not.toContain("ACCIDENT_CASE_DRAFT");
    // nor do the other roles of the project, nor an unrelated driver
    for (const who of ["tech", "viewer", "finance", "insurer"] as const) expect((await w.c[who].get(`/api/accident-cases/${id}`)).status, who).toBe(404);
    // the project manager completes it
    expect((await w.c.pm.patch(`/api/accident-cases/${id}`, { policeReportNumber: "PR-2026-1", location: "طريق الدمام" })).status).toBe(200);
    for (const cat of ["NAJM_REPORT", "DRIVER_LICENSE", "VEHICLE_REGISTRATION"]) expect((await upload(w.c.pm, id, cat)).status).toBe(201);
    expect((await w.c.pm.post(`/api/accident-cases/${id}/submit`)).status).toBe(200);
  });

  it("a project manager who is only a member of the project can complete it too; a PM member of another project cannot", async () => {
    const w = await world();
    const memberPm = await createUser(["PROJECT_MANAGER"]);
    const { projectUsers } = await import("../src/db/schema/index.js");
    await db.insert(projectUsers).values({ projectId: w.project.id, userId: memberPm.id });
    const mc = await login(memberPm.email);
    const id = (await w.c.driver.post("/api/accident-cases", draftBody(w.vehicle.id))).body.data.id as string;
    expect((await mc.get(`/api/accident-cases/${id}`)).status).toBe(200);
    expect((await mc.patch(`/api/accident-cases/${id}`, { severity: "SEVERE" })).status).toBe(200);
    expect((await w.c.otherPm.patch(`/api/accident-cases/${id}`, { severity: "MINOR" })).status).toBe(404);
  });
});

describe("the legacy-file switch is separate from the workflow switch", () => {
  const legacyCase = async (w: W) => {
    const leg = (await w.c.pm.post("/api/accidents", { vehicleId: w.vehicle.id, occurredAt: "2026-06-14T10:00:00+03:00", description: "حادث بالمسار القديم", severity: "MINOR" })).body.data.id as string;
    const pr = (await w.c.pm.upload(`/api/accidents/${leg}/attachments?category=POLICE_REPORT`, PDF_BYTES, "application/pdf", "post")).body.data.id as string;
    const ins = (await w.c.pm.upload(`/api/accidents/${leg}/attachments?category=INSURANCE`, PDF_BYTES, "application/pdf", "post")).body.data.id as string;
    return { leg, pr, ins };
  };
  const file = (c: Client, id: string) => c.get(`/api/accident-attachments/${id}/file`);

  it("both default to off in the configuration", () => {
    expect(config.ACCIDENT_WORKFLOW_ENABLED).toBe(false);
    expect(config.ACCIDENT_LEGACY_SENSITIVE_ENFORCEMENT).toBe(false);
  });

  it("workflow on, legacy switch off: legacy accidents show their files exactly as before, workflow cases stay protected", async () => {
    const w = await world();
    const k = await legacyCase(w);
    setLegacySensitiveEnforcementFlag(null);
    for (const who of ["finance", "viewer", "pm"] as const) {
      expect((await file(w.c[who], k.pr)).status, `${who} police`).toBe(200);
      expect((await file(w.c[who], k.ins)).status, `${who} insurance`).toBe(200);
    }
    expect((await w.c.finance.get(`/api/accidents/${k.leg}`)).body.data.attachments).toHaveLength(2);
    expect(JSON.stringify((await w.c.finance.get(`/api/accidents/${k.leg}`)).body.data.timeline)).toContain("POLICE_REPORT");
    // a workflow case on the same server is protected regardless
    const id = await toTechnical(w);
    const police = (await upload(w.c.pm, id, "POLICE_REPORT")).body.data.id as string;
    expect((await w.c.viewer.get(`/api/accident-cases/${id}/attachments/${police}/file`)).status).toBe(404);
    expect((await file(w.c.viewer, police)).status).toBe(404);
  });

  it("legacy switch on: finance and viewers lose the legacy police/insurance files, the project manager keeps them; it works with the workflow off too", async () => {
    const w = await world();
    const k = await legacyCase(w);
    setLegacySensitiveEnforcementFlag(true);
    try {
      for (const who of ["finance", "viewer"] as const) {
        expect((await file(w.c[who], k.pr)).status, who).toBe(404);
        expect((await w.c[who].get(`/api/accidents/${k.leg}`)).body.data.attachments).toHaveLength(0);
      }
      expect((await file(w.c.pm, k.pr)).status).toBe(200);
      setAccidentWorkflowFlag(false);
      expect((await file(w.c.finance, k.pr)).status).toBe(404); // independent of the workflow switch
      expect((await file(w.c.pm, k.ins)).status).toBe(200);
    } finally {
      setAccidentWorkflowFlag(true);
      setLegacySensitiveEnforcementFlag(null);
    }
  });
});

describe("granting the project manager the sensitive-document permission (targeted, not bootstrap)", () => {
  const cli = (args: string[], env: Record<string, string> = {}) => {
    try {
      return { code: 0, out: execFileSync("npx", ["tsx", "src/scripts/sync-accident-catalog.ts", ...args], { env: { ...process.env, DATABASE_URL: process.env.TEST_DATABASE_URL, ...env }, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }) };
    } catch (e) {
      const x = e as { status: number; stdout: string; stderr: string };
      return { code: x.status, out: `${x.stdout}${x.stderr}` };
    }
  };
  const hashOf = (out: string) => /PLAN HASH: (\w+)/.exec(out)![1]!;
  const grantRows = async (exceptKey: string) => JSON.stringify((await db.execute(sql`select r.key as r, p.key as p, rp.scope as s from role_permissions rp join roles r on r.id = rp.role_id join permissions p on p.id = rp.permission_id where not (r.key = ${exceptKey} and p.key = 'accidents.documents.sensitive') order by 1, 2`)).rows);
  const setGrant = async (role: string, perm: string, scope: "ALL" | "PROJECT" | "ASSIGNED" | null) => {
    const [r] = await db.select({ id: roles.id }).from(roles).where(and(eq(roles.key, role), isNull(roles.organizationId)));
    const [p] = await db.select({ id: permissions.id }).from(permissions).where(eq(permissions.key, perm));
    await db.delete(rolePermissions).where(and(eq(rolePermissions.roleId, r!.id), eq(rolePermissions.permissionId, p!.id)));
    if (scope) await db.insert(rolePermissions).values({ roleId: r!.id, permissionId: p!.id, scope });
  };

  it("planner and scope guard: the flag adds exactly one PROJECT_MANAGER grant; without it PROJECT_MANAGER is never named", async () => {
    await setGrant("PROJECT_MANAGER", "accidents.documents.sensitive", null);
    try {
      const state = await readCatalogState(db);
      const plain = planAccidentCatalog(state);
      expect(plain.grantsToAdd.some((g) => g.role === "PROJECT_MANAGER")).toBe(false);
      const withPm = planAccidentCatalog(state, { includeProjectManagerSensitive: true });
      expect(withPm.grantsToAdd.filter((g) => g.role === "PROJECT_MANAGER")).toEqual([{ role: "PROJECT_MANAGER", permission: "accidents.documents.sensitive", scope: "PROJECT" }]);
      expect(withPm.hash).not.toBe(plain.hash);
      assertPlanScope(withPm);
      // forged plans: PM without the flag, another permission, another scope, another role
      expect(() => assertPlanScope({ ...plain, grantsToAdd: withPm.grantsToAdd })).toThrow(/never changes/);
      expect(() => assertPlanScope({ ...withPm, grantsToAdd: [{ role: "PROJECT_MANAGER", permission: "finance.read", scope: "PROJECT" }] })).toThrow();
      expect(() => assertPlanScope({ ...withPm, grantsToAdd: [{ role: "PROJECT_MANAGER", permission: "accidents.documents.sensitive", scope: "ALL" }] })).toThrow();
      expect(() => assertPlanScope({ ...withPm, grantsToAdd: [{ role: "FINANCE", permission: "accidents.documents.sensitive", scope: "ALL" }] })).toThrow();
      // a PM that already holds it (any scope) is reported, not changed
      await setGrant("PROJECT_MANAGER", "accidents.documents.sensitive", "ALL");
      const held = planAccidentCatalog(await readCatalogState(db), { includeProjectManagerSensitive: true });
      expect(held.grantsToAdd.some((g) => g.role === "PROJECT_MANAGER")).toBe(false);
      expect(held.leftAsIs.join("\n")).toContain("PROJECT_MANAGER: accidents.documents.sensitive is ALL");
    } finally {
      await db.transaction((tx) => syncCatalog(tx));
    }
  });

  it("end to end: before the grant the PM cannot see the driver's ID; after the approved targeted grant they can; other projects' managers still cannot; no other PM grant moved", async () => {
    const w = await world();
    const id = (await w.c.driver.post("/api/accident-cases", draftBody(w.vehicle.id))).body.data.id as string;
    const idDoc = (await upload(w.c.driver, id, "DRIVER_ID", "driver-id-5151.pdf")).body.data.id as string;
    // production-like: PM lacks the permission and carries pending differences from the code
    await setGrant("PROJECT_MANAGER", "accidents.documents.sensitive", null);
    await setGrant("PROJECT_MANAGER", "finance.read", "PROJECT");
    await setGrant("PROJECT_MANAGER", "vendors.manage", "ALL");
    try {
      const file = (c: Client) => c.get(`/api/accident-cases/${id}/attachments/${idDoc}/file`);
      const cats = async (c: Client) => ((await detail(c, id)).attachments as { category: string }[]).map((a) => a.category);
      const pmLogin = await login((await db.query.users.findFirst({ where: (u, { eq: e }) => e(u.id, w.pm.id) }))!.email); // fresh session: permissions are read per request
      expect((await file(pmLogin)).status).toBe(404);
      expect(await cats(pmLogin)).not.toContain("DRIVER_ID");
      const othersBefore = await grantRows("PROJECT_MANAGER");
      const pmBefore = JSON.stringify((await readCatalogState(db)).roles.find((r) => r.key === "PROJECT_MANAGER")!.grants);
      // preview: nothing written, the plan names the one PM grant and says the pending differences are not applied
      const preview = cli(["--include-project-manager-sensitive"]);
      expect(preview.code).toBe(0);
      expect(preview.out).toContain("+ PROJECT_MANAGER: accidents.documents.sensitive (PROJECT)");
      expect(preview.out).toContain("pending differences are NOT applied");
      expect(await grantRows("PROJECT_MANAGER")).toBe(othersBefore);
      expect((await file(pmLogin)).status).toBe(404);
      const hash = hashOf(preview.out);
      // refused without confirmation, with the plain plan's hash, or without the flag
      expect(cli(["--apply", "--include-project-manager-sensitive", `--plan-hash=${hash}`]).code).toBe(2);
      expect(cli(["--apply", "--include-project-manager-sensitive", `--plan-hash=${hashOf(cli([]).out)}`], { EF_CONFIRM_ACCIDENT_CATALOG: "yes" }).code).toBe(2);
      expect((await file(pmLogin)).status).toBe(404);
      // approved
      const applied = cli(["--apply", "--include-project-manager-sensitive", `--plan-hash=${hash}`], { EF_CONFIRM_ACCIDENT_CATALOG: "yes" });
      expect(applied.code, applied.out).toBe(0);
      const state = (await readCatalogState(db)).roles.find((r) => r.key === "PROJECT_MANAGER")!.grants;
      expect(state["accidents.documents.sensitive"]).toBe("PROJECT");
      const { "accidents.documents.sensitive": _added, ...rest } = state;
      expect(JSON.stringify(rest)).toBe(pmBefore); // every other PM grant, pending differences included, is byte-identical
      expect(state["finance.read"]).toBe("PROJECT");
      expect(state["vendors.manage"]).toBe("ALL");
      expect(await grantRows("PROJECT_MANAGER")).toBe(othersBefore); // no other role moved
      expect((await file(pmLogin)).status).toBe(200);
      expect(await cats(pmLogin)).toContain("DRIVER_ID");
      // still limited to their project: another project's manager (who now holds the same grant) sees nothing of it
      expect((await file(w.c.otherPm)).status).toBe(404);
      expect((await w.c.otherPm.get(`/api/accident-cases/${id}`)).status).toBe(404);
      // idempotent
      expect(cli(["--apply", "--include-project-manager-sensitive", `--plan-hash=${hashOf(cli(["--include-project-manager-sensitive"]).out)}`], { EF_CONFIRM_ACCIDENT_CATALOG: "yes" }).out).toContain("Nothing to do");
    } finally {
      await db.transaction((tx) => syncCatalog(tx));
    }
  }, 180_000);
});

describe("the new notifications open the existing accidents screen", () => {
  it("every link points at /accidents/:id (the Accidents section), never at a separate accident-cases screen", async () => {
    const w = await world();
    const id = await toTechnical(w);
    await toClaim(w, id);
    await transition(w.c.manager, id, { to: "AWAITING_TECHNICAL", reason: "نقص" });
    const all = await db.select().from(notifications);
    const mine = all.filter((n) => n.entityId === id);
    expect(mine.length).toBeGreaterThan(0);
    for (const n of mine) expect(n.link, n.type).toBe(`/accidents/${id}`);
    expect(all.some((n) => n.link?.startsWith("/accident-cases"))).toBe(false);
  });
});
void uploadRequired;
void newDraft;
void createVehicle;
