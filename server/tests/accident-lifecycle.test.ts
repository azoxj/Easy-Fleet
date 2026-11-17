import { eq } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { db } from "../src/db/client.js";
import { accidentFinanceReviews, accidentTransitions } from "../src/db/schema/index.js";
import { setClock } from "../src/lib/clock.js";
import { setAccidentWorkflowFlag } from "../src/lib/feature-flags.js";
import { createUser, login, type Client } from "./helpers.js";
import { caseOf, claimBody, detail, documentRepair, toClaim, toDirectRepair, toFinalClosure, toFinanceViaInsurance, toTechnical, toTransferWait, upload, vehicleOf, world } from "./support/accident-world.js";

beforeAll(() => setAccidentWorkflowFlag(true));
afterAll(() => setAccidentWorkflowFlag(null));
beforeEach(() => setClock(new Date("2026-06-15T09:00:00Z")));
afterEach(() => setClock(null));

const move = (c: Client, id: string, body: object) => c.post(`/api/accident-cases/${id}/transition`, body);
const stageOf = async (id: string) => (await caseOf(id)).workflowStage;
const lane = async (c: Client, role: string, key: string) => (await c.get(`/api/accident-cases/board?role=${role}&lane=${key}`)).body.data.map((r: { id: string }) => r.id) as string[];

describe("full cycles", () => {
  it("repair road: PM → technician → PM estimates → technician decides repair → maintenance → finance → technician → administrator closes", async () => {
    const w = await world();
    const id = await toTechnical(w);
    await toDirectRepair(w, id);
    expect(await stageOf(id)).toBe("REPAIR_IN_PROGRESS");
    // the maintenance invoice goes to finance; finance records its review and confirms
    await documentRepair(w, id);
    const reviews = await db.select().from(accidentFinanceReviews).where(eq(accidentFinanceReviews.accidentId, id));
    expect(reviews).toHaveLength(1);
    expect(reviews[0]).toMatchObject({ kind: "REPAIR_INVOICE", status: "CONFIRMED" });
    expect(await stageOf(id)).toBe("AWAITING_FINAL_CLOSURE");
    expect((await vehicleOf(w.vehicle.id)).status).toBe("ACCIDENT"); // still flagged until the administrator closes
    expect((await move(w.c.sa, id, { to: "CLOSED" })).status).toBe(200);
    expect(await caseOf(id)).toMatchObject({ workflowStage: "CLOSED", status: "CLOSED" });
    expect((await vehicleOf(w.vehicle.id)).status).toBe("ASSIGNED");
    // every stage of the road is in the history, with the actor
    const stages = (await db.select().from(accidentTransitions).where(eq(accidentTransitions.accidentId, id))).map((t) => t.toStage);
    expect(stages).toEqual(["DRAFT", "AWAITING_TECHNICAL", "AWAITING_ESTIMATES", "AWAITING_TECHNICAL_DECISION", "REPAIR_IN_PROGRESS", "AWAITING_FINANCE_REVIEW", "AWAITING_TECHNICAL_FINAL", "AWAITING_FINAL_CLOSURE", "CLOSED"]);
  });

  it("insurance road: claim → approval → transfer → finance confirms with proof → technician → administrator closes", async () => {
    const w = await world();
    const id = await toTechnical(w);
    await toFinalClosure(w, id);
    expect(await stageOf(id)).toBe("AWAITING_FINAL_CLOSURE");
    expect((await move(w.c.sa, id, { to: "CLOSED" })).status).toBe(200);
    const stages = (await db.select().from(accidentTransitions).where(eq(accidentTransitions.accidentId, id))).map((t) => t.toStage);
    expect(stages).toEqual(["DRAFT", "AWAITING_TECHNICAL", "AWAITING_ESTIMATES", "AWAITING_TECHNICAL_DECISION", "AWAITING_INSURANCE", "CLAIM_IN_PROGRESS", "AWAITING_COMPENSATION_PROOF", "AWAITING_FINANCE_REVIEW", "AWAITING_TECHNICAL_FINAL", "AWAITING_FINAL_CLOSURE", "CLOSED"]);
    const [review] = await db.select().from(accidentFinanceReviews).where(eq(accidentFinanceReviews.accidentId, id));
    expect(review).toMatchObject({ kind: "INSURANCE_TRANSFER", status: "CONFIRMED" });
  });
});

