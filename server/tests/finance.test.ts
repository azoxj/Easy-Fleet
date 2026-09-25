import { and, eq } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { db } from "../src/db/client.js";
import { auditLogs, fuelTransactions, invoices, notifications, violations } from "../src/db/schema/index.js";
import { setClock } from "../src/lib/clock.js";
import { createMaintenance, createProject, createUser, createVehicle, defaultOrgId, login, PDF_BYTES, userAndClient } from "./helpers.js";

beforeEach(() => setClock(new Date("2026-06-15T09:00:00Z")));
afterEach(() => setClock(null));

const notesOf = async (userId: string) => (await db.select().from(notifications).where(eq(notifications.userId, userId))).map((n) => n.type);

async function setup() {
  const pm = await createUser(["PROJECT_MANAGER"]);
  const user = await createUser(["USER"]);
  const fin = await createUser(["FINANCE"]);
  const fin2 = await createUser(["FINANCE"]);
  const pA = await createProject({ managerId: pm.id, members: [user.id] });
  const pB = await createProject();
  const vA = await createVehicle(pA.id);
  return { pm, user, fin, fin2, pA, pB, vA, pmc: await login(pm.email), uc: await login(user.email), fc: await login(fin.email), fc2: await login(fin2.email) };
}

describe("invoices — full workflow", () => {
  it("DRAFT → SUBMITTED → UNDER_REVIEW → TRANSFER_PENDING → TRANSFERRED → PAID with receipt, audit and notifications", async () => {
    const { user, fin, pA, vA, uc, fc } = await setup();
    // server computes total; client cannot set status/total
    expect((await uc.post("/api/invoices", { projectId: pA.id, amount: "100", invoiceDate: "2026-06-10", status: "APPROVED" })).status).toBe(400);
    const c = await uc.post("/api/invoices", { projectId: pA.id, vehicleId: vA.id, invoiceNumber: "V-77", description: "إطارات", amount: "1000.00", tax: "150.00", invoiceDate: "2026-06-10", dueDate: "2026-06-30" });
    expect(c.status).toBe(201);
    expect(c.body.data).toMatchObject({ status: "DRAFT", total: "1150.00", projectId: pA.id, createdBy: user.id });
    const id = c.body.data.id;

    // submit needs the invoice file
    expect((await uc.post(`/api/invoices/${id}/submit`)).status).toBe(409);
    expect((await uc.upload(`/api/invoices/${id}/file`, PDF_BYTES)).status).toBe(201);
    expect((await uc.post(`/api/invoices/${id}/submit`)).body.data.status).toBe("SUBMITTED");
    expect(await notesOf(fin.id)).toContain("INVOICE_SUBMITTED");

    // finance reviews and approves → goes straight to TRANSFER_PENDING
    expect((await fc.post(`/api/invoices/${id}/start-review`)).body.data.status).toBe("UNDER_REVIEW");
    expect((await fc.post(`/api/invoices/${id}/approve`)).body.data.status).toBe("TRANSFER_PENDING");
    expect(await notesOf(user.id)).toContain("INVOICE_APPROVED");

    // transfer requires a receipt uploaded by the same finance user
    const bad = await fc.post(`/api/invoices/${id}/transfer`, { transferDate: "2026-06-15", amount: "1150.00", bank: "الراجحي", reference: "TRX-1", receiptFileId: c.body.data.id });
    expect(bad.status).toBe(400);
    const receipt = await fc.upload(`/api/invoices/${id}/receipt`, PDF_BYTES, "application/pdf", "post");
    expect(receipt.status).toBe(201);
    const receiptFileId = receipt.body.data.receiptFileId;
    expect((await fc.post(`/api/invoices/${id}/transfer`, { transferDate: "2026-06-16", amount: "1150.00", bank: "الراجحي", reference: "TRX-1", receiptFileId })).status).toBe(400); // future date
    expect((await fc.post(`/api/invoices/${id}/transfer`, { transferDate: "2026-06-15", amount: "2000.00", bank: "الراجحي", reference: "TRX-1", receiptFileId })).status).toBe(400); // > total
    const t = await fc.post(`/api/invoices/${id}/transfer`, { transferDate: "2026-06-15", amount: "1150.00", bank: "الراجحي", reference: "TRX-1", receiptFileId });
    expect(t.status).toBe(200);
    expect(t.body.data.status).toBe("TRANSFERRED");
    expect(await notesOf(user.id)).toContain("INVOICE_TRANSFERRED");
    expect((await fc.post(`/api/invoices/${id}/mark-paid`)).body.data.status).toBe("PAID");

    // detail: transfer + timeline; creator may download the receipt
    const d = (await uc.get(`/api/invoices/${id}`)).body.data;
    expect(d.transfer).toMatchObject({ bank: "الراجحي", reference: "TRX-1", amount: "1150.00" });
    expect((await uc.get(`/api/invoices/${id}/receipt`)).status).toBe(200);
    const actions = (await db.select().from(auditLogs).where(eq(auditLogs.entityId, id))).map((a) => a.action);
    expect(actions).toEqual(expect.arrayContaining(["INVOICE_CREATED", "INVOICE_SUBMITTED", "INVOICE_REVIEW_STARTED", "INVOICE_APPROVED", "INVOICE_STATUS_CHANGED", "INVOICE_TRANSFERRED", "INVOICE_PAID", "FILE_DOWNLOADED"]));
    const approved = (await db.select().from(auditLogs).where(and(eq(auditLogs.entityId, id), eq(auditLogs.action, "INVOICE_APPROVED"))))[0]!;
    expect(approved.oldValue).toEqual({ status: "UNDER_REVIEW" });
    expect(approved.newValue).toEqual({ status: "APPROVED" });
    // terminal: no further action
    expect((await fc.post(`/api/invoices/${id}/approve`)).status).toBe(409);
  });

  it("separation of duties, reject reason, resubmission and invalid transitions", async () => {
    const { pA, fc, fc2, uc } = await setup();
    const own = (await fc.post("/api/invoices", { projectId: pA.id, amount: "50", invoiceDate: "2026-06-01" })).body.data;
    await fc.upload(`/api/invoices/${own.id}/file`, PDF_BYTES);
    await fc.post(`/api/invoices/${own.id}/submit`);
    expect((await fc.post(`/api/invoices/${own.id}/approve`)).status).toBe(403); // own invoice
    expect((await fc2.post(`/api/invoices/${own.id}/approve`)).body.data.status).toBe("TRANSFER_PENDING");

    const inv = (await uc.post("/api/invoices", { projectId: pA.id, amount: "70", invoiceDate: "2026-06-01" })).body.data;
    expect((await fc.post(`/api/invoices/${inv.id}/approve`)).status).toBe(409); // still DRAFT
    await uc.upload(`/api/invoices/${inv.id}/file`, PDF_BYTES);
    await uc.post(`/api/invoices/${inv.id}/submit`);
    expect((await fc.post(`/api/invoices/${inv.id}/reject`)).status).toBe(400);
    expect((await fc.post(`/api/invoices/${inv.id}/reject`, { reason: "مبلغ غير صحيح" })).body.data.status).toBe("REJECTED");
    // creator fixes and resubmits
    expect((await uc.patch(`/api/invoices/${inv.id}`, { amount: "75" })).status).toBe(200);
    expect((await uc.post(`/api/invoices/${inv.id}/submit`)).body.data.status).toBe("SUBMITTED");
    // user cannot approve (no permission)
    expect((await uc.post(`/api/invoices/${inv.id}/approve`)).status).toBe(403);
  });

  it("scope: PM of another project and other users cannot see invoices (404), USER sees only own", async () => {
    const { pA, uc, fc } = await setup();
    const inv = (await uc.post("/api/invoices", { projectId: pA.id, amount: "10", invoiceDate: "2026-06-01" })).body.data;
    const { client: otherPm } = await userAndClient(["PROJECT_MANAGER"]);
    expect((await otherPm.get(`/api/invoices/${inv.id}`)).status).toBe(404);
    expect((await otherPm.get(`/api/invoices/${inv.id}/file`)).status).toBe(404);
    const other = await createUser(["USER"]);
    await db.execute(`insert into project_users (project_id, user_id) values ('${pA.id}', '${other.id}')`);
    const oc = await login(other.email);
    expect((await oc.get(`/api/invoices/${inv.id}`)).status).toBe(404); // USER = ASSIGNED scope (own only)
    expect((await oc.get("/api/invoices")).body.data).toHaveLength(0);
    expect((await fc.get(`/api/invoices/${inv.id}`)).status).toBe(200);
    // USER cannot create in a project they are not a member of
    const pX = await createProject();
    expect((await uc.post("/api/invoices", { projectId: pX.id, amount: "1", invoiceDate: "2026-06-01" })).status).toBe(403);
  });

  it("overdue filter uses the server date", async () => {
    const { pA, uc, fc } = await setup();
    const inv = (await uc.post("/api/invoices", { projectId: pA.id, amount: "10", invoiceDate: "2026-05-01", dueDate: "2026-06-01" })).body.data;
    await uc.upload(`/api/invoices/${inv.id}/file`, PDF_BYTES);
    await uc.post(`/api/invoices/${inv.id}/submit`);
    const list = (await fc.get("/api/invoices?overdue=true&pageSize=100")).body.data;
    expect(list.find((i: { id: string }) => i.id === inv.id)).toMatchObject({ overdue: true });
  });
});

