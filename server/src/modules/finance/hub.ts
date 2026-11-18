import { and, desc, eq, ilike, inArray, or, sql, type SQL } from "drizzle-orm";
import { Router } from "express";
import { z } from "zod";
import { db } from "../../db/client.js";
import { accidentClaims, accidentFinanceReviews, accidents, expenses, invoiceTransfers, invoices, projects, users, vehicles } from "../../db/schema/index.js";
import { ctx } from "../../http/context.js";
import { requirePermission } from "../../http/middleware.js";
import { isoDate, paged, pagination, uuid } from "../../http/validate.js";
import { today } from "../../lib/clock.js";
import { caseVisibility, holdsScopedSql } from "../accidents/visibility.js";
import { expenseScope } from "./expenses.js";
import { invoiceScope } from "./invoices.js";

/**
 * The finance office screens beyond invoices and expenses: the overview (claims, dues, paid, collected, waiting for me),
 * the financial side of accidents and insurance claims, and the transfers with their proofs.
 * Everything is limited to the projects the user's finance permissions reach (PROJECT scope = membership); nothing is org-wide
 * unless the user holds an ALL scope. Amounts are read from the original records: an invoice is counted once, a transfer once.
 */
export const financeHubRouter = Router();

const money = (v: unknown) => Number(v ?? 0).toFixed(2);
const SETTLED = ["TRANSFERRED", "PAID", "CANCELLED", "REJECTED", "DRAFT"];

/** Accident rows the finance permissions reach by project (amounts only: documents follow the case visibility rules). */
const financeAccidents = (a: ReturnType<typeof ctx>["access"]): SQL =>
  and(eq(accidents.organizationId, a.orgId), sql`${accidents.workflowStage} is not null and ${accidents.workflowStage} <> 'DRAFT'`, holdsScopedSql(a, "finance.read"))!;

financeHubRouter.get("/finance/overview", requirePermission("finance.read"), async (req, res) => {
  const { access: a } = ctx(req);
  const t = today();
  const inv = a.has("invoices.read") ? invoiceScope(a) : sql`false`;

  const [k] = await db
    .select({
      claimedCount: sql<number>`count(*) filter (where ${invoices.status} not in ('DRAFT','CANCELLED','REJECTED'))::int`,
      claimedAmount: sql<string>`coalesce(sum(${invoices.total}) filter (where ${invoices.status} not in ('DRAFT','CANCELLED','REJECTED')), 0)::text`,
      dueCount: sql<number>`count(*) filter (where ${invoices.status} in ('SUBMITTED','UNDER_REVIEW','APPROVED','TRANSFER_PENDING'))::int`,
      dueAmount: sql<string>`coalesce(sum(${invoices.total}) filter (where ${invoices.status} in ('SUBMITTED','UNDER_REVIEW','APPROVED','TRANSFER_PENDING')), 0)::text`,
      overdueCount: sql<number>`count(*) filter (where ${invoices.dueDate} < ${t}::date and ${invoices.status} not in (${sql.join(SETTLED.map((x) => sql`${x}`), sql`, `)}))::int`,
      overdueAmount: sql<string>`coalesce(sum(${invoices.total}) filter (where ${invoices.dueDate} < ${t}::date and ${invoices.status} not in (${sql.join(SETTLED.map((x) => sql`${x}`), sql`, `)})), 0)::text`,
      paidCount: sql<number>`count(*) filter (where ${invoices.status} in ('TRANSFERRED','PAID'))::int`,
      paidAmount: sql<string>`coalesce(sum(${invoices.total}) filter (where ${invoices.status} in ('TRANSFERRED','PAID')), 0)::text`,
      toReview: sql<number>`count(*) filter (where ${invoices.status} in ('SUBMITTED','UNDER_REVIEW') and ${invoices.createdBy} <> ${a.userId})::int`,
      toTransfer: sql<number>`count(*) filter (where ${invoices.status} = 'TRANSFER_PENDING')::int`,
    })
    .from(invoices)
    .where(inv);

  const acc = a.has("finance.read") ? financeAccidents(a) : sql`false`;
  const [c] = await db
    .select({
      approved: sql<string>`coalesce(sum(${accidentClaims.approvedAmount}) filter (where ${accidentClaims.status} in ('APPROVED','COMPENSATION_RECEIVED')), 0)::text`,
      collected: sql<string>`coalesce(sum(${accidentClaims.receivedAmount}) filter (where ${accidentClaims.status} = 'COMPENSATION_RECEIVED'), 0)::text`,
      awaiting: sql<string>`coalesce(sum(${accidentClaims.approvedAmount}) filter (where ${accidentClaims.status} = 'APPROVED'), 0)::text`,
      awaitingCount: sql<number>`count(*) filter (where ${accidentClaims.status} = 'APPROVED')::int`,
    })
    .from(accidentClaims)
    .innerJoin(accidents, eq(accidents.id, accidentClaims.accidentId))
    .where(acc);
  const [f] = await db.select({ n: sql<number>`count(*)::int` }).from(accidents).where(and(acc, sql`${accidents.workflowStage} = 'AWAITING_FINANCE_REVIEW'`, sql`${accidents.workflowStage} is not null`));
  const [e] = a.has("finance.approve")
    ? await db.select({ n: sql<number>`count(*) filter (where ${expenses.createdBy} <> ${a.userId})::int` }).from(expenses).where(and(expenseScope(a, "finance.approve"), eq(expenses.status, "SUBMITTED")))
    : [{ n: 0 }];

  // Per project: open dues and what waits there, for the projects this user reaches.
  const perProject = await db
    .select({
      projectId: projects.id,
      name: projects.name,
      pending: sql<number>`count(${invoices.id}) filter (where ${invoices.status} in ('SUBMITTED','UNDER_REVIEW','APPROVED','TRANSFER_PENDING'))::int`,
      dueAmount: sql<string>`coalesce(sum(${invoices.total}) filter (where ${invoices.status} in ('SUBMITTED','UNDER_REVIEW','APPROVED','TRANSFER_PENDING')), 0)::text`,
      paidAmount: sql<string>`coalesce(sum(${invoices.total}) filter (where ${invoices.status} in ('TRANSFERRED','PAID')), 0)::text`,
    })
    .from(projects)
    .leftJoin(invoices, and(eq(invoices.projectId, projects.id), inv))
    .where(and(eq(projects.organizationId, a.orgId), a.scopeOf("finance.read") === "ALL" ? sql`true` : a.memberProjectIds.length ? inArray(projects.id, a.memberProjectIds) : sql`false`))
    .groupBy(projects.id, projects.name)
    .orderBy(projects.name);

  res.json({
    data: {
      claims: { count: k?.claimedCount ?? 0, amount: money(k?.claimedAmount) },
      due: { count: k?.dueCount ?? 0, amount: money(k?.dueAmount) },
      overdue: { count: k?.overdueCount ?? 0, amount: money(k?.overdueAmount) },
      paid: { count: k?.paidCount ?? 0, amount: money(k?.paidAmount) },
      insurance: { approved: money(c?.approved), collected: money(c?.collected), awaiting: money(c?.awaiting), awaitingCount: c?.awaitingCount ?? 0 },
      awaitingMe: { invoicesToReview: k?.toReview ?? 0, transfersToExecute: k?.toTransfer ?? 0, accidentFiles: f?.n ?? 0, expensesToApprove: e?.n ?? 0 },
      projects: perProject.map((p) => ({ ...p, dueAmount: money(p.dueAmount), paidAmount: money(p.paidAmount) })),
    },
  });
});

