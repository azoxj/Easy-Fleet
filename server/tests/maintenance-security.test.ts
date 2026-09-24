import { eq } from "drizzle-orm";
import request from "supertest";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { db } from "../src/db/client.js";
import { assignments, maintenanceAttachments, maintenanceQuotes, maintenanceRequests, notifications } from "../src/db/schema/index.js";
import { setClock } from "../src/lib/clock.js";
import { ACTIONS, type ActionKey, type MaintenanceStatus } from "../src/modules/maintenance/workflow.js";
import { app, createMaintenance, createProject, createUser, createVehicle, defaultOrgId, login, PDF_BYTES, userAndClient } from "./helpers.js";

beforeEach(() => setClock(new Date("2026-06-15T09:00:00Z")));
afterEach(() => setClock(null));

/** Two isolated projects with their own PM, technician, vehicle and maintenance request. */
async function world() {
  const pmA = await createUser(["PROJECT_MANAGER"]);
  const pmB = await createUser(["PROJECT_MANAGER"]);
  const techA = await createUser(["TECHNICAL"]);
  const techA2 = await createUser(["TECHNICAL"]);
  const techB = await createUser(["TECHNICAL"]);
  const viewerA = await createUser(["VIEWER"]);
  const pA = await createProject({ managerId: pmA.id, members: [techA.id, techA2.id, viewerA.id] });
  const pB = await createProject({ managerId: pmB.id, members: [techB.id] });
  const vA = await createVehicle(pA.id);
  const vB = await createVehicle(pB.id);
  const mrA = await createMaintenance(vA, pmA.id, { assignedTo: techA.id });
  const mrB = await createMaintenance(vB, pmB.id, { assignedTo: techB.id, status: "PENDING_APPROVAL" });
  return { pmA, pmB, techA, techA2, techB, viewerA, pA, pB, vA, vB, mrA, mrB, a: await login(pmA.email), b: await login(pmB.email) };
}

describe("1/4/5/6 — cross-project access, update and approval (IDOR on maintenance)", () => {
  it("PM of A sees and edits A, but gets 404 for everything on B", async () => {
    const { a, mrA, mrB } = await world();
    expect((await a.get(`/api/maintenance/${mrA.id}`)).status).toBe(200);
    expect((await a.patch(`/api/maintenance/${mrA.id}`, { notes: "ملاحظة" })).status).toBe(200);
    const ids = (await a.get("/api/maintenance?pageSize=100")).body.data.map((r: { id: string }) => r.id);
    expect(ids).toContain(mrA.id);
    expect(ids).not.toContain(mrB.id);
    expect((await a.get(`/api/maintenance?projectId=${mrB.projectId}`)).body.data).toHaveLength(0);
    for (const [method, path, body] of [
      ["get", `/api/maintenance/${mrB.id}`, undefined],
      ["patch", `/api/maintenance/${mrB.id}`, { notes: "x" }],
      ["post", `/api/maintenance/${mrB.id}/approve`, undefined],
      ["post", `/api/maintenance/${mrB.id}/reject`, { reason: "اختراق" }],
      ["post", `/api/maintenance/${mrB.id}/assign`, { technicianId: mrB.assignedTo }],
      ["get", `/api/maintenance/${mrB.id}/quotes`, undefined],
      ["get", `/api/maintenance/${mrB.id}/parts`, undefined],
      ["post", `/api/maintenance/${mrB.id}/parts`, { partName: "قطعة", quantity: 1, unitPrice: 1 }],
      ["get", `/api/maintenance/${mrB.id}/technicians`, undefined],
    ] as const) {
      const r = method === "get" ? await a.get(path) : method === "patch" ? await a.patch(path, body) : await a.post(path, body);
      expect(r.status, `${method} ${path}`).toBe(404);
    }
    const [row] = await db.select().from(maintenanceRequests).where(eq(maintenanceRequests.id, mrB.id));
    expect(row!.status).toBe("PENDING_APPROVAL");
    expect(row!.notes).toBeNull();
  });

  it("invalid and unknown ids", async () => {
    const { a } = await world();
    expect((await a.get("/api/maintenance/abc")).status).toBe(400);
    expect((await a.get("/api/maintenance/00000000-0000-4000-8000-000000000000")).status).toBe(404);
    expect((await a.post("/api/maintenance/00000000-0000-4000-8000-000000000000/approve")).status).toBe(404);
    expect((await request(app).get("/api/maintenance")).status).toBe(401);
  });
});

