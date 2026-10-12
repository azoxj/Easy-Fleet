import request from "supertest";
import { and, eq } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { db } from "../src/db/client.js";
import { auditLogs, handoverSessions, notifications, vehicles } from "../src/db/schema/index.js";
import { setClock } from "../src/lib/clock.js";
import { app, createDriverUser, createProject, createUser, createVehicle, JPEG_BYTES, login, PDF_BYTES, PNG_BYTES, userAndClient } from "./helpers.js";

beforeEach(() => setClock(new Date("2026-06-15T09:00:00Z")));
afterEach(() => setClock(null));

const REQUIRED = ["FRONT", "REAR", "LEFT", "RIGHT", "INTERIOR", "ODOMETER", "TIRES"];
const pub = () => request(app);
const upload = (token: string, category: string, bytes = JPEG_BYTES, type = "image/jpeg", query = "") =>
  pub().put(`/api/public/handover/${token}/photos/${category}${query}`).set("Content-Type", type).send(bytes);
const vehicleOf = async (id: string) => (await db.select().from(vehicles).where(eq(vehicles.id, id)))[0]!;

async function setup() {
  const pm = await createUser(["PROJECT_MANAGER"]);
  const pA = await createProject({ managerId: pm.id });
  const vA = await createVehicle(pA.id, { currentOdometer: 5000 });
  const drv = await createDriverUser(pA.id);
  return { pm, pA, vA, drv, pmc: await login(pm.email) };
}

async function completePhase(token: string, damageOn?: string) {
  for (const c of REQUIRED) expect((await upload(token, c, JPEG_BYTES, "image/jpeg", c === damageOn ? "?damage=true&notes=خدش" : "")).status).toBe(201);
  expect((await upload(token, "SIGNATURE", PNG_BYTES, "image/png")).status).toBe(201);
}

