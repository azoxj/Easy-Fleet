import request from "supertest";
import { eq, sql } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { db, pool } from "../src/db/client.js";
import { auditLogs, notifications, vehicles } from "../src/db/schema/index.js";
import { setClock } from "../src/lib/clock.js";
import { PgRateLimiter } from "../src/lib/pg-rate-limit.js";
import { app, createDriverUser, createEmployee, createProject, createUser, createVehicle, JPEG_BYTES, login, PDF_BYTES } from "./helpers.js";

/** Spec §51 — security end-to-end checks across the new modules. */
beforeEach(() => setClock(new Date("2026-06-15T09:00:00Z")));
afterEach(() => setClock(null));

async function twoProjects() {
  const pmA = await createUser(["PROJECT_MANAGER"]);
  const pmB = await createUser(["PROJECT_MANAGER"]);
  const pA = await createProject({ managerId: pmA.id });
  const pB = await createProject({ managerId: pmB.id });
  const vA = await createVehicle(pA.id, { currentOdometer: 100 });
  const drv = await createDriverUser(pA.id);
  const a = await login(pmA.email);
  const b = await login(pmB.email);
  // Records in project A
  const fuel = (await a.post("/api/fuel", { vehicleId: vA.id, fueledAt: "2026-06-14T10:00:00Z", liters: 10, pricePerLiter: 2 })).body.data;
  const acc = (await a.post("/api/accidents", { vehicleId: vA.id, occurredAt: "2026-06-14T10:00:00Z", description: "حادث سري", severity: "MINOR" })).body.data;
  const vio = (await a.post("/api/violations", { vehicleId: vA.id, violationDate: "2026-06-14", type: "سرعة", amount: "100" })).body.data;
  const inv = (await a.post("/api/invoices", { projectId: pA.id, amount: "10", invoiceDate: "2026-06-14" })).body.data;
  await a.upload(`/api/invoices/${inv.id}/file`, PDF_BYTES);
  const exp = (await a.post("/api/expenses", { projectId: pA.id, category: "OTHER", amount: "5", expenseDate: "2026-06-14" })).body.data;
  await db.update(vehicles).set({ status: "ARCHIVED" }).where(eq(vehicles.id, vA.id));
  const vH = await createVehicle(pA.id);
  const ho = (await a.post("/api/handovers", { vehicleId: vH.id, driverId: drv.driver.id })).body.data;
  const emp = await createEmployee(pA.id);
  const doc = (await a.post(`/api/employees/${emp.id}/documents`, { documentType: "CONTRACT" })).body.data;
  return { pmA, pmB, pA, pB, vA, a, b, fuel, acc, vio, inv, exp, ho, doc, emp };
}