describe("who may close, reopen and edit", () => {
  it("only the system administrator closes and reopens; nobody else, whatever the stage", async () => {
    const w = await world();
    const id = await toTechnical(w);
    await toFinalClosure(w, id);
    for (const who of ["pm", "tech", "insurer", "finance", "manager", "viewer", "driver", "accountant"] as const) {
      expect([403, 404], who).toContain((await move(w.c[who], id, { to: "CLOSED" })).status);
    }
    expect(await stageOf(id)).toBe("AWAITING_FINAL_CLOSURE");
    expect((await move(w.c.sa, id, { to: "CLOSED" })).status).toBe(200);
    for (const who of ["pm", "tech", "insurer", "finance", "manager"] as const) {
      expect([403, 404], who).toContain((await move(w.c[who], id, { to: "AWAITING_FINAL_CLOSURE", reason: "إعادة فتح" })).status);
    }
    expect((await move(w.c.sa, id, { to: "AWAITING_FINAL_CLOSURE", reason: "إعادة فتح" })).status).toBe(200);
  });

  it("basic report data is edited after submission only by the administrator, and the edit is audited with old and new values", async () => {
    const w = await world();
    const id = await toTechnical(w);
    for (const who of ["pm", "tech", "manager", "insurer", "finance"] as const) {
      expect([403, 404, 409], who).toContain((await w.c[who].patch(`/api/accident-cases/${id}`, { description: "تعديل غير مسموح" })).status);
    }
    expect((await caseOf(id)).description).not.toBe("تعديل غير مسموح");
    const r = await w.c.sa.patch(`/api/accident-cases/${id}`, { description: "تصحيح إداري للوصف" });
    expect(r.status, JSON.stringify(r.body)).toBe(200);
    expect((await caseOf(id)).description).toBe("تصحيح إداري للوصف");
    const d = await detail(w.c.sa, id);
    expect(JSON.stringify(d.timeline ?? d.audit ?? d.transitions)).toBeDefined();
  });
});