describe("expenses", () => {
  it("submit → approve / reject with separation of duties and notifications", async () => {
    const { user, pA, vA, uc, fc } = await setup();
    expect((await uc.post("/api/expenses", { projectId: pA.id, category: "OTHER", amount: "20", expenseDate: "2026-06-20" })).status).toBe(400); // future
    const e = await uc.post("/api/expenses", { projectId: pA.id, vehicleId: vA.id, category: "OTHER", amount: "200.50", expenseDate: "2026-06-14", description: "غسيل" });
    expect(e.status).toBe(201);
    expect(e.body.data.status).toBe("SUBMITTED");
    expect((await uc.post(`/api/expenses/${e.body.data.id}/approve`)).status).toBe(403);
    expect((await fc.post(`/api/expenses/${e.body.data.id}/approve`)).body.data.status).toBe("APPROVED");
    expect(await notesOf(user.id)).toContain("EXPENSE_APPROVED");
    const e2 = (await uc.post("/api/expenses", { projectId: pA.id, category: "FUEL", amount: "30", expenseDate: "2026-06-14" })).body.data;
    expect((await fc.post(`/api/expenses/${e2.id}/reject`, {})).status).toBe(400);
    expect((await fc.post(`/api/expenses/${e2.id}/reject`, { reason: "مكرر" })).body.data.status).toBe("REJECTED");
    // own expense cannot be self-approved by finance
    const own = (await fc.post("/api/expenses", { projectId: pA.id, category: "OTHER", amount: "5", expenseDate: "2026-06-14" })).body.data;
    expect((await fc.post(`/api/expenses/${own.id}/approve`)).status).toBe(403);
    // vehicle must belong to the project
    const vB = await createVehicle((await createProject()).id);
    expect((await uc.post("/api/expenses", { projectId: pA.id, vehicleId: vB.id, category: "OTHER", amount: "1", expenseDate: "2026-06-14" })).status).toBe(400);
  });
});

