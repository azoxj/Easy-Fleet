import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { db } from "../src/db/client.js";
import { accidentClaims, accidentFinanceReviews, accidents, expenses, insurancePolicies, invoices, organizations } from "../src/db/schema/index.js";
import { setClock } from "../src/lib/clock.js";
import { setAccidentWorkflowFlag } from "../src/lib/feature-flags.js";
import { createProject, createUser, createVehicle, login, PDF_BYTES, type Client } from "./helpers.js";

beforeAll(() => setAccidentWorkflowFlag(true));
afterAll(() => setAccidentWorkflowFlag(null));
beforeEach(() => setClock(new Date("2026-06-15T09:00:00Z")));
afterEach(() => setClock(null));

/** Two projects; a finance officer for each, one for both, two for the same project; one central insurance account. */
async function world() {
  // An organization of its own: totals are exact, whatever the other tests left behind.
  const [org] = await db.insert(organizations).values({ name: "Hub test", slug: `hub-${randomUUID()}` }).returning();
  const orgId = org!.id;
  const mk = (roles: Parameters<typeof createUser>[0]) => createUser(roles, { orgId });
  const pmA = await mk(["PROJECT_MANAGER"]);
  const pmB = await mk(["PROJECT_MANAGER"]);
  const finA = await mk(["FINANCE"]);
  const finA2 = await mk(["FINANCE_OFFICER"]); // a second officer on the same project (older role key, same grants)
  const finB = await mk(["FINANCE"]);
  const finAB = await mk(["FINANCE"]);
  const ins = await mk(["INSURANCE_OFFICER"]);
  const sa = await mk(["SUPER_ADMIN"]);
  const admin = { orgId };
  void admin;
  const [pA, pB] = await Promise.all([createProject({ managerId: pmA.id, members: [finA.id, finA2.id, finAB.id] }), createProject({ managerId: pmB.id, members: [finB.id, finAB.id] })]);
  // createProject uses the default organization: move both projects to the test organization
  const { projects, vehicles, projectUsers } = await import("../src/db/schema/index.js");
  await db.update(projects).set({ organizationId: orgId }).where(eq(projects.id, pA.id));
  await db.update(projects).set({ organizationId: orgId }).where(eq(projects.id, pB.id));
  void projectUsers;
  const vA = await createVehicle(pA.id, { plateNumber: "HUB-A1" });
  const vB = await createVehicle(pB.id, { plateNumber: "HUB-B1" });
  await db.update(vehicles).set({ organizationId: orgId }).where(eq(vehicles.id, vA.id));
  await db.update(vehicles).set({ organizationId: orgId }).where(eq(vehicles.id, vB.id));

  const invoice = async (projectId: string, vehicleId: string, by: string, total: string, status: "SUBMITTED" | "TRANSFER_PENDING" | "PAID", due?: string) => {
    const [i] = await db.insert(invoices).values({ organizationId: orgId, projectId, vehicleId, amount: total, tax: "0", total, invoiceDate: "2026-06-01", dueDate: due ?? null, status, createdBy: by }).returning();
    return i!;
  };
  const invA1 = await invoice(pA.id, vA.id, pmA.id, "1000.00", "SUBMITTED", "2026-06-10"); // overdue (today is 2026-06-15)
  const invA2 = await invoice(pA.id, vA.id, pmA.id, "500.00", "PAID");
  const invB1 = await invoice(pB.id, vB.id, pmB.id, "7000.00", "SUBMITTED");
  await db.insert(expenses).values({ organizationId: orgId, projectId: pA.id, category: "OTHER", amount: "50.00", expenseDate: "2026-06-11", status: "SUBMITTED", createdBy: pmA.id });
  await db.insert(expenses).values({ organizationId: orgId, projectId: pB.id, category: "OTHER", amount: "60.00", expenseDate: "2026-06-11", status: "SUBMITTED", createdBy: pmB.id });

  await db.insert(insurancePolicies).values({ organizationId: orgId, vehicleId: vA.id, provider: "التعاونية", policyNumber: "POL-A", issueDate: "2026-01-01", expiryDate: "2026-07-01", coverageType: "COMPREHENSIVE", premiumAmount: "900.00" });
  await db.insert(insurancePolicies).values({ organizationId: orgId, vehicleId: vB.id, provider: "ميدغلف", policyNumber: "POL-B", issueDate: "2025-01-01", expiryDate: "2026-05-01", coverageType: "THIRD_PARTY", premiumAmount: "700.00" });

  const accident = async (projectId: string, vehicleId: string, by: string, stage: string, claim: { status: "APPROVED" | "REJECTED" | "COMPENSATION_RECEIVED"; approved?: string; received?: string }, cost?: string) => {
    const [a] = await db.insert(accidents).values({ organizationId: orgId, vehicleId, projectId, occurredAt: new Date("2026-06-01T10:00:00Z"), description: "حادث للمركز", severity: "MODERATE", createdBy: by, status: "INSURANCE", workflowStage: stage as never, repairCost: cost ?? null }).returning();
    await db.insert(accidentClaims).values({ organizationId: orgId, accidentId: a!.id, status: claim.status, claimNumber: `CL-${a!.number}`, insurerName: "التعاونية", claimedAmount: claim.approved ?? "100.00", approvedAmount: claim.approved ?? null, receivedAmount: claim.received ?? null, rejectionReason: claim.status === "REJECTED" ? "غير مشمول" : null });
    return a!;
  };
  const accA = await accident(pA.id, vA.id, pmA.id, "AWAITING_COMPENSATION_PROOF", { status: "APPROVED", approved: "2400.00" }, "2500.00");
  const accA2 = await accident(pA.id, vA.id, pmA.id, "AWAITING_TECHNICAL_FINAL", { status: "COMPENSATION_RECEIVED", approved: "1000.00", received: "1000.00" });
  await db.insert(accidentFinanceReviews).values({ organizationId: orgId, accidentId: accA2.id, kind: "INSURANCE_TRANSFER", status: "CONFIRMED", amount: "1000.00", referenceDate: new Date("2026-06-12T00:00:00Z"), reviewedBy: finA.id });
  const accB = await accident(pB.id, vB.id, pmB.id, "CLAIM_IN_PROGRESS", { status: "REJECTED" });
  const c = {
    finA: await login(finA.email), finA2: await login(finA2.email), finB: await login(finB.email), finAB: await login(finAB.email),
    ins: await login(ins.email), sa: await login(sa.email), pmA: await login(pmA.email),
  };
  return { orgId, pA, pB, vA, vB, invA1, invA2, invB1, accA, accA2, accB, c, finA, finAB };
}

