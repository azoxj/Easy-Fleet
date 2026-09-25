import { Link } from "react-router";
import { StackedBars } from "../../components/charts";
import { Money } from "../../components/shared";
import { Card, CardHeader, DescList, Loading } from "../../components/ui";
import { useApi } from "../../hooks/useApi";
import { useAuth } from "../../lib/auth";
import { formatNumber, timeAgo } from "../../lib/format";
import { AUDIT_ACTION, COST_CATEGORY } from "../../lib/labels";

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
    ["employees", "الموظفون", "/employees"], ["drivers", "السائقون", "/drivers"], ["openMaintenance", "صيانة مفتوحة", "/maintenance"], ["openAccidents", "حوادث مفتوحة", "/accidents"],
    ["openViolations", "مخالفات غير مسددة", "/violations"], ["activeHandovers", "تسليمات نشطة", "/handovers"], ["expiringDocuments", "مستندات تنتهي", "/documents"], ["expiringInsurance", "تأمين ينتهي", "/documents"],
  ] as const;
  return (
    <div className="mt-6 space-y-6">
      <Card>
        <CardHeader title="لوحة المشروع" />
        <div className="grid grid-cols-2 gap-px bg-slate-100 sm:grid-cols-4">
          {counters.map(([k, label, to]) => (
            <Link key={k} to={`${to}`} className="bg-white p-4 hover:bg-slate-50"><p className="text-xs text-slate-500">{label}</p><p className="mt-1 text-xl font-bold">{formatNumber(d.counts[k] ?? 0)}</p></Link>
          ))}
        </div>
      </Card>
      {f && (
        <div className="grid grid-cols-1 gap-6 xl:grid-cols-3">
          <Card>
            <CardHeader title="الملخص المالي" />
            <div className="p-5"><DescList items={[
              { label: "الميزانية", value: <Money value={f.project.budget} /> },
              { label: "قيمة العقد (الإيراد)", value: <Money value={f.revenue} /> },
              { label: "إجمالي التكاليف", value: <b><Money value={f.totalCosts} /></b> },
              { label: "المتبقي من الميزانية", value: f.remainingBudget !== null ? <span className={Number(f.remainingBudget) < 0 ? "text-red-700" : "text-emerald-700"}><Money value={f.remainingBudget} /></span> : "—" },
              { label: "فواتير مفتوحة", value: <Money value={f.invoices.open} /> },
              { label: "فواتير مدفوعة", value: <Money value={f.invoices.paid} /> },
            ]} /></div>
          </Card>
          <Card className="xl:col-span-2">
            <CardHeader title="التكاليف الشهرية" subtitle="آخر 6 أشهر حسب الفئة" />
            <div className="p-5"><StackedBars money rows={f.months.map((m) => ({ month: m.month, ...Object.fromEntries(Object.entries(m.byCategory).map(([k, v]) => [k, Number(v)])) }))} series={Object.keys(COST_CATEGORY).filter((c) => f.months.some((m) => m.byCategory[c])).map((c) => ({ key: c, label: COST_CATEGORY[c]! }))} /></div>
          </Card>
        </div>
      )}
      <Card>
        <CardHeader title="آخر النشاطات في المشروع" />
        {d.recent.length === 0 ? <p className="p-5 text-sm text-slate-400">لا توجد نشاطات</p> : (
          <ul className="divide-y divide-slate-100">{d.recent.map((r, i) => <li key={i} className="flex justify-between gap-3 px-5 py-2.5 text-sm"><span><b>{r.userName ?? "النظام"}</b> — {AUDIT_ACTION[r.action] ?? r.action}</span><span className="text-xs text-slate-400">{timeAgo(r.createdAt)}</span></li>)}</ul>
        )}
      </Card>
    </div>
  );
}