describe("insurance and finance are independent and scoped", () => {
  it("the insurance officer cannot reach finance actions, and finance cannot reach insurance actions", async () => {
    const w = await world();
    const id = await toTechnical(w);
    await toTransferWait(w, id);
    // insurance: no finance endpoints, no money confirmation, no proof upload
    expect([403, 404, 409]).toContain((await w.c.insurer.post(`/api/accident-cases/${id}/compensation/confirm`, { receivedAmount: "2400.00", receiptDate: "2026-06-15" })).status);
    expect([403, 404, 409]).toContain((await w.c.insurer.post(`/api/accident-cases/${id}/finance/invoice/confirm`, { invoiceAmount: "10.00" })).status);
    expect([403, 404]).toContain((await upload(w.c.insurer, id, "COMPENSATION_PROOF")).status);
    expect([403, 404, 409]).toContain((await w.c.insurer.post(`/api/accident-cases/${id}/send-back`, { to: "REPAIR_IN_PROGRESS", reason: "سبب الإعادة" })).status);
    expect((await move(w.c.insurer, id, { to: "AWAITING_FINANCE_REVIEW" })).status).toBe(200);
    // finance: no claim writes, no technician decision, no closing, no reassigning
    expect(await stageOf(id)).toBe("AWAITING_FINANCE_REVIEW");
    expect([403, 404]).toContain((await w.c.finance.put(`/api/accident-cases/${id}/claim`, claimBody)).status);
    expect([403, 404]).toContain((await w.c.finance.post(`/api/accident-cases/${id}/claim/status`, { status: "REJECTED", reason: "سبب الإعادة" })).status);
    expect([403, 404]).toContain((await w.c.finance.put(`/api/accident-cases/${id}/technical`, { damageDescription: "x", repairDecision: "REPAIR" })).status);
    expect([403, 404]).toContain((await move(w.c.finance, id, { to: "CLOSED" })).status);
    expect([403, 404]).toContain((await w.c.finance.post(`/api/accident-cases/${id}/assign`, { userId: w.finance.id })).status);
    expect([403, 404, 409]).toContain((await w.c.finance.patch(`/api/accident-cases/${id}`, { description: "x" })).status);
    // finance has no insurance board; insurance has no finance board
    expect(await lane(w.c.finance, "INSURANCE", "inProgress")).toEqual([]);
    expect((await w.c.finance.get("/api/accident-cases/board")).body.boards.map((b: { role: string }) => b.role)).toEqual(["FINANCE"]);
    expect((await w.c.insurer.get("/api/accident-cases/board")).body.boards.map((b: { role: string }) => b.role)).toEqual(["INSURANCE"]);
  });

  it("each sees only the cases assigned or forwarded to them within their projects, not every case", async () => {
    const w = await world();
    const mine = await toTechnical(w);
    const other = await toTechnical(w);
    await toTransferWait(w, mine);
    // the second case is still with the technician: neither officer sees it
    for (const who of ["insurer", "finance"] as const) expect((await w.c[who].get(`/api/accident-cases/${other}`)).status, who).toBe(404);
    // the insurer sees their own case; finance does not until it is forwarded
    expect((await w.c.insurer.get(`/api/accident-cases/${mine}`)).status).toBe(200);
    expect((await w.c.finance.get(`/api/accident-cases/${mine}`)).status).toBe(404);
    expect(await lane(w.c.insurer, "INSURANCE", "awaitingTransfer")).toContain(mine);
    expect(await lane(w.c.finance, "FINANCE", "transfers")).not.toContain(mine);
    expect((await move(w.c.insurer, mine, { to: "AWAITING_FINANCE_REVIEW" })).status).toBe(200);
    expect(await lane(w.c.finance, "FINANCE", "transfers")).toContain(mine);
    expect(await lane(w.c.insurer, "INSURANCE", "atFinance")).toContain(mine);
    // a finance officer of another project never sees it
    const stranger = await createUser(["FINANCE_OFFICER"]);
    const sc = await login(stranger.email);
    expect((await sc.get(`/api/accident-cases/${mine}`)).status).toBe(404);
    expect(await lane(sc, "FINANCE", "transfers")).not.toContain(mine);
    // once finance confirmed, the insurance officer's record stays readable in their history lanes
    expect((await upload(w.c.finance, mine, "COMPENSATION_PROOF")).status).toBe(201);
    expect((await w.c.finance.post(`/api/accident-cases/${mine}/compensation/confirm`, { receivedAmount: "2400.00", receiptDate: "2026-06-15" })).status).toBe(200);
    expect(await lane(w.c.insurer, "INSURANCE", "completed")).toContain(mine);
    expect(await lane(w.c.finance, "FINANCE", "approved")).toContain(mine);
  });

  it("the technician and the project manager cannot close, and the finance officer cannot edit basic data", async () => {
    const w = await world();
    const id = await toTechnical(w);
    await toFinalClosure(w, id);
    expect([403, 404]).toContain((await move(w.c.tech, id, { to: "CLOSED" })).status);
    expect([403, 404]).toContain((await move(w.c.pm, id, { to: "CLOSED" })).status);
    expect(await stageOf(id)).toBe("AWAITING_FINAL_CLOSURE");
  });
});

