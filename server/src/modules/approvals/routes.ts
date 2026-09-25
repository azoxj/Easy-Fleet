import { and, eq, inArray, ne, type AnyColumn, type SQL } from "drizzle-orm";
import { Router } from "express";
import type { Access } from "../../auth/access.js";
import type { PermissionKey } from "../../auth/permissions.js";
import { db } from "../../db/client.js";
import { expenses, handoverSessions, invoices, maintenanceQuotes, maintenanceRequests, projects, users, vehicles } from "../../db/schema/index.js";
import { ctx } from "../../http/context.js";

/**
 * Approval center: everything currently waiting for the caller's decision.
 * Each queue uses the "act" rule — ALL scope, or PROJECT scope on a project the
 * caller is a member of. Separation of duties: nobody approves their own record.
 */
export const approvalsRouter = Router();

export type ApprovalItem = {
  kind: "MAINTENANCE_APPROVAL" | "QUOTE_APPROVAL" | "MAINTENANCE_HANDOVER" | "INVOICE_REVIEW" | "INVOICE_TRANSFER" | "EXPENSE_APPROVAL" | "HANDOVER_REVIEW";
  id: string;
  label: string;
  title: string;
  projectId: string | null;
  projectName: string | null;
  amount: string | null;
  requestedBy: string | null;
  since: Date;
  link: string;
};

function actScope(a: Access, perm: PermissionKey, orgCol: AnyColumn, projectCol: AnyColumn): SQL | null {
  const s = a.scopeOf(perm);
  if (s === "ALL") return eq(orgCol, a.orgId);
  if (s === "PROJECT" && a.memberProjectIds.length) return and(eq(orgCol, a.orgId), inArray(projectCol, a.memberProjectIds))!;
  return null;
}

const LIMIT = 100;