const overview = async (c: Client) => (await c.get("/api/finance/overview")).body.data;

describe("finance officers see their projects only", () => {
  it("old ownership and assignments do not bypass a finance officer's project boundary", async () => {
    const w = await world();
    await db.update(invoices).set({ createdBy: w.finA.id }).where(eq(invoices.id, w.invB1.id));
    await db.update(accidents).set({ assignedTo: w.finA.id }).where(eq(accidents.id, w.accB.id));
    expect((await w.c.finA.get(`/api/invoices/${w.invB1.id}`)).status).toBe(404);
    expect((await w.c.finA.get(`/api/accident-cases/${w.accB.id}`)).status).toBe(404);
    expect((await overview(w.c.finA)).claims.amount).toBe("1500.00");
  });

  it("the shared vendor directory never reveals financial usage outside the officer's projects", async () => {
    const w = await world();
    const { vendors } = await import("../src/db/schema/index.js");
    const [vendor] = await db.insert(vendors).values({ organizationId: w.orgId, name: "مورد تجريبي مشترك" }).returning();
    for (const id of [w.invA1.id, w.invA2.id, w.invB1.id]) await db.update(invoices).set({ vendorId: vendor!.id }).where(eq(invoices.id, id));
    await db.update(expenses).set({ vendorId: vendor!.id }).where(eq(expenses.organizationId, w.orgId));
    const a = await w.c.finA.get(`/api/vendors/${vendor!.id}`);
    expect(a.status, JSON.stringify(a.body)).toBe(200);
    expect(a.body.data.usage).toEqual({ quotes: 0, invoices: 2, expenses: 1 });
    expect((await w.c.finAB.get(`/api/vendors/${vendor!.id}`)).body.data.usage).toEqual({ quotes: 0, invoices: 3, expenses: 2 });
  });

  it("each officer's overview covers the assigned projects; two officers of one project see the same; one officer of two projects sees both", async () => {
    const w = await world();
    const a = await overview(w.c.finA);
    expect(a.claims).toEqual({ count: 2, amount: "1500.00" }); // 1000 submitted + 500 paid, project A only
    expect(a.due).toEqual({ count: 1, amount: "1000.00" });
    expect(a.overdue).toEqual({ count: 1, amount: "1000.00" });
    expect(a.paid).toEqual({ count: 1, amount: "500.00" });
    expect(a.insurance).toMatchObject({ approved: "3400.00", collected: "1000.00", awaiting: "2400.00", awaitingCount: 1 });
    expect(a.awaitingMe).toMatchObject({ invoicesToReview: 1, expensesToApprove: 1 });
    expect(a.projects.map((p: { projectId: string }) => p.projectId)).toEqual([w.pA.id]);

    const b = await overview(w.c.finB);
    expect(b.claims).toEqual({ count: 1, amount: "7000.00" });
    expect(b.paid.count).toBe(0);
    expect(b.projects.map((p: { projectId: string }) => p.projectId)).toEqual([w.pB.id]);

    expect(await overview(w.c.finA2)).toEqual(a); // a second officer on the same project
    const ab = await overview(w.c.finAB); // one officer, two projects
    expect(ab.claims).toEqual({ count: 3, amount: "8500.00" });
    expect(ab.projects.map((p: { projectId: string }) => p.projectId).sort()).toEqual([w.pA.id, w.pB.id].sort());
    expect((await overview(w.c.sa)).claims.count).toBe(3);
  });

  it("another project's invoices, expenses, transfers, accident finance and reports never reach an officer (API, lists, CSV)", async () => {
    const w = await world();
    expect((await w.c.finA.get(`/api/invoices/${w.invB1.id}`)).status).toBe(404);
    expect((await w.c.finA.post(`/api/invoices/${w.invB1.id}/approve`)).status).toBe(404);
    expect((await w.c.finB.get(`/api/invoices/${w.invA1.id}`)).status).toBe(404);
    const idsOf = async (c: Client, url: string) => ((await c.get(url)).body.data as { id: string }[]).map((r) => r.id);
    expect(await idsOf(w.c.finA, "/api/invoices")).toEqual(expect.arrayContaining([w.invA1.id, w.invA2.id]));
    expect(await idsOf(w.c.finA, "/api/invoices")).not.toContain(w.invB1.id);
    const expensesA = (await w.c.finA.get("/api/expenses")).body.data as { projectId: string }[];
    expect(expensesA.every((e) => e.projectId === w.pA.id)).toBe(true);
    // the financial side of accidents
    const accA = (await w.c.finA.get("/api/finance/accident-finance")).body.data as { id: string; projectId: string }[];
    expect(accA.map((r) => r.id).sort()).toEqual([w.accA.id, w.accA2.id].sort());
    const accB = (await w.c.finB.get("/api/finance/accident-finance")).body.data as { id: string }[];
    expect(accB.map((r) => r.id)).toEqual([w.accB.id]);
    expect((await w.c.finA.get(`/api/finance/accident-finance?projectId=${w.pB.id}`)).body.data).toEqual([]); // filtering by a foreign project yields nothing
    // transfers: money in confirmed on project A's accident appears for A's officers only
    const trA = (await w.c.finA.get("/api/finance/transfers")).body;
    expect(trA.data.map((r: { subject: string }) => r.subject)).toEqual([`ACC-${w.accA2.number}`]);
    expect(trA.totals).toEqual({ out: "0.00", in: "1000.00" });
    expect((await w.c.finB.get("/api/finance/transfers")).body.data).toEqual([]);
    // reports and exports are scoped the same way
    const rep = (await w.c.finA.get("/api/reports/finance-accidents")).body.data as { label: string }[];
    expect(rep.map((r) => r.label).sort()).toEqual([`ACC-${w.accA.number}`, `ACC-${w.accA2.number}`].sort());
    const csv = (await w.c.finB.get("/api/reports/finance-accidents?format=csv")).text;
    expect(csv).toContain(`ACC-${w.accB.number}`);
    expect(csv).not.toContain(`ACC-${w.accA.number}`);
    // the case screen opens only for what the visibility rule gives the officer (nothing is forwarded to finance here)
    expect((await w.c.finA.get(`/api/accident-cases/${w.accB.id}`)).status).toBe(404);
    // only the case finance reviewed itself opens from the list
    expect((await w.c.finA.get("/api/finance/accident-finance")).body.data.filter((r: { canOpen: boolean }) => r.canOpen).map((r: { id: string }) => r.id)).toEqual([w.accA2.id]);
  });

  it("the finance officer has no insurance workspace rights: cannot edit policies or claims; the audit names the actor", async () => {
    const w = await world();
    expect((await w.c.finA.post(`/api/vehicles/${w.vA.id}/insurance`, { provider: "x", policyNumber: "P", expiryDate: "2027-01-01", coverageType: "OTHER" })).status).toBe(403);
    // the claims screen shows only what finance itself handled (the transfer it confirmed), never the other cases
    expect(((await w.c.finA.get("/api/insurance-center/claims")).body.data as { id: string }[]).map((r) => r.id)).toEqual([w.accA2.id]);
    const own = (await w.c.finA.get("/api/insurance-center/policies")).body.data as { plateNumber: string }[];
    expect(own.map((p) => p.plateNumber)).toEqual(["HUB-A1"]); // policies of its own project only
    // approve → the invoice records who approved
    const start = await w.c.finA.post(`/api/invoices/${w.invA1.id}/start-review`);
    expect(start.status, JSON.stringify(start.body)).toBe(200);
    const done = await w.c.finA.post(`/api/invoices/${w.invA1.id}/approve`);
    expect(done.status).toBe(200);
    const [row] = await db.select().from(invoices).where(eq(invoices.id, w.invA1.id));
    expect(row!.approvedBy).toBe(w.finA.id);
  });
});