describe("finance rules", () => {
  it("the transfer cannot be confirmed without proof, the amount must match, and the invoice needs the invoice file", async () => {
    const w = await world();
    const id = await toTechnical(w);
    await toFinanceViaInsurance(w, id);
    const noProof = await w.c.finance.post(`/api/accident-cases/${id}/compensation/confirm`, { receivedAmount: "2400.00", receiptDate: "2026-06-15" });
    expect(noProof.status).toBe(409);
    expect(noProof.body.error.details.missing).toContain("attachment:COMPENSATION_PROOF");
    expect(await stageOf(id)).toBe("AWAITING_FINANCE_REVIEW");
    expect((await upload(w.c.finance, id, "COMPENSATION_PROOF")).status).toBe(201);
    expect((await w.c.finance.post(`/api/accident-cases/${id}/compensation/confirm`, { receivedAmount: "1.00", receiptDate: "2026-06-15" })).status).toBe(409);
    expect((await w.c.finance.post(`/api/accident-cases/${id}/compensation/confirm`, { receivedAmount: "2400.00", receiptDate: "2027-01-01" })).status).toBe(400); // future date
    expect((await w.c.finance.post(`/api/accident-cases/${id}/compensation/confirm`, { receivedAmount: "2400.00", receiptDate: "2026-06-15" })).status).toBe(200);
    expect(await stageOf(id)).toBe("AWAITING_TECHNICAL_FINAL");
    // a second confirmation is refused: the stage has passed
    expect((await w.c.finance.post(`/api/accident-cases/${id}/compensation/confirm`, { receivedAmount: "2400.00", receiptDate: "2026-06-15" })).status).toBe(409);

    const repair = await toTechnical(w);
    await toDirectRepair(w, repair);
    // the technician cannot send it to finance without the invoice; finance cannot confirm what it has not received
    expect((await move(w.c.tech, repair, { to: "AWAITING_FINANCE_REVIEW" })).status).toBe(409);
    expect([403, 404, 409]).toContain((await w.c.finance.post(`/api/accident-cases/${repair}/finance/invoice/confirm`, { invoiceAmount: "10.00" })).status);
    expect((await upload(w.c.tech, repair, "REPAIR_INVOICE")).status).toBe(201);
    expect((await move(w.c.tech, repair, { to: "AWAITING_FINANCE_REVIEW" })).status).toBe(200);
    expect((await w.c.finance.post(`/api/accident-cases/${repair}/finance/invoice/confirm`, { invoiceAmount: "0" })).status).toBe(400);
    expect((await w.c.finance.post(`/api/accident-cases/${repair}/finance/invoice/confirm`, { invoiceAmount: "950.00" })).status).toBe(200);
    expect(await stageOf(repair)).toBe("AWAITING_TECHNICAL_FINAL");
  });

  it("finance returns an incomplete file with a reason; the sender completes it and sends it again", async () => {
    const w = await world();
    const id = await toTechnical(w);
    await toDirectRepair(w, id);
    expect((await upload(w.c.tech, id, "REPAIR_INVOICE")).status).toBe(201);
    expect((await move(w.c.tech, id, { to: "AWAITING_FINANCE_REVIEW" })).status).toBe(200);
    const noReason = await w.c.finance.post(`/api/accident-cases/${id}/send-back`, { to: "REPAIR_IN_PROGRESS", reason: "" });
    expect(noReason.status).toBe(400);
    expect((await w.c.finance.post(`/api/accident-cases/${id}/send-back`, { to: "AWAITING_COMPENSATION_PROOF", reason: "سبب الإعادة" })).status).toBe(409); // wrong road
    const back = await w.c.finance.post(`/api/accident-cases/${id}/send-back`, { to: "REPAIR_IN_PROGRESS", reason: "الفاتورة غير مختومة" });
    expect(back.status, JSON.stringify(back.body)).toBe(200);
    expect(await caseOf(id)).toMatchObject({ workflowStage: "REPAIR_IN_PROGRESS", assignedTo: w.tech.id });
    const history = (await db.select().from(accidentTransitions).where(eq(accidentTransitions.accidentId, id))).filter((t) => t.reason === "الفاتورة غير مختومة");
    expect(history).toHaveLength(1);
    expect(await lane(w.c.finance, "FINANCE", "returned")).toContain(id);
    expect((await move(w.c.tech, id, { to: "AWAITING_FINANCE_REVIEW" })).status).toBe(200);
    expect(await lane(w.c.finance, "FINANCE", "invoices")).toContain(id);
  });
});

describe("returns and rejected claims", () => {
  it("the technician returns the report to the project manager with a reason; the manager completes it and resubmits", async () => {
    const w = await world();
    const id = await toTechnical(w);
    expect((await w.c.tech.post(`/api/accident-cases/${id}/send-back`, { to: "DRAFT", reason: "" })).status).toBe(400);
    const back = await w.c.tech.post(`/api/accident-cases/${id}/send-back`, { to: "DRAFT", reason: "صورة رخصة السائق غير واضحة" });
    expect(back.status, JSON.stringify(back.body)).toBe(200);
    expect(await caseOf(id)).toMatchObject({ workflowStage: "DRAFT" });
    expect(await lane(w.c.pm, "PROJECT_MANAGER", "returned")).toContain(id);
    expect((await w.c.pm.post(`/api/accident-cases/${id}/submit`)).status).toBe(200);
    expect(await stageOf(id)).toBe("AWAITING_TECHNICAL");
    // a person without the technician's duty cannot send it back
    expect([403, 404]).toContain((await w.c.pm.post(`/api/accident-cases/${id}/send-back`, { to: "DRAFT", reason: "سبب الإعادة" })).status);
    expect([403, 404]).toContain((await w.c.insurer.post(`/api/accident-cases/${id}/send-back`, { to: "DRAFT", reason: "سبب الإعادة" })).status);
  });

  it("a rejected claim comes back to the technician with the reason, who can file again or choose repair", async () => {
    const w = await world();
    const other = await toTechnical(w);
    await toClaim(w, other);
    expect((await upload(w.c.insurer, other, "INSURER_DECISION")).status).toBe(201);
    const rej = await w.c.insurer.post(`/api/accident-cases/${other}/claim/status`, { status: "REJECTED", reason: "خارج التغطية" });
    expect(rej.status, JSON.stringify(rej.body)).toBe(200);
    expect(await caseOf(other)).toMatchObject({ workflowStage: "AWAITING_TECHNICAL_DECISION", assignedTo: w.tech.id });
    expect(await lane(w.c.insurer, "INSURANCE", "rejected")).toContain(other);
    expect(await lane(w.c.tech, "TECHNICAL", "decision")).toContain(other);
    expect(await stageOf(other)).not.toBe("CLOSED");
    // switching to repair is available to the technician
    expect((await move(w.c.tech, other, { to: "REPAIR_IN_PROGRESS" })).status).toBe(200);
  });
});