describe("2 — IDOR on quotes", () => {
  it("quotes of another project cannot be read, submitted, approved, rejected or downloaded", async () => {
    const { a, pmB, mrB } = await world();
    const orgId = await defaultOrgId();
    const [q] = await db.insert(maintenanceQuotes).values({ organizationId: orgId, maintenanceRequestId: mrB.id, amount: "500", status: "SUBMITTED", createdBy: pmB.id }).returning();
    const { client: finance } = await userAndClient(["FINANCE"]);
    for (const path of ["submit", "review", "approve"]) expect((await a.post(`/api/maintenance-quotes/${q!.id}/${path}`)).status, path).toBeOneOf([403, 404]);
    expect((await a.post(`/api/maintenance-quotes/${q!.id}/submit`)).status).toBe(404); // PM holds quote.create but B is out of scope
    expect((await a.patch(`/api/maintenance-quotes/${q!.id}`, { amount: "1" })).status).toBe(404);
    expect((await a.get(`/api/maintenance-quotes/${q!.id}/file`)).status).toBe(404);
    // FINANCE has ALL scope: allowed (legitimate), proving the check is scope-based, not role-based
    expect((await finance.post(`/api/maintenance-quotes/${q!.id}/review`)).status).toBe(200);
  });
});

describe("3/16 — IDOR on attachments & attachment access bypass", () => {
  it("files are downloadable only inside the request's scope", async () => {
    const { mrA, techA, techA2, pmB, viewerA } = await world();
    const tc = await login(techA.email);
    const up = await tc.agent.post(`/api/maintenance/${mrA.id}/attachments?category=INSPECTION_REPORT`).set("X-CSRF-Token", tc.csrf).set("Content-Type", "application/pdf").send(PDF_BYTES);
    expect(up.status).toBe(201);
    const url = `/api/maintenance-attachments/${up.body.data.id}/file`;
    expect((await request(app).get(url)).status).toBe(401);
    expect((await (await login(pmB.email)).get(url)).status).toBe(404); // other project
    expect((await (await login(techA2.email)).get(url)).status).toBe(404); // same project, not assigned (ASSIGNED scope)
    expect((await (await login(viewerA.email)).get(url)).status).toBe(200); // VIEWER has maintenance.read PROJECT
    const { client: driver } = await userAndClient(["DRIVER"]);
    expect((await driver.get(url)).status).toBe(403); // no maintenance.read at all
    // Uploading onto another project's request fails
    const b = await login(pmB.email);
    expect((await b.agent.post(`/api/maintenance/${mrA.id}/attachments`).set("X-CSRF-Token", b.csrf).set("Content-Type", "application/pdf").send(PDF_BYTES)).status).toBe(404);
    const rows = await db.select().from(maintenanceAttachments).where(eq(maintenanceAttachments.maintenanceRequestId, mrA.id));
    expect(rows).toHaveLength(1);
  });
});

describe("7 — unauthorized assignment", () => {
  it("only maintenance.assign holders can assign, and only eligible technicians", async () => {
    const { a, mrA, techA, techA2, techB, viewerA } = await world();
    const tc = await login(techA.email);
    expect((await tc.post(`/api/maintenance/${mrA.id}/assign`, { technicianId: techA2.id })).status).toBe(403);
    expect((await a.post(`/api/maintenance/${mrA.id}/assign`, { technicianId: viewerA.id })).status).toBe(400); // no maintenance.update
    expect((await a.post(`/api/maintenance/${mrA.id}/assign`, { technicianId: techB.id })).status).toBe(400); // not in project A
    const cands = (await a.get(`/api/maintenance/${mrA.id}/technicians`)).body.data.map((u: { id: string }) => u.id);
    expect(cands).toContain(techA2.id);
    expect(cands).not.toContain(techB.id);
    expect(cands).not.toContain(viewerA.id);
    expect((await a.post(`/api/maintenance/${mrA.id}/assign`, { technicianId: techA2.id })).status).toBe(200);
  });
});