describe("finance dashboard & project financials (single cost ledger)", () => {
  it("sums fuel, closed maintenance, paid violations and approved expenses per project/month", async () => {
    const { pm, pA, vA, uc, fc, pmc } = await setup();
    const orgId = await defaultOrgId();
    await db.insert(fuelTransactions).values({ organizationId: orgId, vehicleId: vA.id, projectId: pA.id, fueledAt: new Date("2026-06-05T08:00:00Z"), liters: "50.00", pricePerLiter: "2.330", total: "116.50", createdBy: pm.id });
    await db.insert(violations).values({ organizationId: orgId, vehicleId: vA.id, projectId: pA.id, violationDate: "2026-06-02", type: "سرعة", amount: "300.00", status: "PAID", paymentDate: "2026-06-03", createdBy: pm.id });
    await db.insert(violations).values({ organizationId: orgId, vehicleId: vA.id, projectId: pA.id, violationDate: "2026-06-02", type: "وقوف", amount: "100.00", status: "OPEN", createdBy: pm.id }); // not a cost yet
    const mr = await createMaintenance(vA, pm.id, { status: "CLOSED", closedAt: new Date("2026-06-10T10:00:00Z") });
    await db.execute(`insert into maintenance_parts (organization_id, maintenance_request_id, part_name, quantity, unit_price, total) values ('${orgId}', '${mr.id}', 'x', 2, 100, 200)`);
    const e = (await uc.post("/api/expenses", { projectId: pA.id, category: "OTHER", amount: "83.50", expenseDate: "2026-06-11" })).body.data;
    await fc.post(`/api/expenses/${e.id}/approve`);

    const dash = (await fc.get("/api/finance/dashboard")).body.data;
    const row = dash.byProject.find((p: { projectId: string }) => p.projectId === pA.id);
    expect(row.total).toBe("700.00"); // 116.50 + 300 + 200 + 83.50
    const fin = (await pmc.get(`/api/projects/${pA.id}/financials?months=3`)).body.data;
    expect(fin.totalCosts).toBe("700.00");
    const june = fin.months.find((m: { month: string }) => m.month === "2026-06");
    expect(june.byCategory).toMatchObject({ FUEL: "116.50", VIOLATION: "300.00", MAINTENANCE: "200.00", OTHER: "83.50" });
    // PM of another project cannot read these financials
    const { client: otherPm } = await userAndClient(["PROJECT_MANAGER"]);
    expect((await otherPm.get(`/api/projects/${pA.id}/financials`)).status).toBe(404);
    // total in the invoices table is always amount + tax (DB CHECK)
    await expect(db.insert(invoices).values({ organizationId: orgId, projectId: pA.id, amount: "10", tax: "1", total: "12", invoiceDate: "2026-06-01", createdBy: pm.id })).rejects.toThrow();
  });
});