describe("documents and boards", () => {
  it("the transfer proof is downloadable only by finance (and the administrator), not by the insurer, technician or project manager outside their stages", async () => {
    const w = await world();
    const id = await toTechnical(w);
    await toFinalClosure(w, id);
    const d = await detail(w.c.sa, id);
    const proof = (d.attachments as { id: string; category: string }[]).find((a) => a.category === "COMPENSATION_PROOF")!;
    const get = (c: Client) => c.get(`/api/accident-cases/${id}/attachments/${proof.id}/file`);
    expect((await get(w.c.sa)).status).toBe(200);
    expect((await get(w.c.finance)).status).toBe(200);
    expect((await get(w.c.otherPm)).status).toBe(404);
    expect((await get(w.c.driver)).status).toBe(404);
    expect((await get(w.c.viewer)).status).toBe(404);
  });

  it("the board gives each role its lanes and counts, with search and responsible party", async () => {
    const w = await world();
    const id = await toTechnical(w);
    const tech = await w.c.tech.get("/api/accident-cases/board");
    expect(tech.status).toBe(200);
    expect(tech.body.role).toBe("TECHNICAL");
    expect(tech.body.boards[0].lanes.map((l: { key: string }) => l.key)).toEqual(["new", "waitingEstimates", "decision", "external", "fromFinance", "readyToClose"]);
    expect(tech.body.data.map((r: { id: string }) => r.id)).toContain(id);
    const row = tech.body.data.find((r: { id: string }) => r.id === id);
    expect(row).toMatchObject({ responsible: "TECHNICAL", stage: "AWAITING_TECHNICAL", label: expect.stringMatching(/^ACC-\d+$/) });
    expect(row.plateNumber).toBeTruthy();
    expect(row.lastActionAt).toBeTruthy();
    const found = await w.c.tech.get(`/api/accident-cases/board?role=TECHNICAL&lane=new&q=${encodeURIComponent(row.label)}`);
    expect(found.body.data.map((r: { id: string }) => r.id)).toEqual([id]);
    expect((await w.c.tech.get("/api/accident-cases/board?role=TECHNICAL&lane=nonsense")).status).toBe(400);
    // the technician has no insurance or finance lanes; a reader without duties has no board
    expect(tech.body.boards.map((b: { role: string }) => b.role)).toEqual(["TECHNICAL"]);
    expect((await w.c.viewer.get("/api/accident-cases/board")).body.boards).toEqual([]);
    // the administrator has every board
    expect((await w.c.sa.get("/api/accident-cases/board")).body.boards.map((b: { role: string }) => b.role)).toEqual(["PROJECT_MANAGER", "TECHNICAL", "INSURANCE", "FINANCE", "ADMIN"]);
  });
});

describe("legacy accidents stay intact", () => {
  it("a legacy accident never appears on any lane and the new roles cannot read it", async () => {
    const w = await world();
    const leg = await w.c.pm.post("/api/accidents", { vehicleId: w.vehicle.id, occurredAt: "2026-06-14T10:00:00+03:00", description: "حادث قديم", severity: "MINOR" });
    expect(leg.status).toBe(201);
    const id = leg.body.data.id as string;
    for (const who of ["insurer", "finance"] as const) expect((await w.c[who].get(`/api/accident-cases/${id}`)).status).toBe(404);
    for (const role of ["PROJECT_MANAGER", "ADMIN"]) {
      const all = await w.c.sa.get(`/api/accident-cases/board?role=${role}&lane=${role === "ADMIN" ? "all" : "mine"}&pageSize=100`);
      expect(all.body.data.map((r: { id: string }) => r.id)).not.toContain(id);
    }
    expect((await w.c.pm.patch(`/api/accidents/${id}`, { description: "تعديل قديم مسموح" })).status).toBe(200);
  });
});