describe("the central insurance account", () => {
  it("sees the insurance work of both projects: policies, claims, compensation, missing items — and nothing financial", async () => {
    const w = await world();
    const d = (await w.c.ins.get("/api/insurance-center/dashboard")).body.data;
    expect(d.policies).toMatchObject({ active: 1, expired: 1, expiring: 1 }); // A expires in 16 days, B expired a month ago
    expect(d.claims).toMatchObject({ rejected: 1, approved: 1 });
    expect(d.compensation).toMatchObject({ awaitingTransfer: "2400.00", received: "1000.00", receivedCount: 1 });
    expect(d.projects.map((p: { projectId: string }) => p.projectId).sort()).toEqual([w.pA.id, w.pB.id].sort());
    const policies = (await w.c.ins.get("/api/insurance-center/policies")).body.data as { plateNumber: string; state: string }[];
    expect(policies.map((p) => p.plateNumber).sort()).toEqual(["HUB-A1", "HUB-B1"]);
    expect(policies.find((p) => p.plateNumber === "HUB-B1")!.state).toBe("EXPIRED");
    expect(((await w.c.ins.get("/api/insurance-center/policies?status=expiring")).body.data as unknown[]).length).toBe(1);
    expect(((await w.c.ins.get(`/api/insurance-center/policies?projectId=${w.pB.id}`)).body.data as { plateNumber: string }[]).map((p) => p.plateNumber)).toEqual(["HUB-B1"]);
    const claims = (await w.c.ins.get("/api/insurance-center/claims?pageSize=50")).body.data as { id: string; claimStatus: string; rejectionReason: string | null }[];
    expect(claims.map((c) => c.id).sort()).toEqual([w.accA.id, w.accA2.id, w.accB.id].sort());
    expect(claims.find((c) => c.id === w.accB.id)!.rejectionReason).toBe("غير مشمول");
    for (const [lane, ids] of [["approved", [w.accA.id]], ["rejected", [w.accB.id]], ["received", [w.accA2.id]]] as const) {
      expect(((await w.c.ins.get(`/api/insurance-center/claims?lane=${lane}`)).body.data as { id: string }[]).map((c) => c.id), lane).toEqual(ids);
    }
    expect(((await w.c.ins.get(`/api/insurance-center/claims?projectId=${w.pA.id}&vehicleId=${w.vA.id}`)).body.data as unknown[]).length).toBe(2);
    expect((await w.c.ins.get("/api/insurance-center/requirements")).status).toBe(200);
    // the reports with filters and export
    expect(((await w.c.ins.get("/api/reports/insurance-claims")).body.data as unknown[]).length).toBe(3);
    expect(((await w.c.ins.get(`/api/reports/insurance-policies?projectId=${w.pA.id}`)).body.data as unknown[]).length).toBe(1);
    expect((await w.c.ins.get("/api/reports/insurance-claims?format=csv")).status).toBe(200);
    // no finance at all
    for (const url of ["/api/finance/overview", "/api/finance/transfers", "/api/finance/accident-finance", "/api/invoices", "/api/expenses", "/api/finance/dashboard", "/api/reports/finance-accidents"]) {
      expect((await w.c.ins.get(url)).status, url).toBe(403);
    }
    expect((await w.c.ins.post(`/api/accident-cases/${w.accA.id}/compensation/confirm`, { receivedAmount: "2400.00", receiptDate: "2026-06-15" })).status).toBeGreaterThanOrEqual(403);
  });

  it("central insurance stays inside its organization in both legacy and workflow case lists", async () => {
    const own = await world();
    const foreign = await world();
    for (const path of ["/api/accidents?view=claims&pageSize=100", "/api/accident-cases?pageSize=100", "/api/insurance-center/claims?pageSize=100"]) {
      const result = await own.c.ins.get(path);
      expect(result.status, `${path}: ${JSON.stringify(result.body)}`).toBe(200);
      const ids = result.body.data.map((row: { id: string }) => row.id);
      expect(ids).toContain(own.accA.id);
      expect(ids).not.toContain(foreign.accA.id);
    }
    expect((await own.c.ins.get(`/api/accident-cases/${foreign.accA.id}`)).status).toBe(404);
    expect((await own.c.ins.get(`/api/accidents/${foreign.accA.id}`)).status).toBe(404);
  });

  it("the central insurance desk reads claim documents only during insurance stages", async () => {
    const w = await world();
    await db.update(accidents).set({ workflowStage: "DRAFT" }).where(eq(accidents.id, w.accB.id));
    const uploaded = await w.c.sa.upload(`/api/accident-cases/${w.accB.id}/attachments?category=DRIVER_ID`, PDF_BYTES, "application/pdf", "post");
    expect(uploaded.status, JSON.stringify(uploaded.body)).toBe(201);
    await db.update(accidents).set({ workflowStage: "CLAIM_IN_PROGRESS" }).where(eq(accidents.id, w.accB.id));
    const url = `/api/accident-cases/${w.accB.id}/attachments/${uploaded.body.data.id}/file`;
    expect((await w.c.ins.get(url)).status).toBe(200);
    expect((await w.c.finB.get(url)).status).toBe(404);
    await db.update(accidents).set({ workflowStage: "AWAITING_TECHNICAL_DECISION" }).where(eq(accidents.id, w.accB.id));
    expect((await w.c.ins.get(url)).status).toBe(404);
  });

  it("can open the claim cases of every project, but cannot close, reopen or edit basic data", async () => {
    const w = await world();
    expect((await w.c.ins.get(`/api/accident-cases/${w.accA.id}`)).status).toBe(200);
    expect((await w.c.ins.get(`/api/accident-cases/${w.accB.id}`)).status).toBe(200);
    for (const to of ["CLOSED", "AWAITING_FINAL_CLOSURE"]) expect([403, 409]).toContain((await w.c.ins.post(`/api/accident-cases/${w.accA.id}/transition`, { to, reason: "سبب", resolution: "x" })).status);
    expect([403, 409]).toContain((await w.c.ins.patch(`/api/accident-cases/${w.accA.id}`, { description: "تعديل غير مسموح" })).status);
    // The central desk can work an unassigned claim in project B.
    const claimCase = (await w.c.ins.get(`/api/accident-cases/${w.accB.id}`)).body.data;
    expect(claimCase.actions).toContain("claim");
    expect((await w.c.ins.put(`/api/accident-cases/${w.accB.id}/claim`, { insurerName: "شركة التأمين التجريبية", claimNumber: "CENTRAL-B", filedAt: "2026-06-01" })).status).toBe(200);
    // a project manager and a finance officer never get the central window
    const pmClaims = ((await w.c.pmA.get("/api/insurance-center/claims")).body.data as { id: string }[]).map((r) => r.id);
    expect(pmClaims.sort()).toEqual([w.accA.id, w.accA2.id].sort()); // a project manager sees his own project's claims, never project B's
    expect((await w.c.finA.get(`/api/accident-cases/${w.accA.id}`)).status).toBe(404);
  });
});