describe("8/9/10 — unauthorized quote approval, rejection and closing", () => {
  it("rejects callers without the specific permission even inside the project", async () => {
    const { a, mrA, techA, viewerA, pmA } = await world();
    const orgId = await defaultOrgId();
    await db.update(maintenanceRequests).set({ status: "PENDING_APPROVAL" }).where(eq(maintenanceRequests.id, mrA.id));
    const [q] = await db.insert(maintenanceQuotes).values({ organizationId: orgId, maintenanceRequestId: mrA.id, amount: "100", status: "SUBMITTED", createdBy: pmA.id }).returning();
    const tc = await login(techA.email);
    const vc = await login(viewerA.email);
    expect((await a.post(`/api/maintenance-quotes/${q!.id}/approve`)).status).toBe(403); // PM: no quote.approve
    expect((await tc.post(`/api/maintenance-quotes/${q!.id}/approve`)).status).toBe(403);
    expect((await tc.post(`/api/maintenance-quotes/${q!.id}/reject`, { reason: "لا" })).status).toBe(403);
    expect((await vc.post(`/api/maintenance/${mrA.id}/reject`, { reason: "رفض" })).status).toBe(403);
    expect((await tc.post(`/api/maintenance/${mrA.id}/reject`, { reason: "رفض" })).status).toBe(403);
    await db.update(maintenanceRequests).set({ status: "ACCEPTED" }).where(eq(maintenanceRequests.id, mrA.id));
    expect((await tc.post(`/api/maintenance/${mrA.id}/close`)).status).toBe(403);
    expect((await vc.post(`/api/maintenance/${mrA.id}/close`)).status).toBe(403);
    expect((await a.post(`/api/maintenance/${mrA.id}/close`)).status).toBe(200);
  });
});

describe("11 — direct status manipulation", () => {
  it("no endpoint accepts a status or approval flag from the client", async () => {
    const { a, mrA, pmA } = await world();
    const orgId = await defaultOrgId();
    expect((await a.patch(`/api/maintenance/${mrA.id}`, { status: "CLOSED" })).status).toBe(400);
    expect((await a.patch(`/api/maintenance/${mrA.id}`, { assignedTo: pmA.id })).status).toBe(400);
    expect((await a.patch(`/api/maintenance/${mrA.id}`, { completedAt: new Date().toISOString() })).status).toBe(400);
    expect((await a.post(`/api/maintenance/${mrA.id}/start-inspection`, { status: "CLOSED" })).status).toBe(400);
    expect((await a.post("/api/maintenance", { vehicleId: mrA.vehicleId, issue: "عطل جديد", priority: "LOW", status: "APPROVED" })).status).toBe(400);
    await db.update(maintenanceRequests).set({ status: "QUOTE_PENDING" }).where(eq(maintenanceRequests.id, mrA.id));
    expect((await a.post(`/api/maintenance/${mrA.id}/quotes`, { amount: "10", status: "APPROVED" })).status).toBe(400);
    expect((await a.post(`/api/maintenance/${mrA.id}/quotes`, { amount: "10", approved: true })).status).toBe(400);
    const [q] = await db.insert(maintenanceQuotes).values({ organizationId: orgId, maintenanceRequestId: mrA.id, amount: "10", createdBy: pmA.id }).returning();
    expect((await a.patch(`/api/maintenance-quotes/${q!.id}`, { status: "APPROVED" })).status).toBe(400);
    const [row] = await db.select().from(maintenanceRequests).where(eq(maintenanceRequests.id, mrA.id));
    expect(row!.status).toBe("QUOTE_PENDING");
  });
});

describe("12/13 — projectId and vehicleId spoofing", () => {
  it("project always comes from the vehicle; foreign vehicles are invisible", async () => {
    const { a, vA, vB, pB, mrA } = await world();
    expect((await a.post("/api/maintenance", { vehicleId: vA.id, projectId: pB.id, issue: "عطل كهربائي", priority: "LOW" })).status).toBe(400);
    expect((await a.post("/api/maintenance", { vehicleId: vB.id, issue: "عطل كهربائي", priority: "LOW" })).status).toBe(404);
    const ok = await a.post("/api/maintenance", { vehicleId: vA.id, issue: "عطل كهربائي", priority: "LOW" });
    expect(ok.body.data.projectId).toBe(vA.projectId);
    expect((await a.patch(`/api/maintenance/${mrA.id}`, { projectId: pB.id })).status).toBe(400);
    expect((await a.patch(`/api/maintenance/${mrA.id}`, { vehicleId: vB.id })).status).toBe(400);
    const [row] = await db.select().from(maintenanceRequests).where(eq(maintenanceRequests.id, mrA.id));
    expect(row!.projectId).toBe(vA.projectId);
    expect(row!.vehicleId).toBe(vA.id);
    // a VIEWER (no maintenance.create) cannot create at all
    const { client: viewer } = await userAndClient(["VIEWER"]);
    expect((await viewer.post("/api/maintenance", { vehicleId: vA.id, issue: "عطل كهربائي", priority: "LOW" })).status).toBe(403);
  });
});

