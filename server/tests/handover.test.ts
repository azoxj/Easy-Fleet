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
    // expiry
    setClock(new Date("2026-08-15T09:00:00Z"));
    expect((await pub().get(`/api/public/handover/${rot.token}`)).status).toBe(404);
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
