import { and, eq, sql } from "drizzle-orm";
import { Router } from "express";
import { z } from "zod";
import { getProjectInScope } from "../../auth/access.js";
import { config } from "../../config.js";
import { db } from "../../db/client.js";
import { invoices } from "../../db/schema/index.js";
import { ctx } from "../../http/context.js";
import { requirePermission } from "../../http/middleware.js";
import { idParam } from "../../http/validate.js";
import { today } from "../../lib/clock.js";
import { costsCte, costsScope } from "./costs.js";
import { invoiceScope } from "./invoices.js";

export const financeRouter = Router();

/** First day of the month `offset` months from the month of `iso` (YYYY-MM-01). */
export function monthStart(iso: string, offset = 0): string {
  const d = new Date(Date.UTC(Number(iso.slice(0, 4)), Number(iso.slice(5, 7)) - 1 + offset, 1));
  return d.toISOString().slice(0, 10);
}

/** Finance dashboard: invoice KPIs (invoices.read scope) + cost ledger (finance.read scope). */
financeRouter.get("/finance/dashboard", requirePermission("finance.read"), async (req, res) => {
  const { access } = ctx(req);
  const t = today();
  const tz = config.APP_TIMEZONE;
  const m0 = monthStart(t);
  const m1 = monthStart(t, 1);
  const from6 = monthStart(t, -5);

  let invoiceKpis = null;
  if (access.has("invoices.read")) {
    const rows = await db
      .select({ status: invoices.status, n: sql<number>`count(*)::int`, total: sql<string>`coalesce(sum(${invoices.total}), 0)::text` })
      .from(invoices)
      .where(invoiceScope(access))
      .groupBy(invoices.status);
    const by = Object.fromEntries(rows.map((r) => [r.status, r]));
    const n = (...s: string[]) => s.reduce((a, k) => a + (by[k]?.n ?? 0), 0);
    const amt = (...s: string[]) => s.reduce((a, k) => a + Number(by[k]?.total ?? 0), 0).toFixed(2);
    const [overdue] = await db
      .select({ n: sql<number>`count(*)::int` })
      .from(invoices)
      .where(and(invoiceScope(access), sql`${invoices.dueDate} < ${t}::date and ${invoices.status} not in ('TRANSFERRED','PAID','CANCELLED','REJECTED')`));
    invoiceKpis = {
      pending: n("SUBMITTED", "UNDER_REVIEW"),
      pendingAmount: amt("SUBMITTED", "UNDER_REVIEW"),
      approved: n("APPROVED"),
      rejected: n("REJECTED"),
      transferPending: n("TRANSFER_PENDING"),
      transferPendingAmount: amt("TRANSFER_PENDING"),
      transferred: n("TRANSFERRED", "PAID"),
      transferredAmount: amt("TRANSFERRED", "PAID"),
      overdue: overdue?.n ?? 0,
    };
  }

  const scope = costsScope(access);
  const cte = costsCte(access.orgId, tz);
  const monthRows = await db.execute<{ category: string; total: string }>(sql`with ${cte}
    select category, coalesce(sum(amount), 0)::numeric(16,2)::text as total from costs
     where ${scope} and day >= ${m0}::date and day < ${m1}::date group by category`);
  const byCategory = Object.fromEntries(monthRows.rows.map((r) => [r.category, r.total]));
  const monthTotal = monthRows.rows.reduce((a, r) => a + Number(r.total), 0).toFixed(2);
  const series = await db.execute<{ month: string; category: string; total: string }>(sql`with ${cte}
    select to_char(date_trunc('month', day), 'YYYY-MM') as month, category, sum(amount)::numeric(16,2)::text as total
      from costs where ${scope} and day >= ${from6}::date and day < ${m1}::date group by 1, 2 order by 1`);
  const byProject = await db.execute<{ project_id: string; name: string; total: string }>(sql`with ${cte}
    select c.project_id, p.name, sum(c.amount)::numeric(16,2)::text as total
      from costs c join projects p on p.id = c.project_id
     where ${scope} and c.day >= ${m0}::date and c.day < ${m1}::date
     group by 1, 2 order by sum(c.amount) desc limit 20`);
  res.json({
    data: {
      invoices: invoiceKpis,
      month: { start: m0, total: monthTotal, byCategory, maintenance: byCategory.MAINTENANCE ?? "0.00" },
      series: series.rows,
      byProject: byProject.rows.map((r) => ({ projectId: r.project_id, name: r.name, total: r.total })),
    },
  });
});

/** Project financials: monthly breakdown by category, budget, revenue (contract value) and remaining. */
financeRouter.get("/projects/:id/financials", requirePermission("finance.read"), async (req, res) => {
  const { access } = ctx(req);
  const { id } = idParam.parse(req.params);
  const { months } = z.object({ months: z.coerce.number().int().min(1).max(24).default(12) }).parse(req.query);
  const project = await getProjectInScope(db, access, id, "projects.read");
  const t = today();
  const from = monthStart(t, -(months - 1));
  const to = monthStart(t, 1);
  const scope = costsScope(access);
  const cte = costsCte(access.orgId, config.APP_TIMEZONE);
  const rows = await db.execute<{ month: string; category: string; total: string }>(sql`with ${cte}
    select to_char(date_trunc('month', day), 'YYYY-MM') as month, category, sum(amount)::numeric(16,2)::text as total
      from costs where project_id = ${id} and ${scope} and day >= ${from}::date and day < ${to}::date group by 1, 2 order by 1`);
  const all = await db.execute<{ total: string }>(sql`with ${cte} select coalesce(sum(amount), 0)::numeric(16,2)::text as total from costs where project_id = ${id} and ${scope}`);
  const [inv] = await db
    .select({ open: sql<string>`coalesce(sum(case when ${invoices.status} in ('SUBMITTED','UNDER_REVIEW','TRANSFER_PENDING') then ${invoices.total} end), 0)::text`, paid: sql<string>`coalesce(sum(case when ${invoices.status} in ('TRANSFERRED','PAID') then ${invoices.total} end), 0)::text` })
    .from(invoices)
    .where(and(eq(invoices.projectId, id), access.has("invoices.read") ? invoiceScope(access) : sql`false`));
  const totalCosts = all.rows[0]?.total ?? "0.00";
  const monthsList = Array.from({ length: months }, (_, i) => monthStart(t, -(months - 1) + i).slice(0, 7));
  res.json({
    data: {
      project: { id: project.id, name: project.name, budget: project.budget, contractValue: project.contractValue },
      totalCosts,
      remainingBudget: project.budget !== null ? (Number(project.budget) - Number(totalCosts)).toFixed(2) : null,
      revenue: project.contractValue,
      invoices: inv ?? { open: "0.00", paid: "0.00" },
      months: monthsList.map((m) => ({
        month: m,
        byCategory: Object.fromEntries(rows.rows.filter((r) => r.month === m).map((r) => [r.category, r.total])),
        total: rows.rows.filter((r) => r.month === m).reduce((a, r) => a + Number(r.total), 0).toFixed(2),
      })),
    },
  });
});