describe("14 — assignment scope", () => {
  it("ASSIGNED-scoped technicians only reach their own requests", async () => {
    const { mrA, techA, techA2, vA, pmA } = await world();
    const other = await createMaintenance(vA, pmA.id); // same project, unassigned
    const t1 = await login(techA.email);
    const t2 = await login(techA2.email);
    expect((await t1.get(`/api/maintenance/${mrA.id}`)).status).toBe(200);
    expect((await t1.get(`/api/maintenance/${other.id}`)).status).toBe(404);
    expect((await t1.post(`/api/maintenance/${other.id}/start-inspection`)).status).toBe(404);
    expect((await t2.get(`/api/maintenance/${mrA.id}`)).status).toBe(404);
    expect((await t2.get("/api/maintenance?pageSize=100")).body.data).toHaveLength(0);
  });

  it("an Assignment record widens the record set only for users whose role has the permission", async () => {
    const { mrA, techA2, pmA, pA } = await world();
    const orgId = await defaultOrgId();
    // TECHNICAL (maintenance.read ASSIGNED) + MAINTENANCE_REQUEST assignment → can read
    await db.insert(assignments).values({ organizationId: orgId, type: "MAINTENANCE_REQUEST", assignedTo: techA2.id, assignedBy: pmA.id, projectId: pA.id, referenceId: mrA.id, title: "مساعدة" });
    expect((await (await login(techA2.email)).get(`/api/maintenance/${mrA.id}`)).status).toBe(200);
    // DRIVER (no maintenance permission) + the same kind of assignment → still forbidden
    const driver = await createUser(["DRIVER"]);
    await db.insert(assignments).values({ organizationId: orgId, type: "MAINTENANCE_REQUEST", assignedTo: driver.id, assignedBy: pmA.id, projectId: pA.id, referenceId: mrA.id, title: "مساعدة" });
    const dc = await login(driver.email);
    expect((await dc.get(`/api/maintenance/${mrA.id}`)).status).toBe(403);
    expect((await dc.get("/api/maintenance")).status).toBe(403);
  });

  it("a PROJECT-scoped manager assigned to another project's request may read it but not approve it", async () => {
    const { pmA, mrB, pB, pmB } = await world();
    const orgId = await defaultOrgId();
    await db.insert(assignments).values({ organizationId: orgId, type: "MAINTENANCE_REQUEST", assignedTo: pmA.id, assignedBy: pmB.id, projectId: pB.id, referenceId: mrB.id, title: "استشارة" });
    const a = await login(pmA.email);
    expect((await a.get(`/api/maintenance/${mrB.id}`)).status).toBe(200);
    expect((await a.post(`/api/maintenance/${mrB.id}/approve`)).status).toBe(403);
    expect((await a.post(`/api/maintenance/${mrB.id}/reject`, { reason: "رفض" })).status).toBe(403);
  });

  it("assignments API creates MAINTENANCE_REQUEST assignments only within scope", async () => {
    const { a, mrA, mrB, techA2, techB } = await world();
    expect((await a.post("/api/assignments", { type: "MAINTENANCE_REQUEST", referenceId: mrA.id, assignedTo: techA2.id, title: "مساعدة فنية" })).status).toBe(201);
    expect((await a.post("/api/assignments", { type: "MAINTENANCE_REQUEST", referenceId: mrB.id, assignedTo: techB.id, title: "مساعدة فنية" })).status).toBe(404);
  });
});