describe("vehicle handover & return via secure link", () => {
  it("full cycle: create link → 7 photos + signature → handover → same link → return → comparison → close", async () => {
    const { pm, vA, drv, pmc } = await setup();
    const c = await pmc.post("/api/handovers", { vehicleId: vA.id, driverId: drv.driver.id });
    expect(c.status).toBe(201);
    const { token, link, id } = c.body.data;
    expect(link).toMatch(/\/h\/[A-Za-z0-9_-]{43}$/);
    expect(c.body.data.tokenHash).toBeUndefined();
    const [row] = await db.select().from(handoverSessions).where(eq(handoverSessions.id, id));
    expect(row!.tokenHash).not.toContain(token); // only the hash is stored
    expect((await db.select().from(notifications).where(eq(notifications.userId, drv.user.id))).map((n) => n.type)).toContain("HANDOVER_REQUESTED");

    // public view: minimal data only
    const view = await pub().get(`/api/public/handover/${token}`);
    expect(view.status).toBe(200);
    expect(view.body.data).toMatchObject({ status: "PENDING_HANDOVER", progress: { phase: "HANDOVER" } });
    expect(JSON.stringify(view.body)).not.toMatch(/"id"|organization|tokenHash|createdBy/);

    // images only; submit blocked until everything is there
    expect((await upload(token, "FRONT", PDF_BYTES, "application/pdf")).status).toBe(400);
    expect((await pub().post(`/api/public/handover/${token}/submit`).send({ odometer: 5100, confirm: true })).status).toBe(400);
    await completePhase(token);
    expect((await pub().post(`/api/public/handover/${token}/submit`).send({ odometer: 4000, confirm: true })).status).toBe(400); // below vehicle odometer
    expect((await pub().post(`/api/public/handover/${token}/submit`).send({ odometer: 5100 })).status).toBe(400); // confirmation required
    const h = await pub().post(`/api/public/handover/${token}/submit`).send({ odometer: 5100, notes: "المركبة نظيفة", confirm: true });
    expect(h.status).toBe(200);
    expect(h.body.data.status).toBe("RETURN_PENDING");
    let v = await vehicleOf(vA.id);
    expect(v).toMatchObject({ assignedDriverId: drv.driver.id, status: "ASSIGNED", currentOdometer: 5100 });
    expect((await db.select().from(notifications).where(eq(notifications.userId, pm.id))).map((n) => n.type)).toContain("HANDOVER_COMPLETED");

    // same link now serves the return
    expect((await pub().get(`/api/public/handover/${token}`)).body.data.progress.phase).toBe("RETURN");
    await completePhase(token, "LEFT");
    expect((await pub().post(`/api/public/handover/${token}/submit`).send({ odometer: 5050, confirm: true })).status).toBe(400); // below handover odometer
    const r = await pub().post(`/api/public/handover/${token}/submit`).send({ odometer: 5450, notes: "خدش في الباب الأيسر", confirm: true });
    expect(r.body.data.status).toBe("RETURN_COMPLETED");
    v = await vehicleOf(vA.id);
    expect(v).toMatchObject({ assignedDriverId: null, status: "AVAILABLE", currentOdometer: 5450 });

    // comparison for the manager
    const d = (await pmc.get(`/api/handovers/${id}`)).body.data;
    expect(d.comparison.odometer).toEqual({ handover: 5100, return: 5450, distance: 350 });
    expect(d.comparison.newDamageCount).toBe(1);
    expect(d.comparison.slots.find((s: { category: string }) => s.category === "LEFT").newDamage).toBe(true);
    expect(d.comparison.notes).toEqual({ handover: "المركبة نظيفة", return: "خدش في الباب الأيسر" });
    expect(d.actions).toContain("close");
    const photoId = d.photos[0].id;
    expect((await pmc.get(`/api/handover-photos/${photoId}/file`)).status).toBe(200);

    // link is dead after the return completes; close by manager
    expect((await pub().get(`/api/public/handover/${token}`)).status).toBe(404);
    expect((await pmc.post(`/api/handovers/${id}/close`, { reviewNotes: "تمت المراجعة" })).body.data.status).toBe("CLOSED");
    expect((await pmc.post(`/api/handovers/${id}/close`, {})).status).toBe(409);
    const actions = (await db.select().from(auditLogs).where(eq(auditLogs.entityId, id))).map((a) => a.action);
    expect(actions).toEqual(expect.arrayContaining(["HANDOVER_CREATED", "HANDOVER_PHOTO_UPLOADED", "HANDOVER_COMPLETED", "HANDOVER_RETURN_COMPLETED", "HANDOVER_CLOSED"]));
    // vehicle timeline includes the driver change done by the link (actor = null → "system")
    const tl = (await pmc.get(`/api/vehicles/${vA.id}/timeline`)).body.data.map((e: { action: string }) => e.action);
    expect(tl).toEqual(expect.arrayContaining(["HANDOVER_COMPLETED", "VEHICLE_DRIVER_CHANGED"]));
  });

  it("invalid/expired/rotated tokens → 404 (audited), per-IP lockout, one active session per vehicle", async () => {
    const { vA, drv, pmc } = await setup();
    const c = (await pmc.post("/api/handovers", { vehicleId: vA.id, driverId: drv.driver.id })).body.data;
    expect((await pmc.post("/api/handovers", { vehicleId: vA.id, driverId: drv.driver.id })).status).toBe(409);
    // rotate → old token dead, new one works
    const rot = (await pmc.post(`/api/handovers/${c.id}/rotate-link`)).body.data;
    expect((await pub().get(`/api/public/handover/${c.token}`)).status).toBe(404);
    expect((await pub().get(`/api/public/handover/${rot.token}`)).status).toBe(200);
    const invalid = await db.select().from(auditLogs).where(eq(auditLogs.action, "HANDOVER_TOKEN_INVALID"));
    expect(invalid.length).toBeGreaterThan(0);
    // no expiry: the link still works months later
    setClock(new Date("2027-06-15T09:00:00Z"));
    expect((await pub().get(`/api/public/handover/${rot.token}`)).status).toBe(200);
    setClock(new Date("2026-06-15T09:00:00Z"));
    // lockout after repeated invalid tokens (limit 20 / 15 min)
    let last = 0;
    for (let i = 0; i < 22; i++) last = (await pub().get(`/api/public/handover/${"x".repeat(43)}`)).status;
    expect(last).toBe(429);
    // cancel
    expect((await pmc.post(`/api/handovers/${c.id}/cancel`, {})).status).toBe(400);
    expect((await pmc.post(`/api/handovers/${c.id}/cancel`, { reason: "تغيير السائق" })).body.data.status).toBe("CANCELLED");
  });

  it("rules: blocked vehicle statuses, driver of another project, other PM cannot see, driver-authenticated path", async () => {
    const { pA, vA, drv, pmc } = await setup();
    const vM = await createVehicle(pA.id, { status: "IN_MAINTENANCE" });
    expect((await pmc.post("/api/handovers", { vehicleId: vM.id, driverId: drv.driver.id })).status).toBe(400);
    const foreign = await createDriverUser((await createProject()).id);
    expect((await pmc.post("/api/handovers", { vehicleId: vA.id, driverId: foreign.driver.id })).status).toBe(404); // driver outside PM scope
    const s = (await pmc.post("/api/handovers", { vehicleId: vA.id, driverId: drv.driver.id })).body.data;
    const { client: otherPm } = await userAndClient(["PROJECT_MANAGER"]);
    expect((await otherPm.get(`/api/handovers/${s.id}`)).status).toBe(404);
    expect((await otherPm.post(`/api/handovers/${s.id}/rotate-link`)).status).toBe(404);
    // the logged-in driver performs the handover without the link
    const dc = await login(drv.user.email);
    const mine = (await dc.get("/api/handovers?mine=true")).body.data;
    expect(mine.map((m: { id: string }) => m.id)).toContain(s.id);
    expect((await dc.get(`/api/handovers/${s.id}`)).body.data.actions).toContain("perform");
    for (const cat of REQUIRED) expect((await dc.upload(`/api/handovers/${s.id}/photos/${cat}`, JPEG_BYTES, "image/jpeg")).status).toBe(201);
    expect((await dc.upload(`/api/handovers/${s.id}/photos/SIGNATURE`, PNG_BYTES, "image/png")).status).toBe(201);
    expect((await dc.post(`/api/handovers/${s.id}/submit`, { odometer: 5000, confirm: true })).body.data.status).toBe("RETURN_PENDING");
    // another driver cannot act on it
    const other = await createDriverUser(pA.id);
    const oc = await login(other.user.email);
    expect((await oc.get(`/api/handovers/${s.id}`)).status).toBe(404);
    const [aud] = await db.select().from(auditLogs).where(and(eq(auditLogs.entityId, s.id), eq(auditLogs.action, "HANDOVER_COMPLETED")));
    expect(aud!.userId).toBe(drv.user.id);
  });
});

