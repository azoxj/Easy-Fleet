import { Link } from "react-router";
import { StackedBars } from "../../components/charts";
import { Money } from "../../components/shared";
import { Card, CardHeader, DescList, Loading } from "../../components/ui";
import { useApi } from "../../hooks/useApi";
import { useAuth } from "../../lib/auth";
import { formatNumber, timeAgo } from "../../lib/format";
import { AUDIT_ACTION, COST_CATEGORY } from "../../lib/labels";
import { t } from "../../i18n";

type Dash = { counts: Record<string, number>; costs: { series: { month: string; total: string }[]; month: Record<string, string> } | null; recent: { action: string; entity: string; createdAt: string; userName: string | null }[] };
type Fin = { totalCosts: string; remainingBudget: string | null; revenue: string | null; invoices: { open: string; paid: string }; months: { month: string; byCategory: Record<string, string>; total: string }[]; project: { budget: string | null } };

export function ProjectInsights({ id }: { id: string }) {
  const { can } = useAuth();
  const dash = useApi<{ data: Dash }>(`/projects/${id}/dashboard`);
  const fin = useApi<{ data: Fin }>(can("finance.read") ? `/projects/${id}/financials` : null, { months: 6 });
  if (dash.loading) return <Loading />;
  const d = dash.data?.data;
  if (!d) return null;
  const f = fin.data?.data;
  const counters = [
    ["employees", t("common.employees"), "/employees"], ["drivers", t("common.drivers"), "/drivers"], ["openMaintenance", t("projectInsights.openMaintenance"), "/maintenance"], ["openAccidents", t("common.openAccidents"), "/accidents"],
    ["openViolations", t("common.unpaidViolations"), "/violations"], ["activeHandovers", t("projectInsights.activeHandovers"), "/handovers"], ["expiringDocuments", t("projectInsights.expiringDocuments"), "/documents"], ["expiringInsurance", t("projectInsights.expiringInsurance"), "/documents"],
  ] as const;
  return (
    <div className="mt-6 space-y-6">
      <Card>
        <CardHeader title={t("projectInsights.projectDashboard")} />
        <div className="grid grid-cols-2 gap-px bg-slate-100 sm:grid-cols-4">
          {counters.map(([k, label, to]) => (
            <Link key={k} to={`${to}`} className="bg-white p-4 hover:bg-slate-50"><p className="text-xs text-slate-500">{label}</p><p className="mt-1 text-xl font-bold">{formatNumber(d.counts[k] ?? 0)}</p></Link>
          ))}
        </div>
      </Card>
      {f && (
        <div className="grid grid-cols-1 gap-6 xl:grid-cols-3">
          <Card>
            <CardHeader title={t("projectInsights.financialSummary")} />
            <div className="p-5"><DescList items={[
              { label: t("common.budget"), value: <Money value={f.project.budget} /> },
              { label: t("projectInsights.contractValueRevenue"), value: <Money value={f.revenue} /> },
              { label: t("projectInsights.totalCosts"), value: <b><Money value={f.totalCosts} /></b> },
              { label: t("projectInsights.remainingBudget"), value: f.remainingBudget !== null ? <span className={Number(f.remainingBudget) < 0 ? "text-red-700" : "text-emerald-700"}><Money value={f.remainingBudget} /></span> : "—" },
              { label: t("projectInsights.openInvoices"), value: <Money value={f.invoices.open} /> },
              { label: t("projectInsights.paidInvoices"), value: <Money value={f.invoices.paid} /> },
            ]} /></div>
          </Card>
          <Card className="xl:col-span-2">
            <CardHeader title={t("projectInsights.monthlyCosts")} subtitle={t("projectInsights.last6MonthsByCategory")} />
            <div className="p-5"><StackedBars money rows={f.months.map((m) => ({ month: m.month, ...Object.fromEntries(Object.entries(m.byCategory).map(([k, v]) => [k, Number(v)])) }))} series={Object.keys(COST_CATEGORY).filter((c) => f.months.some((m) => m.byCategory[c])).map((c) => ({ key: c, label: COST_CATEGORY[c]! }))} /></div>
          </Card>
        </div>
      )}
      <Card>
        <CardHeader title={t("projectInsights.recentProjectActivity")} />
        {d.recent.length === 0 ? <p className="p-5 text-sm text-slate-400">{t("projectInsights.noActivity")}</p> : (
          <ul className="divide-y divide-slate-100">{d.recent.map((r, i) => <li key={i} className="flex justify-between gap-3 px-5 py-2.5 text-sm"><span><b>{r.userName ?? t("common.system")}</b> — {AUDIT_ACTION[r.action] ?? r.action}</span><span className="text-xs text-slate-400">{timeAgo(r.createdAt)}</span></li>)}</ul>
        )}
      </Card>
    </div>
  );
}
