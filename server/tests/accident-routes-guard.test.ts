import { afterAll, beforeAll, describe, expect, it } from "vitest";
import request from "supertest";
import { setAccidentWorkflowFlag } from "../src/lib/feature-flags.js";
import { accidentFeaturesRouter } from "../src/modules/accidents/features.js";
import { accidentCasesRouter } from "../src/modules/accidents/routes.js";
import { accidentsRouter } from "../src/modules/operations/accidents.js";
import { app, createUser, login, PDF_BYTES, type Client } from "./helpers.js";
import { draftBody, toTechnical, upload, world, type W } from "./support/accident-world.js";

beforeAll(() => setAccidentWorkflowFlag(true));
afterAll(() => setAccidentWorkflowFlag(null));

type Layer = { route?: { path: string; methods: Record<string, boolean> } };
const routesOf = (r: unknown) => ((r as { stack: Layer[] }).stack.filter((l) => l.route).flatMap((l) => Object.keys(l.route!.methods).filter((m) => l.route!.methods[m]).map((m) => `${m.toUpperCase()} ${l.route!.path}`)));
const ALL_ROUTES = [...routesOf(accidentsRouter), ...routesOf(accidentCasesRouter), ...routesOf(accidentFeaturesRouter)].sort();

type Ctx = { case: string; att: string; est: string; officer: string; uuid: string };
type Call = (c: Client, x: Ctx) => Promise<{ status: number }>;
const b = (c: Client, method: "post" | "put" | "patch" | "delete", url: string, body?: object) => (method === "delete" ? c.delete(url) : c[method](url, body ?? {}));
const up = (c: Client, url: string) => c.agent.post(url).set("X-CSRF-Token", c.csrf).set("Content-Type", "application/pdf").set("X-File-Name", "x.pdf").send(PDF_BYTES);

/** Every route of the accident modules, with a plausible valid request. The test fails if a route is added and not listed here. */
const MATRIX: Record<string, { write: boolean; call: Call }> = {
  "GET /accidents": { write: false, call: (c) => c.get("/api/accidents") },
  "GET /accidents/:id": { write: false, call: (c, x) => c.get(`/api/accidents/${x.case}`) },
  "POST /accidents": { write: true, call: (c, x) => b(c, "post", "/api/accidents", { vehicleId: x.uuid, occurredAt: "2026-06-14T10:00:00+03:00", description: "حادث للاختبار", severity: "MINOR" }) },
  "PATCH /accidents/:id": { write: true, call: (c, x) => b(c, "patch", `/api/accidents/${x.case}`, { description: "تعديل للاختبار" }) },
  "POST /accidents/:id/status": { write: true, call: (c, x) => b(c, "post", `/api/accidents/${x.case}/status`, { to: "UNDER_REVIEW" }) },
  "POST /accidents/:id/attachments": { write: true, call: (c, x) => up(c, `/api/accidents/${x.case}/attachments?category=PHOTO`) },
  "GET /accident-attachments/:id/file": { write: false, call: (c, x) => c.get(`/api/accident-attachments/${x.att}/file`) },
  "GET /accidents/features": { write: false, call: (c) => c.get("/api/accidents/features") },
  "GET /accidents/stats": { write: false, call: (c) => c.get("/api/accidents/stats") },
  "GET /accident-cases": { write: false, call: (c) => c.get("/api/accident-cases") },
  "GET /accident-cases/settings": { write: false, call: (c) => c.get("/api/accident-cases/settings") },
  "PUT /accident-cases/settings": { write: true, call: (c) => b(c, "put", "/api/accident-cases/settings", { slaTechnicalDays: 3, slaEstimatesDays: 5, slaInsuranceDays: 7, slaClosureDays: 3 }) },
  "GET /accident-cases/officers": { write: false, call: (c) => c.get("/api/accident-cases/officers") },
  "POST /accident-cases/officers": { write: true, call: (c, x) => b(c, "post", "/api/accident-cases/officers", { stage: "TECHNICAL", userId: x.uuid }) },
  "GET /accident-cases/officers/candidates": { write: false, call: (c) => c.get("/api/accident-cases/officers/candidates?stage=TECHNICAL") },
  "PUT /accident-cases/officers/:id": { write: true, call: (c, x) => b(c, "put", `/api/accident-cases/officers/${x.officer}`, { userId: x.uuid }) },
  "DELETE /accident-cases/officers/:id": { write: true, call: (c, x) => b(c, "delete", `/api/accident-cases/officers/${x.officer}`) },
  "POST /accident-cases": { write: true, call: (c, x) => b(c, "post", "/api/accident-cases", draftBody(x.uuid)) },
  "GET /accident-cases/:id": { write: false, call: (c, x) => c.get(`/api/accident-cases/${x.case}`) },
  "PATCH /accident-cases/:id": { write: true, call: (c, x) => b(c, "patch", `/api/accident-cases/${x.case}`, { description: "تعديل للاختبار" }) },
  "POST /accident-cases/:id/submit": { write: true, call: (c, x) => b(c, "post", `/api/accident-cases/${x.case}/submit`) },
  "PUT /accident-cases/:id/technical": { write: true, call: (c, x) => b(c, "put", `/api/accident-cases/${x.case}/technical`, { damageDescription: "ضرر", repairDecision: "REPAIR" }) },
  "POST /accident-cases/:id/transition": { write: true, call: (c, x) => b(c, "post", `/api/accident-cases/${x.case}/transition`, { to: "AWAITING_ESTIMATES" }) },
  "POST /accident-cases/:id/assign": { write: true, call: (c, x) => b(c, "post", `/api/accident-cases/${x.case}/assign`, { userId: x.uuid }) },
  "GET /accident-cases/:id/assignable": { write: false, call: (c, x) => c.get(`/api/accident-cases/${x.case}/assignable`) },
  "POST /accident-cases/:id/attachments": { write: true, call: (c, x) => up(c, `/api/accident-cases/${x.case}/attachments?category=PHOTO`) },
  "GET /accident-cases/:id/attachments/:attId/file": { write: false, call: (c, x) => c.get(`/api/accident-cases/${x.case}/attachments/${x.att}/file`) },
  "POST /accident-cases/:id/estimates": { write: true, call: (c, x) => b(c, "post", `/api/accident-cases/${x.case}/estimates`, { vendorName: "ورشة", amount: "10", attachmentId: x.uuid }) },
  "POST /accident-cases/:id/estimates/:eid/select": { write: true, call: (c, x) => b(c, "post", `/api/accident-cases/${x.case}/estimates/${x.est}/select`) },
  "PUT /accident-cases/:id/claim": { write: true, call: (c, x) => b(c, "put", `/api/accident-cases/${x.case}/claim`, { insurerName: "شركة", claimNumber: "C1", filedAt: "2026-06-01" }) },
  "POST /accident-cases/:id/claim/status": { write: true, call: (c, x) => b(c, "post", `/api/accident-cases/${x.case}/claim/status`, { status: "PROCESSING" }) },
};
const normalise = (k: string) => k.replace(/\/accidents\/:id/, "/accidents/:id");

