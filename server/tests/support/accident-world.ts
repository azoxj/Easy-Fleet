import { eq } from "drizzle-orm";
import { expect } from "vitest";
import { db } from "../../src/db/client.js";
import { accidentStageOfficers, accidents, vehicles } from "../../src/db/schema/index.js";
import { createDriverUser, createProject, createUser, createVehicle, login, PDF_BYTES, type Client } from "../helpers.js";

/** Shared fixtures for the accident workflow HTTP tests: a project with its people, designated officers and stage-walking helpers. */
export const REQUIRED = ["NAJM_REPORT", "DRIVER_ID", "DRIVER_LICENSE", "VEHICLE_REGISTRATION"];
export const upload = (c: Client, id: string, category: string, name = `${category}.pdf`) =>
  c.agent.post(`/api/accident-cases/${id}/attachments?category=${category}`).set("X-CSRF-Token", c.csrf).set("Content-Type", "application/pdf").set("X-File-Name", name).send(PDF_BYTES);
export const uploadRequired = async (c: Client, id: string) => {
  for (const cat of REQUIRED) expect((await upload(c, id, cat)).status, cat).toBe(201);
};
export const draftBody = (vehicleId: string, extra: object = {}) => ({ vehicleId, occurredAt: "2026-06-14T18:00:00+03:00", description: "صدمة خلفية عند الإشارة", severity: "MODERATE", location: "الرياض", ...extra });
export const vehicleOf = async (id: string) => (await db.select().from(vehicles).where(eq(vehicles.id, id)))[0]!;
export const caseOf = async (id: string) => (await db.select().from(accidents).where(eq(accidents.id, id)))[0]!;

export async function world() {
  await db.delete(accidentStageOfficers);
  const pm = await createUser(["PROJECT_MANAGER"]);
  const tech = await createUser(["TECHNICAL"]);
  const viewer = await createUser(["VIEWER"]);
  const project = await createProject({ managerId: pm.id, members: [tech.id, viewer.id] });
  const vehicle = await createVehicle(project.id, { status: "ASSIGNED" });
  const drv = await createDriverUser(project.id);
  await db.update(vehicles).set({ assignedDriverId: drv.driver.id }).where(eq(vehicles.id, vehicle.id));
  const insurer = await createUser(["INSURANCE_OFFICER"]);
  const manager = await createUser(["ACCIDENT_MANAGER"]);
  const finance = await createUser(["FINANCE"]);
  const sa = await createUser(["SUPER_ADMIN"]);
  const otherPm = await createUser(["PROJECT_MANAGER"]);
  await createProject({ managerId: otherPm.id });
  const c = {
    pm: await login(pm.email),
    tech: await login(tech.email),
    viewer: await login(viewer.email),
    driver: await login(drv.user.email),
    insurer: await login(insurer.email),
    manager: await login(manager.email),
    finance: await login(finance.email),
    sa: await login(sa.email),
    otherPm: await login(otherPm.email),
  };
  // designated officers: the project's technician, the organisation's insurance officer
  expect((await c.manager.post("/api/accident-cases/officers", { stage: "TECHNICAL", userId: tech.id, projectId: project.id })).status).toBe(201);
  expect((await c.manager.post("/api/accident-cases/officers", { stage: "INSURANCE", userId: insurer.id })).status).toBe(201);
  return { pm, tech, viewer, project, vehicle, drv, insurer, manager, finance, sa, otherPm, c };
}
export type W = Awaited<ReturnType<typeof world>>;

export const newDraft = async (w: W, extra: object = {}) => {
  const r = await w.c.pm.post("/api/accident-cases", draftBody(w.vehicle.id, extra));
  expect(r.status, JSON.stringify(r.body)).toBe(201);
  return r.body.data.id as string;
};
export const toTechnical = async (w: W) => {
  const id = await newDraft(w);
  await uploadRequired(w.c.pm, id);
  const r = await w.c.pm.post(`/api/accident-cases/${id}/submit`);
  expect(r.status, JSON.stringify(r.body)).toBe(200);
  return id;
};
export const toEstimates = async (w: W, id: string) => {
  expect((await w.c.tech.put(`/api/accident-cases/${id}/technical`, { damageDescription: "تلف في الصدام الخلفي", technicalNotes: "يحتاج استبدال", repairDecision: "REPAIR" })).status).toBe(200);
  const r = await w.c.tech.post(`/api/accident-cases/${id}/transition`, { to: "AWAITING_ESTIMATES" });
  expect(r.status, JSON.stringify(r.body)).toBe(200);
};
export const addEstimate = async (w: W, id: string, vendorName: string, amount: string) => {
  const att = await upload(w.c.pm, id, "ESTIMATE", `estimate-${Math.random().toString(36).slice(2, 8)}.pdf`);
  expect(att.status).toBe(201);
  const r = await w.c.pm.post(`/api/accident-cases/${id}/estimates`, { vendorName, amount, attachmentId: att.body.data.id });
  expect(r.status, JSON.stringify(r.body)).toBe(201);
  return r.body.data.id as string;
};
export const toInsurance = async (w: W, id: string) => {
  await toEstimates(w, id);
  const e = await addEstimate(w, id, "ورشة الأمل", "2500.00");
  expect((await w.c.pm.post(`/api/accident-cases/${id}/estimates/${e}/select`)).status).toBe(200);
  const r = await w.c.pm.post(`/api/accident-cases/${id}/transition`, { to: "AWAITING_INSURANCE" });
  expect(r.status, JSON.stringify(r.body)).toBe(200);
};
export const claimBody = { insurerName: "التعاونية", claimNumber: "CLM-1001", filedAt: "2026-06-15", claimedAmount: "2500.00" };
export const toClaim = async (w: W, id: string) => {
  await toInsurance(w, id);
  const r = await w.c.insurer.put(`/api/accident-cases/${id}/claim`, claimBody);
  expect(r.status, JSON.stringify(r.body)).toBe(200);
};
export const toFinalClosure = async (w: W, id: string) => {
  await toClaim(w, id);
  expect((await w.c.insurer.post(`/api/accident-cases/${id}/claim/status`, { status: "PROCESSING" })).status).toBe(200);
  expect((await w.c.insurer.post(`/api/accident-cases/${id}/claim/status`, { status: "APPROVED", approvedAmount: "2400.00" })).status).toBe(200);
  expect((await upload(w.c.insurer, id, "COMPENSATION_PROOF")).status).toBe(201);
  const r = await w.c.insurer.post(`/api/accident-cases/${id}/claim/status`, { status: "COMPENSATION_RECEIVED", receivedAmount: "2400.00" });
  expect(r.status, JSON.stringify(r.body)).toBe(200);
};
/** The repair of a REPAIR case is documented (the project manager files the completion proof). */
export const documentRepair = async (w: W, id: string) => expect((await upload(w.c.pm, id, "REPAIR_COMPLETION")).status).toBe(201);
export const detail = async (c: Client, id: string) => {
  const r = await c.get(`/api/accident-cases/${id}`);
  if (r.status !== 200) throw new Error(`detail ${r.status} ${JSON.stringify(r.body)}`);
  return r.body.data;
};