export async function pendingApprovals(a: Access): Promise<ApprovalItem[]> {
  const jobs: Promise<ApprovalItem[]>[] = [];

  const mrApprove = actScope(a, "maintenance.approve", maintenanceRequests.organizationId, maintenanceRequests.projectId);
  if (mrApprove) {
    jobs.push(
      db
        .select({ id: maintenanceRequests.id, number: maintenanceRequests.number, issue: maintenanceRequests.issue, projectId: maintenanceRequests.projectId, projectName: projects.name, plate: vehicles.plateNumber, since: maintenanceRequests.updatedAt, by: users.name })
        .from(maintenanceRequests)
        .innerJoin(vehicles, eq(vehicles.id, maintenanceRequests.vehicleId))
        .leftJoin(projects, eq(projects.id, maintenanceRequests.projectId))
        .leftJoin(users, eq(users.id, maintenanceRequests.requestedBy))
        .where(and(mrApprove, eq(maintenanceRequests.status, "PENDING_APPROVAL")))
        .orderBy(maintenanceRequests.updatedAt)
        .limit(LIMIT)
        .then((rows) => rows.map((r) => ({ kind: "MAINTENANCE_APPROVAL" as const, id: r.id, label: `MR-${r.number}`, title: `${r.plate} — ${r.issue}`, projectId: r.projectId, projectName: r.projectName, amount: null, requestedBy: r.by, since: r.since, link: `/maintenance/${r.id}` }))),
    );
  }

  const mrHandover = actScope(a, "maintenance.handover", maintenanceRequests.organizationId, maintenanceRequests.projectId);
  if (mrHandover) {
    jobs.push(
      db
        .select({ id: maintenanceRequests.id, number: maintenanceRequests.number, projectId: maintenanceRequests.projectId, projectName: projects.name, plate: vehicles.plateNumber, since: maintenanceRequests.updatedAt })
        .from(maintenanceRequests)
        .innerJoin(vehicles, eq(vehicles.id, maintenanceRequests.vehicleId))
        .leftJoin(projects, eq(projects.id, maintenanceRequests.projectId))
        .where(and(mrHandover, eq(maintenanceRequests.status, "READY_FOR_HANDOVER")))
        .orderBy(maintenanceRequests.updatedAt)
        .limit(LIMIT)
        .then((rows) => rows.map((r) => ({ kind: "MAINTENANCE_HANDOVER" as const, id: r.id, label: `MR-${r.number}`, title: `استلام ${r.plate} بعد الصيانة`, projectId: r.projectId, projectName: r.projectName, amount: null, requestedBy: null, since: r.since, link: `/maintenance/${r.id}` }))),
    );
  }

  const quote = actScope(a, "maintenance.quote.approve", maintenanceRequests.organizationId, maintenanceRequests.projectId);
  if (quote) {
    jobs.push(
      db
        .select({ id: maintenanceQuotes.id, mrId: maintenanceRequests.id, number: maintenanceRequests.number, amount: maintenanceQuotes.amount, projectId: maintenanceRequests.projectId, projectName: projects.name, since: maintenanceQuotes.submittedAt, created: maintenanceQuotes.createdAt, by: users.name })
        .from(maintenanceQuotes)
        .innerJoin(maintenanceRequests, eq(maintenanceRequests.id, maintenanceQuotes.maintenanceRequestId))
        .leftJoin(projects, eq(projects.id, maintenanceRequests.projectId))
        .leftJoin(users, eq(users.id, maintenanceQuotes.createdBy))
        .where(and(quote, inArray(maintenanceQuotes.status, ["SUBMITTED", "UNDER_REVIEW"]), ne(maintenanceQuotes.createdBy, a.userId)))
        .orderBy(maintenanceQuotes.submittedAt)
        .limit(LIMIT)
        .then((rows) => rows.map((r) => ({ kind: "QUOTE_APPROVAL" as const, id: r.id, label: `MR-${r.number}`, title: `عرض سعر لطلب الصيانة MR-${r.number}`, projectId: r.projectId, projectName: r.projectName, amount: r.amount, requestedBy: r.by, since: r.since ?? r.created, link: `/maintenance/${r.mrId}` }))),
    );
  }

  const invReview = actScope(a, "invoices.approve", invoices.organizationId, invoices.projectId);
  if (invReview) {
    jobs.push(
      db
        .select({ id: invoices.id, number: invoices.number, total: invoices.total, description: invoices.description, projectId: invoices.projectId, projectName: projects.name, since: invoices.submittedAt, created: invoices.createdAt, by: users.name })
        .from(invoices)
        .innerJoin(projects, eq(projects.id, invoices.projectId))
        .innerJoin(users, eq(users.id, invoices.createdBy))
        .where(and(invReview, inArray(invoices.status, ["SUBMITTED", "UNDER_REVIEW"]), ne(invoices.createdBy, a.userId)))
        .orderBy(invoices.submittedAt)
        .limit(LIMIT)
        .then((rows) => rows.map((r) => ({ kind: "INVOICE_REVIEW" as const, id: r.id, label: `INV-${r.number}`, title: r.description ?? `فاتورة INV-${r.number}`, projectId: r.projectId, projectName: r.projectName, amount: r.total, requestedBy: r.by, since: r.since ?? r.created, link: `/finance/invoices/${r.id}` }))),
    );
  }

  const invTransfer = actScope(a, "finance.transfer", invoices.organizationId, invoices.projectId);
  if (invTransfer) {
    jobs.push(
      db
        .select({ id: invoices.id, number: invoices.number, total: invoices.total, projectId: invoices.projectId, projectName: projects.name, since: invoices.approvedAt, created: invoices.createdAt })
        .from(invoices)
        .innerJoin(projects, eq(projects.id, invoices.projectId))
        .where(and(invTransfer, eq(invoices.status, "TRANSFER_PENDING")))
        .orderBy(invoices.approvedAt)
        .limit(LIMIT)
        .then((rows) => rows.map((r) => ({ kind: "INVOICE_TRANSFER" as const, id: r.id, label: `INV-${r.number}`, title: `تحويل مبلغ الفاتورة INV-${r.number}`, projectId: r.projectId, projectName: r.projectName, amount: r.total, requestedBy: null, since: r.since ?? r.created, link: `/finance/invoices/${r.id}` }))),
    );
  }

  const exp = actScope(a, "finance.approve", expenses.organizationId, expenses.projectId);
  if (exp) {
    jobs.push(
      db
        .select({ id: expenses.id, amount: expenses.amount, category: expenses.category, description: expenses.description, projectId: expenses.projectId, projectName: projects.name, since: expenses.createdAt, by: users.name })
        .from(expenses)
        .innerJoin(projects, eq(projects.id, expenses.projectId))
        .innerJoin(users, eq(users.id, expenses.createdBy))
        .where(and(exp, eq(expenses.status, "SUBMITTED"), ne(expenses.createdBy, a.userId)))
        .orderBy(expenses.createdAt)
        .limit(LIMIT)
        .then((rows) => rows.map((r) => ({ kind: "EXPENSE_APPROVAL" as const, id: r.id, label: "مصروف", title: r.description ?? r.category, projectId: r.projectId, projectName: r.projectName, amount: r.amount, requestedBy: r.by, since: r.since, link: `/finance/expenses?focus=${r.id}` }))),
    );
  }

  const ho = actScope(a, "handover.manage", handoverSessions.organizationId, handoverSessions.projectId);
  if (ho) {
    jobs.push(
      db
        .select({ id: handoverSessions.id, plate: vehicles.plateNumber, projectId: handoverSessions.projectId, projectName: projects.name, since: handoverSessions.returnAt, created: handoverSessions.createdAt })
        .from(handoverSessions)
        .innerJoin(vehicles, eq(vehicles.id, handoverSessions.vehicleId))
        .leftJoin(projects, eq(projects.id, handoverSessions.projectId))
        .where(and(ho, eq(handoverSessions.status, "RETURN_COMPLETED")))
        .orderBy(handoverSessions.returnAt)
        .limit(LIMIT)
        .then((rows) => rows.map((r) => ({ kind: "HANDOVER_REVIEW" as const, id: r.id, label: r.plate, title: `مراجعة إرجاع المركبة ${r.plate}`, projectId: r.projectId, projectName: r.projectName, amount: null, requestedBy: null, since: r.since ?? r.created, link: `/handovers/${r.id}` }))),
    );
  }

  const all = (await Promise.all(jobs)).flat();
  return all.sort((x, y) => x.since.getTime() - y.since.getTime());
}

approvalsRouter.get("/approvals", async (req, res) => {
  const { access } = ctx(req);
  const items = await pendingApprovals(access);
  const counts: Record<string, number> = {};
  for (const i of items) counts[i.kind] = (counts[i.kind] ?? 0) + 1;
  res.json({ data: items, meta: { total: items.length, counts } });
});