describe("15 — notification leakage", () => {
  it("events of project A never notify project B users or unassigned technicians", async () => {
    const { a, vA, techA, techA2, pmB, techB } = await world();
    const { user: fin } = await userAndClient(["FINANCE"]);
    const c = await a.post("/api/maintenance", { vehicleId: vA.id, issue: "عطل التكييف", priority: "CRITICAL" });
    const id = c.body.data.id;
    await a.post(`/api/maintenance/${id}/assign`, { technicianId: techA.id });
    await a.post(`/api/maintenance/${id}/start-inspection`);
    await a.patch(`/api/maintenance/${id}`, { diagnosis: "ضاغط التكييف" });
    await a.post(`/api/maintenance/${id}/complete-inspection`);
    const q = await a.post(`/api/maintenance/${id}/quotes`, { amount: "900" });
    await a.post(`/api/maintenance-quotes/${q.body.data.id}/submit`);
    const count = async (uid: string) => (await db.select().from(notifications).where(eq(notifications.userId, uid))).filter((n) => n.entityId === id).length;
    expect(await count(techA.id)).toBeGreaterThan(0);
    expect(await count(fin.id)).toBeGreaterThan(0); // quote review
    expect(await count(pmB.id)).toBe(0);
    expect(await count(techB.id)).toBe(0);
    expect(await count(techA2.id)).toBe(0);
    // notification links point to the in-app detail page only
    const [n] = await db.select().from(notifications).where(eq(notifications.userId, techA.id));
    expect(n!.link).toBe(`/maintenance/${id}`);
  });
});

describe("21 — invalid workflow transitions", () => {
  const PATHS: Record<ActionKey, string> = {
    startInspection: "start-inspection",
    completeInspection: "complete-inspection",
    approve: "approve",
    reject: "reject",
    startRepair: "start-repair",
    markReady: "mark-ready",
    acceptHandover: "accept-handover",
    rejectHandover: "reject-handover",
    close: "close",
  };
  const STATUSES: MaintenanceStatus[] = ["REQUESTED", "INSPECTION", "QUOTE_PENDING", "PENDING_APPROVAL", "APPROVED", "IN_REPAIR", "READY_FOR_HANDOVER", "ACCEPTED", "REJECTED", "CLOSED"];

  it("the named forbidden transitions return 409 and change nothing", async () => {
    const { client } = await userAndClient(["SUPER_ADMIN"]);
    const pm = await createUser(["PROJECT_MANAGER"]);
    const v = await createVehicle((await createProject({ managerId: pm.id })).id);
    const cases: [MaintenanceStatus, ActionKey][] = [
      ["REQUESTED", "close"],
      ["REQUESTED", "acceptHandover"],
      ["CLOSED", "startRepair"],
      ["CLOSED", "rejectHandover"],
      ["CLOSED", "approve"],
      ["READY_FOR_HANDOVER", "approve"],
      ["REJECTED", "close"],
      ["REJECTED", "acceptHandover"],
    ];
    for (const [status, action] of cases) {
      const mr = await createMaintenance(v, pm.id, { status });
      const r = await client.post(`/api/maintenance/${mr.id}/${PATHS[action]}`, ACTIONS[action].requiresReason ? { reason: "سبب الاختبار" } : undefined);
      expect(r.status, `${status} → ${action}`).toBe(409);
      expect(r.body.error.code).toBe("INVALID_TRANSITION");
      const [row] = await db.select().from(maintenanceRequests).where(eq(maintenanceRequests.id, mr.id));
      expect(row!.status).toBe(status);
    }
  });

  it("full matrix: every (status, action) pair outside the state machine is refused", async () => {
    const { client } = await userAndClient(["SUPER_ADMIN"]);
    const pm = await createUser(["PROJECT_MANAGER"]);
    const v = await createVehicle((await createProject({ managerId: pm.id })).id);
    let refused = 0;
    for (const status of STATUSES) {
      for (const action of Object.keys(ACTIONS) as ActionKey[]) {
        if (ACTIONS[action].from.includes(status)) continue;
        const mr = await createMaintenance(v, pm.id, { status });
        const r = await client.post(`/api/maintenance/${mr.id}/${PATHS[action]}`, ACTIONS[action].requiresReason ? { reason: "سبب الاختبار" } : undefined);
        expect(r.status, `${status} → ${action}`).toBe(409);
        refused++;
      }
    }
    expect(refused).toBeGreaterThan(70);
  });
});