const AccQuery = pagination.extend({ projectId: uuid.optional(), q: z.string().trim().max(100).optional(), view: z.enum(["all", "review", "dues", "collected"]).default("all") });

/** The financial side of accidents: repair cost, claim amounts and the finance review, per project. */
financeHubRouter.get("/finance/accident-finance", requirePermission("finance.read"), async (req, res) => {
  const { access: a } = ctx(req);
  const q = AccQuery.parse(req.query);
  const where: SQL[] = [financeAccidents(a)];
  if (q.projectId) where.push(eq(accidents.projectId, q.projectId));
  if (q.q) {
    const m = /^acc-?(\d+)$/i.exec(q.q);
    where.push(m ? eq(accidents.number, Number(m[1])) : ilike(vehicles.plateNumber, `%${q.q.replace(/[%_\\]/g, "\\$&")}%`));
  }
  if (q.view === "review") where.push(sql`${accidents.workflowStage} = 'AWAITING_FINANCE_REVIEW'`);
  if (q.view === "dues") where.push(sql`${accidentClaims.status} = 'APPROVED'`);
  if (q.view === "collected") where.push(sql`${accidentClaims.status} = 'COMPENSATION_RECEIVED'`);
  else if (q.view === "all") where.push(or(sql`${accidents.repairCost} is not null`, sql`${accidentClaims.id} is not null`)!);
  const cond = and(...where);
  const base = () => db.select({
    id: accidents.id, number: accidents.number, plateNumber: vehicles.plateNumber, projectId: accidents.projectId, projectName: projects.name,
    stage: accidents.workflowStage, repairCost: accidents.repairCost,
    claimStatus: accidentClaims.status, claimedAmount: accidentClaims.claimedAmount, approvedAmount: accidentClaims.approvedAmount, receivedAmount: accidentClaims.receivedAmount,
    lastReview: sql<string | null>`(select fr.status::text from accident_finance_reviews fr where fr.accident_id = ${accidents.id} order by fr.created_at desc limit 1)`,
    lastReviewAt: sql<Date | null>`(select max(fr.created_at) from accident_finance_reviews fr where fr.accident_id = ${accidents.id})`,
  }).from(accidents).innerJoin(vehicles, eq(vehicles.id, accidents.vehicleId)).leftJoin(projects, eq(projects.id, accidents.projectId)).leftJoin(accidentClaims, eq(accidentClaims.accidentId, accidents.id));
  const [rows, [total]] = await Promise.all([
    base().where(cond).orderBy(desc(accidents.number)).limit(q.pageSize).offset((q.page - 1) * q.pageSize),
    db.select({ n: sql<number>`count(*)::int` }).from(accidents).innerJoin(vehicles, eq(vehicles.id, accidents.vehicleId)).leftJoin(accidentClaims, eq(accidentClaims.accidentId, accidents.id)).where(cond),
  ]);
  // The case screen opens only for the cases the visibility rule gives this user; the amounts above never need it.
  const ids = rows.map((r) => r.id);
  const open = ids.length ? new Set((await db.select({ id: accidents.id }).from(accidents).where(and(inArray(accidents.id, ids), caseVisibility(a)))).map((r) => r.id)) : new Set<string>();
  res.json(paged(rows.map((r) => ({ ...r, label: `ACC-${r.number}`, canOpen: open.has(r.id) })), total?.n ?? 0, q.page, q.pageSize));
});

