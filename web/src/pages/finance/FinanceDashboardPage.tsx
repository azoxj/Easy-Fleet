import { Link } from "react-router";
import { HBars, StackedBars } from "../../components/charts";
import { Money } from "../../components/shared";
import { Alert, Card, CardHeader, Loading, PageHeader, StatCard } from "../../components/ui";
import { useApi } from "../../hooks/useApi";
import { formatMoney } from "../../lib/format";
import { COST_CATEGORY } from "../../lib/labels";

type FinanceDash = {
  invoices: { pending: number; pendingAmount: string; approved: number; rejected: number; transferPending: number; transferPendingAmount: string; transferred: number; transferredAmount: string; overdue: number } | null;
  month: { start: string; total: string; byCategory: Record<string, string> };
  series: { month: string; category: string; total: string }[];
  byProject: { projectId: string; name: string; total: string }[];
};

export function FinanceDashboardPage() {
  const { data, loading, error } = useApi<{ data: FinanceDash }>("/finance/dashboard");
  if (loading) return <Loading />;
  if (error || !data) return <Alert>{error?.message ?? "تعذر التحميل"}</Alert>;
  const d = data.data;
  const months = [...new Set(d.series.map((s) => s.month))].sort();
  const rows = months.map((m) => ({ month: m, ...Object.fromEntries(d.series.filter((s) => s.month === m).map((s) => [s.category, Number(s.total)])) }));
  const cats = Object.keys(COST_CATEGORY).filter((c) => d.series.some((s) => s.category === c));
  return (
    <>
      <PageHeader title="لوحة المالية" subtitle="جميع الأرقام محسوبة من قاعدة البيانات ضمن نطاق صلاحياتك" />
      {d.invoices && (
        <div className="mb-6 grid grid-cols-2 gap-4 lg:grid-cols-4">
          <Link to="/finance/invoices?status=SUBMITTED"><StatCard label="فواتير بانتظار المراجعة" value={d.invoices.pending} hint={formatMoney(d.invoices.pendingAmount)} icon="receipt" tone="violet" /></Link>
          <Link to="/finance/invoices?status=TRANSFER_PENDING"><StatCard label="بانتظار التحويل" value={d.invoices.transferPending} hint={formatMoney(d.invoices.transferPendingAmount)} icon="clock" tone="amber" /></Link>
          <Link to="/finance/invoices?status=TRANSFERRED"><StatCard label="تم تحويلها" value={d.invoices.transferred} hint={formatMoney(d.invoices.transferredAmount)} icon="check" tone="green" /></Link>
          <Link to="/finance/invoices?overdue=true"><StatCard label="متأخرة" value={d.invoices.overdue} hint={`مرفوضة: ${d.invoices.rejected}`} icon="alert" tone="red" /></Link>
        </div>
      )}
      <div className="grid grid-cols-1 gap-6 lg:grid-cols-3">
        <Card className="lg:col-span-2">
          <CardHeader title="التكاليف الشهرية حسب الفئة" subtitle="آخر 6 أشهر" />
          <div className="p-5"><StackedBars rows={rows} series={cats.map((c) => ({ key: c, label: COST_CATEGORY[c]! }))} money /></div>
        </Card>
        <Card>
          <CardHeader title="تكاليف هذا الشهر" subtitle={<Money value={d.month.total} />} />
          <div className="p-5"><HBars money items={Object.entries(d.month.byCategory).map(([k, v]) => ({ label: COST_CATEGORY[k] ?? k, value: Number(v) }))} /></div>
        </Card>
        <Card className="lg:col-span-3">
          <CardHeader title="تكاليف المشاريع هذا الشهر" />
          <div className="p-5">
            <HBars money items={d.byProject.map((p) => ({ label: p.name, value: Number(p.total) }))} />
            <ul className="mt-4 flex flex-wrap gap-3 text-sm">
              {d.byProject.map((p) => <li key={p.projectId}><Link className="text-brand-700 hover:underline" to={`/projects/${p.projectId}?tab=financials`}>التفاصيل المالية: {p.name}</Link></li>)}
            </ul>
          </div>
        </Card>
      </div>
    </>
  );
}