describe("security E2E (spec §51)", () => {
  it("IDOR: a manager of project B gets 404 for every project-A record and file", async () => {
    const s = await twoProjects();
    const urls = [
      `/api/fuel/${s.fuel.id}`,
      `/api/fuel/${s.fuel.id}/receipt`,
      `/api/accidents/${s.acc.id}`,
      `/api/violations/${s.vio.id}`,
      `/api/violations/${s.vio.id}/file`,
      `/api/invoices/${s.inv.id}`,
      `/api/invoices/${s.inv.id}/file`,
      `/api/invoices/${s.inv.id}/receipt`,
      `/api/expenses/${s.exp.id}/receipt`,
      `/api/handovers/${s.ho.id}`,
      `/api/employees/${s.emp.id}/documents`,
      `/api/employee-documents/${s.doc.id}/file`,
      `/api/projects/${s.pA.id}/dashboard`,
      `/api/projects/${s.pA.id}/financials`,
      `/api/vehicles/${s.vA.id}/qr`,
    ];
    for (const u of urls) expect((await s.b.get(u)).status, u).toBe(404);
    // writes too
    expect((await s.b.post(`/api/accidents/${s.acc.id}/status`, { to: "UNDER_REVIEW" })).status).toBe(404);
    expect((await s.b.patch(`/api/violations/${s.vio.id}`, { amount: "1" })).status).toBe(404);
    expect((await s.b.post(`/api/violations/${s.vio.id}/pay`, { paymentDate: "2026-06-14" })).status).toBe(404);
    expect((await s.b.post(`/api/handovers/${s.ho.id}/rotate-link`)).status).toBe(404);
    expect((await s.b.post(`/api/invoices/${s.inv.id}/submit`)).status).toBe(404);
    expect((await s.b.post("/api/fuel", { vehicleId: s.vA.id, fueledAt: "2026-06-14T10:00:00Z", liters: 1, pricePerLiter: 1 })).status).toBe(404);
    // lists never include foreign rows
    for (const u of ["/api/fuel", "/api/accidents", "/api/violations", "/api/invoices", "/api/handovers", "/api/expenses"]) {
      const body = (await s.b.get(u)).body;
      expect(JSON.stringify(body), u).not.toContain(s.pA.id);
    }
    // documents center / search / reports
    expect(JSON.stringify((await s.b.get("/api/documents-center")).body)).not.toContain(s.doc.id);
    expect(JSON.stringify((await s.b.get("/api/reports/accidents")).body)).not.toContain("حادث سري");
  });

  it("no cross-project notification leakage", async () => {
    const s = await twoProjects();
    const bNotes = await db.select().from(notifications).where(eq(notifications.userId, s.pmB.id));
    expect(bNotes.filter((n) => n.projectId === s.pA.id)).toHaveLength(0);
    expect(JSON.stringify(bNotes)).not.toContain(s.acc.id);
  });

  it("unauthenticated requests are rejected everywhere; public link needs a valid token", async () => {
    const paths = ["/api/invoices", "/api/expenses", "/api/fuel", "/api/accidents", "/api/violations", "/api/handovers", "/api/reports", "/api/approvals", "/api/settings/company", "/api/tracking/latest", "/api/documents-center", "/api/finance/dashboard"];
    for (const p of paths) expect((await request(app).get(p)).status, p).toBe(401);
    expect((await request(app).put(`/api/public/handover/${"a".repeat(43)}/photos/FRONT`).set("Content-Type", "image/jpeg").send(JPEG_BYTES)).status).toBe(404);
  });

  it("CSRF token and Origin are enforced on writes (and audited)", async () => {
    const u = await createUser(["SUPER_ADMIN"]);
    const c = await login(u.email);
    const noToken = await c.agent.post("/api/vendors").send({ name: "بدون رمز" });
    expect(noToken.status).toBe(403);
    const badOrigin = await c.agent.post("/api/vendors").set("X-CSRF-Token", c.csrf).set("Origin", "https://evil.example").send({ name: "مصدر خارجي" });
    expect(badOrigin.status).toBe(403);
    const crossSite = await c.agent.post("/api/vendors").set("X-CSRF-Token", c.csrf).set("Sec-Fetch-Site", "cross-site").send({ name: "موقع آخر" });
    expect(crossSite.status).toBe(403);
    await new Promise((r) => setTimeout(r, 50));
    const rows = await db.select().from(auditLogs).where(eq(auditLogs.action, "SECURITY_CSRF_REJECTED"));
    expect(rows.length).toBeGreaterThan(0);
  });

  it("mass assignment blocked by strict schemas; server-controlled fields cannot be injected", async () => {
    const s = await twoProjects();
    expect((await s.a.post("/api/invoices", { projectId: s.pA.id, amount: "1", invoiceDate: "2026-06-14", createdBy: s.pmB.id })).status).toBe(400);
    expect((await s.a.post("/api/accidents", { vehicleId: s.vA.id, occurredAt: "2026-06-14T10:00:00Z", description: "abc", severity: "MINOR", status: "CLOSED" })).status).toBe(400);
    expect((await s.a.post("/api/violations", { vehicleId: s.vA.id, violationDate: "2026-06-14", type: "abc", amount: "1", status: "PAID" })).status).toBe(400);
    expect((await s.a.post("/api/fuel", { vehicleId: s.vA.id, fueledAt: "2026-06-14T10:00:00Z", liters: 1, pricePerLiter: 1, projectId: s.pB.id })).status).toBe(400);
  });

  it("file security: magic bytes, declared type must match, HTML/SVG rejected, downloads are attachments with sandbox CSP", async () => {
    const s = await twoProjects();
    const html = Buffer.from("<html><script>alert(1)</script></html>");
    expect((await s.a.upload(`/api/violations/${s.vio.id}/file`, html, "application/pdf")).status).toBe(400);
    expect((await s.a.upload(`/api/violations/${s.vio.id}/file`, PDF_BYTES, "image/png")).status).toBe(400);
    const svg = Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script></svg>');
    expect((await s.a.upload(`/api/violations/${s.vio.id}/file`, svg, "image/svg+xml")).status).toBe(400);
    expect((await s.a.upload(`/api/violations/${s.vio.id}/file`, PDF_BYTES)).status).toBe(201);
    const dl = await s.a.get(`/api/violations/${s.vio.id}/file`);
    expect(dl.headers["content-disposition"]).toMatch(/^attachment/);
    expect(dl.headers["content-security-policy"]).toContain("sandbox");
    expect(dl.headers["x-content-type-options"]).toBe("nosniff");
  });

  it("audit log is append-only at the database level and records old/new values", async () => {
    const s = await twoProjects();
    await expect(pool.query("update audit_logs set action = 'X'")).rejects.toThrow(/append-only/);
    await expect(pool.query("delete from audit_logs")).rejects.toThrow(/append-only/);
    const [row] = await db.select().from(auditLogs).where(eq(auditLogs.action, "VIOLATION_CREATED")).limit(1);
    expect(row!.newValue).toMatchObject({ status: "OPEN" });
    void s;
  });

  it("security headers, CSP (tiles only when no proxy), and rate limiting shared through PostgreSQL", async () => {
    const r = await request(app).get("/api/health");
    expect(r.headers["x-frame-options"]).toBe("DENY");
    expect(r.headers["content-security-policy"]).toContain("frame-ancestors 'none'");
    expect(r.headers["content-security-policy"]).toContain("https://tile.openstreetmap.org");
    expect(r.headers["cache-control"]).toBe("no-store");
    // two limiter instances (= two app instances) share the same counter
    const l1 = new PgRateLimiter("sec-test", 3, 60_000);
    const l2 = new PgRateLimiter("sec-test", 3, 60_000);
    expect(await l1.hit("k")).toBe(0);
    expect(await l2.hit("k")).toBe(0);
    expect(await l1.hit("k")).toBe(0);
    expect(await l2.hit("k")).toBeGreaterThan(0);
  });

  it("injection-looking input is treated as data", async () => {
    const u = await createUser(["SUPER_ADMIN"]);
    const c = await login(u.email);
    const r = await c.get(`/api/search?q=${encodeURIComponent("'; drop table vehicles; --")}`);
    expect(r.status).toBe(200);
    const pct = await c.get(`/api/search?q=${encodeURIComponent("%_%")}`);
    expect(pct.status).toBe(200);
    expect((await db.execute(sql`select count(*)::int as n from vehicles`)).rows.length).toBe(1);
  });
});