const TrQuery = pagination.extend({ projectId: uuid.optional(), kind: z.enum(["INVOICE", "INSURANCE"]).optional(), from: isoDate.optional(), to: isoDate.optional() });

/** Payments out (invoice transfers with their receipts) and money in (insurance transfers confirmed with their proofs). */
financeHubRouter.get("/finance/transfers", requirePermission("finance.read"), async (req, res) => {
  const { access: a } = ctx(req);
  const q = TrQuery.parse(req.query);
  const rows: { kind: "INVOICE" | "INSURANCE"; id: string; date: string; amount: string; reference: string | null; projectId: string | null; projectName: string | null; subject: string; by: string | null; link: string | null; proof: string | null }[] = [];
  if (q.kind !== "INSURANCE" && a.has("invoices.read")) {
    const out = await db
      .select({ id: invoiceTransfers.id, invoiceId: invoices.id, number: invoices.number, date: invoiceTransfers.transferDate, amount: invoiceTransfers.amount, reference: invoiceTransfers.reference, bank: invoiceTransfers.bank, projectId: invoices.projectId, projectName: projects.name, by: users.name })
      .from(invoiceTransfers).innerJoin(invoices, eq(invoices.id, invoiceTransfers.invoiceId)).innerJoin(projects, eq(projects.id, invoices.projectId)).leftJoin(users, eq(users.id, invoiceTransfers.createdBy))
      .where(and(invoiceScope(a), q.projectId ? eq(invoices.projectId, q.projectId) : undefined, q.from ? sql`${invoiceTransfers.transferDate} >= ${q.from}::date` : undefined, q.to ? sql`${invoiceTransfers.transferDate} <= ${q.to}::date` : undefined))
      .orderBy(desc(invoiceTransfers.transferDate)).limit(500);
    for (const r of out) rows.push({ kind: "INVOICE", id: r.id, date: String(r.date), amount: money(r.amount), reference: r.reference, projectId: r.projectId, projectName: r.projectName, subject: `INV-${r.number}`, by: r.by, link: `/finance/invoices/${r.invoiceId}`, proof: null });
  }
  if (q.kind !== "INVOICE") {
    const inn = await db
      .select({ id: accidentFinanceReviews.id, accidentId: accidents.id, number: accidents.number, date: accidentFinanceReviews.referenceDate, amount: accidentFinanceReviews.amount, projectId: accidents.projectId, projectName: projects.name, by: users.name, at: accidentFinanceReviews.createdAt })
      .from(accidentFinanceReviews).innerJoin(accidents, eq(accidents.id, accidentFinanceReviews.accidentId)).leftJoin(projects, eq(projects.id, accidents.projectId)).leftJoin(users, eq(users.id, accidentFinanceReviews.reviewedBy))
      .where(and(eq(accidentFinanceReviews.kind, "INSURANCE_TRANSFER"), eq(accidentFinanceReviews.status, "CONFIRMED"), financeAccidents(a), q.projectId ? eq(accidents.projectId, q.projectId) : undefined, q.from ? sql`${accidentFinanceReviews.referenceDate}::date >= ${q.from}::date` : undefined, q.to ? sql`${accidentFinanceReviews.referenceDate}::date <= ${q.to}::date` : undefined))
      .orderBy(desc(accidentFinanceReviews.createdAt)).limit(500);
    for (const r of inn) rows.push({ kind: "INSURANCE", id: r.id, date: r.date ? new Date(r.date).toISOString().slice(0, 10) : r.at.toISOString().slice(0, 10), amount: money(r.amount), reference: null, projectId: r.projectId, projectName: r.projectName, subject: `ACC-${r.number}`, by: r.by, link: `/accidents/${r.accidentId}`, proof: "COMPENSATION_PROOF" });
  }
  rows.sort((x, y) => y.date.localeCompare(x.date));
  const start = (q.page - 1) * q.pageSize;
  res.json({ ...paged(rows.slice(start, start + q.pageSize), rows.length, q.page, q.pageSize), totals: { out: money(rows.filter((r) => r.kind === "INVOICE").reduce((s, r) => s + Number(r.amount), 0)), in: money(rows.filter((r) => r.kind === "INSURANCE").reduce((s, r) => s + Number(r.amount), 0)) } });
});