describe("persistent handover link: revoke, reopen, renew", () => {
  const seeLink = async (id: string, pmc: Awaited<ReturnType<typeof login>>) => (await pmc.get(`/api/handovers/${id}`)).body.data;

  it("never expires by time and stores no expiry for new links", async () => {
    const { vA, drv, pmc } = await setup();
    const c = (await pmc.post("/api/handovers", { vehicleId: vA.id, driverId: drv.driver.id, expiresInDays: 1 }));
    expect(c.status).toBe(400); // the old expiry option is gone
    const created = (await pmc.post("/api/handovers", { vehicleId: vA.id, driverId: drv.driver.id })).body.data;
    const [row] = await db.select().from(handoverSessions).where(eq(handoverSessions.id, created.id));
    expect(row).toMatchObject({ expiresAt: null, linkStatus: "ACTIVE" });
    expect(row!.linkCreatedAt).toBeTruthy();
    for (const when of ["2026-06-16T09:00:00Z", "2026-12-31T09:00:00Z", "2030-01-01T00:00:00Z"]) {
      setClock(new Date(when));
      expect((await pub().get(`/api/public/handover/${created.token}`)).status).toBe(200);
    }
    const d = await seeLink(created.id, pmc);
    expect(d.expiresAt).toBeUndefined();
    expect(d.expired).toBeUndefined();
    expect(d.linkStatus).toBe("ACTIVE");
    expect(d.actions).toEqual(expect.arrayContaining(["rotateLink", "revokeLink"]));
  });

  it("revoking blocks every public call at once; the record and history stay", async () => {
    const { vA, drv, pmc } = await setup();
    const c = (await pmc.post("/api/handovers", { vehicleId: vA.id, driverId: drv.driver.id })).body.data;
    expect((await pub().get(`/api/public/handover/${c.token}`)).status).toBe(200);
    const r = await pmc.post(`/api/handovers/${c.id}/revoke-link`);
    expect(r.status).toBe(200);
    expect(r.body.data.linkStatus).toBe("REVOKED");
    const view = await pub().get(`/api/public/handover/${c.token}`);
    expect(view.status).toBe(404);
    expect(view.body.error.message).toBe("هذا الرابط غير فعال");
    expect((await upload(c.token, "FRONT")).status).toBe(404);
    expect((await pub().post(`/api/public/handover/${c.token}/submit`).send({ odometer: 5100, confirm: true })).status).toBe(404);
    const [row] = await db.select().from(handoverSessions).where(eq(handoverSessions.id, c.id));
    expect(row).toMatchObject({ status: "PENDING_HANDOVER", linkStatus: "REVOKED" });
    expect(row!.linkRevokedAt).toBeTruthy();
    expect(row!.linkRevokedBy).toBeTruthy();
    expect((await seeLink(c.id, pmc)).actions).toEqual(expect.arrayContaining(["reopenLink"]));
    expect((await seeLink(c.id, pmc)).actions).not.toContain("revokeLink");
    expect((await pmc.post(`/api/handovers/${c.id}/revoke-link`)).status).toBe(409); // already closed
    const audited = await db.select().from(auditLogs).where(and(eq(auditLogs.entityId, c.id), eq(auditLogs.action, "HANDOVER_LINK_REVOKED")));
    expect(audited).toHaveLength(1);
    const bad = await db.select().from(auditLogs).where(and(eq(auditLogs.entityId, c.id), eq(auditLogs.action, "HANDOVER_TOKEN_INVALID")));
    expect(JSON.stringify(bad[0]!.metadata)).toContain("revoked");
  });

  it("reopening issues a NEW token; the old token never comes back", async () => {
    const { vA, drv, pmc } = await setup();
    const c = (await pmc.post("/api/handovers", { vehicleId: vA.id, driverId: drv.driver.id })).body.data;
    await pmc.post(`/api/handovers/${c.id}/revoke-link`);
    const re = await pmc.post(`/api/handovers/${c.id}/rotate-link`);
    expect(re.status).toBe(200);
    expect(re.body.data.token).not.toBe(c.token);
    expect((await pub().get(`/api/public/handover/${c.token}`)).status).toBe(404);
    expect((await pub().get(`/api/public/handover/${re.body.data.token}`)).status).toBe(200);
    const [row] = await db.select().from(handoverSessions).where(eq(handoverSessions.id, c.id));
    expect(row!.linkStatus).toBe("ACTIVE");
    expect(row!.linkRotatedAt).toBeTruthy();
    expect(row!.linkRotatedBy).toBeTruthy();
    expect((await db.select().from(auditLogs).where(and(eq(auditLogs.entityId, c.id), eq(auditLogs.action, "HANDOVER_LINK_REOPENED")))).length).toBe(1);
  });

  it("renewing kills the old token at once and the new one works through the whole workflow", async () => {
    const { vA, drv, pmc } = await setup();
    const c = (await pmc.post("/api/handovers", { vehicleId: vA.id, driverId: drv.driver.id })).body.data;
    const r1 = (await pmc.post(`/api/handovers/${c.id}/rotate-link`)).body.data;
    const r2 = (await pmc.post(`/api/handovers/${c.id}/rotate-link`)).body.data;
    for (const dead of [c.token, r1.token]) {
      expect((await pub().get(`/api/public/handover/${dead}`)).status).toBe(404);
      expect((await upload(dead, "FRONT")).status).toBe(404);
      expect((await pub().post(`/api/public/handover/${dead}/submit`).send({ odometer: 5100, confirm: true })).status).toBe(404);
    }
    await completePhase(r2.token);
    const h = await pub().post(`/api/public/handover/${r2.token}/submit`).send({ odometer: 5100, confirm: true });
    expect(h.status).toBe(200);
    expect(h.body.data.status).toBe("RETURN_PENDING");
    // the old tokens are still dead in the next phase
    expect((await pub().get(`/api/public/handover/${c.token}`)).status).toBe(404);
    // no token appears in the audit trail or in any session field except the hash
    const trail = JSON.stringify(await db.select().from(auditLogs).where(eq(auditLogs.entityId, c.id)));
    for (const t of [c.token, r1.token, r2.token]) expect(trail).not.toContain(t);
    const detail = JSON.stringify(await seeLink(c.id, pmc));
    for (const t of [c.token, r1.token, r2.token]) expect(detail).not.toContain(t);
  });

  it("only authorized users can revoke or renew (other PM 404, driver 403, viewer 403, anonymous 401)", async () => {
    const { vA, drv, pmc } = await setup();
    const c = (await pmc.post("/api/handovers", { vehicleId: vA.id, driverId: drv.driver.id })).body.data;
    const { client: otherPm } = await userAndClient(["PROJECT_MANAGER"]);
    const { client: viewer } = await userAndClient(["VIEWER"]);
    const dc = await login(drv.user.email);
    for (const act of ["revoke-link", "rotate-link"]) {
      expect((await otherPm.post(`/api/handovers/${c.id}/${act}`)).status, `other PM ${act}`).toBe(404);
      expect([401, 403]).toContain((await viewer.post(`/api/handovers/${c.id}/${act}`)).status);
      expect((await dc.post(`/api/handovers/${c.id}/${act}`)).status, `driver ${act}`).toBe(403);
      expect((await pub().post(`/api/handovers/${c.id}/${act}`)).status, `anonymous ${act}`).toBe(401);
    }
    expect((await pub().get(`/api/public/handover/${c.token}`)).status).toBe(200); // nothing changed
    const { client: admin } = await userAndClient(["SUPER_ADMIN"]);
    expect((await admin.post(`/api/handovers/${c.id}/revoke-link`)).status).toBe(200);
  });

  it("a finished session's link is dead, and revoking is refused once the session is not active", async () => {
    const { vA, drv, pmc } = await setup();
    const c = (await pmc.post("/api/handovers", { vehicleId: vA.id, driverId: drv.driver.id })).body.data;
    expect((await pmc.post(`/api/handovers/${c.id}/cancel`, { reason: "تغيير السائق" })).status).toBe(200);
    expect((await pub().get(`/api/public/handover/${c.token}`)).status).toBe(404);
    expect((await pmc.post(`/api/handovers/${c.id}/revoke-link`)).status).toBe(409);
    expect((await pmc.post(`/api/handovers/${c.id}/rotate-link`)).status).toBe(409);
  });
});