describe("the system administrator links users to projects", () => {
  it("assigning and removing projects changes what the finance officer sees at once; only the administrator can; changes are audited", async () => {
    const w = await world();
    const { users: usersT } = await import("../src/db/schema/index.js");
    const [b] = await db.select({ id: usersT.id }).from(usersT).where(eq(usersT.email, (await w.c.finB.get("/api/auth/me")).body.data.email));
    const list = (await w.c.sa.get(`/api/users/${b!.id}/projects`)).body.data as { id: string; member: boolean }[];
    expect(list.filter((p) => p.member).map((p) => p.id)).toEqual([w.pB.id]);
    // Project-scoped user administration cannot enumerate all project names or memberships.
    expect((await w.c.pmA.get(`/api/users/${b!.id}/projects`)).status).toBe(403);
    // finance cannot manage memberships
    expect((await w.c.finA.put(`/api/users/${b!.id}/projects`, { projectIds: [w.pA.id] })).status).toBe(403);
    expect((await w.c.sa.put(`/api/users/${b!.id}/projects`, { projectIds: [w.pA.id, w.pB.id] })).body.data).toEqual({ added: 1, removed: 0 });
    expect((await overview(w.c.finB)).claims.count).toBe(3); // sees both projects now
    expect((await w.c.sa.put(`/api/users/${b!.id}/projects`, { projectIds: [w.pA.id] })).body.data).toEqual({ added: 0, removed: 1 });
    const only = await overview(w.c.finB);
    expect(only.projects.map((p: { projectId: string }) => p.projectId)).toEqual([w.pA.id]);
    expect((await w.c.sa.put(`/api/users/${b!.id}/projects`, { projectIds: [randomUUID()] })).status).toBe(400);
    const { auditLogs } = await import("../src/db/schema/index.js");
    const logs = (await db.select().from(auditLogs).where(eq(auditLogs.entityId, w.pA.id))).filter((l) => l.action === "PROJECT_MEMBER_ADDED");
    expect(logs.length).toBeGreaterThan(0);
  });
});