describe("every accident route is covered and refuses the people it must refuse", () => {
  it("the matrix lists exactly the routes the three routers define (a new route must be added here)", () => {
    expect(Object.keys(MATRIX).map(normalise).sort()).toEqual(ALL_ROUTES.map(normalise).filter((r, i, a) => a.indexOf(r) === i).sort());
  });

  let w: W;
  let ctx: Ctx;
  let viewer: Client;
  let finance: Client;
  let roleless: Client;
  let otherPm: Client;
  beforeAll(async () => {
    w = await world();
    const id = await toTechnical(w);
    const att = (await upload(w.c.pm, id, "POLICE_REPORT")).body.data.id as string;
    const officer = ((await w.c.manager.get("/api/accident-cases/officers")).body.data as { id: string }[])[0]!.id;
    ctx = { case: id, att, est: crypto.randomUUID(), officer, uuid: crypto.randomUUID() };
    viewer = w.c.viewer;
    finance = w.c.finance;
    otherPm = w.c.otherPm;
    roleless = await login((await createUser([])).email);
  });

  it("anonymous callers get 401 on every route (the workflow switch is on)", async () => {
    for (const [key, r] of Object.entries(MATRIX)) {
      const [method, path] = key.split(" ") as [string, string];
      const url = path.replace(":id", ctx.case).replace(":attId", ctx.att).replace(":eid", ctx.est);
      const res = await request(app)[method.toLowerCase() as "get"](`/api${url}`).send();
      expect(res.status, key).toBe(401);
    }
  });

  it("a user with no role gets 403 on every route and cannot change anything", async () => {
    for (const [key, r] of Object.entries(MATRIX)) {
      const res = await r.call(roleless, ctx);
      expect([403, 404].includes(res.status), `${key} → ${res.status}`).toBe(true);
    }
  });

  it("read-only roles (viewer, finance) can never write: only 403/404/409/400, never a success", async () => {
    for (const who of [viewer, finance]) {
      for (const [key, r] of Object.entries(MATRIX)) {
        if (!r.write) continue;
        const res = await r.call(who, ctx);
        expect([400, 403, 404, 409].includes(res.status), `${key} → ${res.status}`).toBe(true);
      }
    }
  });

  it("the manager of ANOTHER project can never touch this project's case: every case route answers 403/404", async () => {
    for (const [key, r] of Object.entries(MATRIX)) {
      if (!/:id|attachments/.test(key) || /officers/.test(key)) continue;
      const res = await r.call(otherPm, ctx);
      expect([403, 404].includes(res.status), `${key} → ${res.status}`).toBe(true);
    }
  });

  it("people with the wrong stage permission are refused on the stage's writes (accident manager cannot review, insurer cannot assign, technician cannot close)", async () => {
    const wrong: [Client, string[]][] = [
      [w.c.manager, ["PUT /accident-cases/:id/technical", "PUT /accident-cases/:id/claim", "POST /accident-cases/:id/claim/status", "POST /accident-cases/:id/estimates", "POST /accident-cases/:id/submit"]],
      [w.c.insurer, ["POST /accident-cases/:id/assign", "PUT /accident-cases/:id/technical", "POST /accident-cases/:id/transition", "PUT /accident-cases/settings", "POST /accident-cases/officers"]],
      [w.c.tech, ["POST /accident-cases/:id/assign", "PUT /accident-cases/:id/claim", "PUT /accident-cases/settings", "POST /accident-cases/officers", "POST /accident-cases/:id/submit"]],
      [w.c.pm, ["PUT /accident-cases/:id/technical", "POST /accident-cases/:id/assign", "PUT /accident-cases/:id/claim", "PUT /accident-cases/settings", "POST /accident-cases/officers"]],
      [w.c.driver, ["POST /accident-cases/:id/submit", "PUT /accident-cases/:id/technical", "POST /accident-cases/:id/transition", "PUT /accident-cases/settings"]],
    ];
    for (const [who, keys] of wrong) for (const k of keys) {
      const res = await MATRIX[k]!.call(who, ctx);
      expect([403, 404].includes(res.status), `${k} → ${res.status}`).toBe(true);
    }
  });
});
