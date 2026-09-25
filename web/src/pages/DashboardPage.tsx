import { Link } from "react-router";
import { LineChart, StackedBars } from "../components/charts";
import { Icon } from "../components/icons";
import { Alert, Card, CardHeader, EmptyState, Loading, PageHeader, StatCard, StatusBadge } from "../components/ui";
import { useApi } from "../hooks/useApi";
import { useAuth } from "../lib/auth";
import { formatMoney, formatNumber, timeAgo } from "../lib/format";
import { AUDIT_ACTION, COST_CATEGORY, VEHICLE_STATUS } from "../lib/labels";

type Dashboard = {
  view: "admin" | "project_manager" | "finance" | "driver" | "general";
  vehicles: { total: number; active: number; inMaintenance: number; byStatus: Record<string, number> } | null;
  projects: { total: number; active: number } | null;
  myAssignments: Record<string, number> | null;
  unreadNotifications: number;
  assignedVehicles: { id: string; plateNumber: string; make: string; model: string; status: string }[] | null;
  recentActivity: { id: number; action: string; entity: string; createdAt: string; userName: string | null }[] | null;
  expiring: { registrations: number | null; insurance: number | null; documents: number | null; licenses: number | null; total: number | null };
  maintenance: { open: number; awaitingInspection: number; inInspection: number; awaitingApproval: number; inRepair: number; awaitingHandover: number; costThisMonth: string | null } | null;
  accidents: { open: number; thisMonth: number } | null;
  violations: { open: number; openAmount: string } | null;
  fuel: { liters: string; cost: string; fills: number } | null;
  invoices: { pending: number; approved: number; transferPending: number; paid: number; rejected: number; overdue: number; totalValue: string; pendingPaymentAmount: string } | null;
  monthlyCost: string | null;
  currentHandover: { id: string; status: string; plateNumber: string; expiresAt: string } | null;
  activeTrip: { id: string; vehicleId: string; startedAt: string } | null;
  pendingApprovals: number;
  charts: {
    months: string[];
    costs: Record<string, number | string>[] | null;
    fuel: { month: string; liters: number; cost: number }[] | null;
    accidents: { month: string; count: number }[] | null;
    maintenance: { month: string; count: number }[] | null;
  };
  alerts: { level: "danger" | "warning" | "info"; key: string; title: string; count: number; link: string }[];
};

const VIEW_TITLE: Record<Dashboard["view"], string> = {
  admin: "نظرة عامة على الأسطول",
  project_manager: "مشاريعي",
  finance: "لوحة المالية",
  driver: "لوحتي",
  general: "لوحة التحكم",
};

export function DashboardPage() {
  const { me } = useAuth();
  const { data, loading, error } = useApi<{ data: Dashboard }>("/dashboard");
  if (loading) return <Loading />;
  if (error || !data) return <Alert>{error?.message ?? "تعذر تحميل لوحة التحكم"}</Alert>;
  const d = data.data;
  const pendingMine = (d.myAssignments?.PENDING ?? 0) + (d.myAssignments?.IN_PROGRESS ?? 0);

  return (
    <>
      <PageHeader title={VIEW_TITLE[d.view]} subtitle={`مرحبًا ${me?.name ?? ""}`} />
      {d.alerts.length > 0 && (
        <ul className="mb-6 grid grid-cols-1 gap-2 md:grid-cols-2" aria-label="التنبيهات">
          {d.alerts.map((a) => (
            <li key={a.key}>
              <Link to={a.link} className={`flex items-center gap-3 rounded-lg px-4 py-3 text-sm ring-1 ${a.level === "danger" ? "bg-red-50 text-red-800 ring-red-200" : a.level === "warning" ? "bg-amber-50 text-amber-900 ring-amber-200" : "bg-blue-50 text-blue-800 ring-blue-200"}`}>
                <Icon name={a.level === "info" ? "bell" : "alert"} className="size-4 shrink-0" />
                <span className="flex-1">{a.title}</span>
                <b>{formatNumber(a.count)}</b>
              </Link>
            </li>
          ))}
        </ul>
      )}

      <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 xl:grid-cols-4">
        {d.vehicles && <StatCard label={d.view === "driver" ? "مركباتي" : "إجمالي المركبات"} value={formatNumber(d.vehicles.total)} icon="truck" />}
        {d.vehicles && d.view !== "driver" && <StatCard label="مركبات نشطة" value={formatNumber(d.vehicles.active)} icon="check" tone="green" />}
        {d.vehicles && d.view !== "driver" && <StatCard label="في الصيانة" value={formatNumber(d.vehicles.inMaintenance)} icon="wrench" tone="amber" />}
        {d.projects && <StatCard label="المشاريع" value={formatNumber(d.projects.total)} icon="folder" tone="violet" hint={`${formatNumber(d.projects.active)} نشط`} />}
        <StatCard label="إسناداتي المفتوحة" value={formatNumber(pendingMine)} icon="inbox" tone="blue" />
        <StatCard label="إشعارات غير مقروءة" value={formatNumber(d.unreadNotifications)} icon="bell" tone="red" />
        {d.expiring.total !== null && (
          <StatCard
            label="منتهية أو تنتهي خلال 30 يومًا"
            value={formatNumber(d.expiring.total)}
            icon="calendar"
            tone={d.expiring.total > 0 ? "amber" : "green"}
            hint={[
              d.expiring.registrations !== null && `استمارات ${d.expiring.registrations}`,
              d.expiring.insurance !== null && `تأمين ${d.expiring.insurance}`,
              d.expiring.licenses !== null && `رخص ${d.expiring.licenses}`,
              d.expiring.documents !== null && `مستندات ${d.expiring.documents}`,
            ].filter(Boolean).join(" · ")}
          />
        )}
        {d.pendingApprovals > 0 && <Link to="/approvals"><StatCard label="بانتظار اعتمادي" value={formatNumber(d.pendingApprovals)} icon="stamp" tone="violet" /></Link>}
        {d.accidents && <Link to="/accidents?open=true"><StatCard label="حوادث مفتوحة" value={formatNumber(d.accidents.open)} icon="alert" tone={d.accidents.open ? "red" : "green"} hint={`هذا الشهر: ${d.accidents.thisMonth}`} /></Link>}
        {d.violations && <Link to="/violations?status=OPEN"><StatCard label="مخالفات غير مسددة" value={formatNumber(d.violations.open)} icon="ticket" tone="amber" hint={formatMoney(d.violations.openAmount)} /></Link>}
        {d.fuel && <Link to="/fuel"><StatCard label="وقود هذا الشهر" value={formatMoney(d.fuel.cost)} icon="fuel" tone="blue" hint={`${formatNumber(d.fuel.liters)} لتر · ${d.fuel.fills} تعبئة`} /></Link>}
        {d.monthlyCost !== null && <Link to="/finance"><StatCard label="التكلفة الشهرية" value={formatMoney(d.monthlyCost)} icon="receipt" tone="slate" hint="جميع فئات التكاليف" /></Link>}
        {d.invoices && (
          <>
            <Link to="/finance/invoices?status=SUBMITTED"><StatCard label="فواتير بانتظار المراجعة" value={formatNumber(d.invoices.pending)} icon="receipt" tone="violet" /></Link>
            <Link to="/finance/invoices?status=TRANSFER_PENDING"><StatCard label="بانتظار التحويل" value={formatNumber(d.invoices.transferPending)} icon="clock" tone="amber" hint={formatMoney(d.invoices.pendingPaymentAmount)} /></Link>
            <Link to="/finance/invoices?status=TRANSFERRED"><StatCard label="فواتير محولة/مدفوعة" value={formatNumber(d.invoices.paid)} icon="check" tone="green" hint={d.invoices.overdue ? `متأخرة: ${d.invoices.overdue}` : undefined} /></Link>
            {d.view === "finance" && <StatCard label="إجمالي القيمة المالية" value={formatMoney(d.invoices.totalValue)} icon="chart" tone="slate" />}
          </>
        )}
        {d.currentHandover && <Link to={`/handovers/${d.currentHandover.id}`}><StatCard label={d.currentHandover.status === "PENDING_HANDOVER" ? "مطلوب استلام مركبة" : "مركبة مستلمة (للإرجاع)"} value={<span className="ltr">{d.currentHandover.plateNumber}</span>} icon="key" tone="amber" /></Link>}
        {d.view === "driver" && <Link to="/tracking"><StatCard label="تتبع الرحلة" value={d.activeTrip ? "رحلة نشطة" : "لا توجد رحلة"} icon="navigation" tone={d.activeTrip ? "green" : "gray"} /></Link>}
      </div>

      {d.maintenance && (
        <Card className="mt-6">
          <CardHeader title="الصيانة" action={<Link to="/maintenance" className="text-sm font-medium text-brand-700 hover:underline">كل الطلبات</Link>} />
          <div className="grid grid-cols-2 gap-px bg-slate-100 sm:grid-cols-3 xl:grid-cols-6">
            {[
              { label: "طلبات مفتوحة", value: d.maintenance.open, to: "/maintenance" },
              { label: "بانتظار الفحص", value: d.maintenance.awaitingInspection },
              { label: "بانتظار الاعتماد", value: d.maintenance.awaitingApproval },
              { label: "قيد الإصلاح", value: d.maintenance.inRepair },
              { label: "بانتظار الاستلام", value: d.maintenance.awaitingHandover },
              { label: "تكلفة الشهر", value: d.maintenance.costThisMonth !== null ? formatMoney(d.maintenance.costThisMonth) : "—" },
            ].map((k) => (
              <div key={k.label} className="bg-white p-4">
                <p className="text-xs text-slate-500">{k.label}</p>
                <p className="mt-1 text-xl font-bold text-slate-900">{typeof k.value === "number" ? formatNumber(k.value) : k.value}</p>
              </div>
            ))}
          </div>
        </Card>
      )}

      {(d.charts.costs || d.charts.fuel || d.charts.accidents || d.charts.maintenance) && (
        <div className="mt-6 grid grid-cols-1 gap-6 xl:grid-cols-2">
          {d.charts.costs && (
            <Card><CardHeader title="التكاليف الشهرية حسب الفئة" subtitle="آخر 6 أشهر" /><div className="p-5"><StackedBars rows={d.charts.costs} money series={Object.keys(COST_CATEGORY).filter((c) => d.charts.costs!.some((r) => Number(r[c] ?? 0) > 0)).map((c) => ({ key: c, label: COST_CATEGORY[c]! }))} /></div></Card>
          )}
          {d.charts.fuel && <Card><CardHeader title="تكلفة الوقود" subtitle="آخر 6 أشهر" /><div className="p-5"><LineChart points={d.charts.fuel.map((f) => ({ label: f.month, value: f.cost }))} /></div></Card>}
          {d.charts.maintenance && <Card><CardHeader title="طلبات الصيانة الجديدة" /><div className="p-5"><StackedBars rows={d.charts.maintenance} series={[{ key: "count", label: "طلبات", color: "#d97706" }]} height={160} /></div></Card>}
          {d.charts.accidents && <Card><CardHeader title="الحوادث" /><div className="p-5"><StackedBars rows={d.charts.accidents} series={[{ key: "count", label: "حوادث", color: "#dc2626" }]} height={160} /></div></Card>}
        </div>
      )}

      <div className="mt-6 grid grid-cols-1 gap-6 xl:grid-cols-3">
        {d.vehicles && d.view !== "driver" && (
          <Card className="xl:col-span-1">
            <CardHeader title="المركبات حسب الحالة" />
            <ul className="divide-y divide-slate-100 px-5">
              {Object.keys(VEHICLE_STATUS)
                .filter((s) => s !== "ARCHIVED")
                .map((s) => {
                  const n = d.vehicles!.byStatus[s] ?? 0;
                  const pct = d.vehicles!.total ? Math.round((n / d.vehicles!.total) * 100) : 0;
                  return (
                    <li key={s} className="py-3">
                      <div className="flex items-center justify-between text-sm">
                        <StatusBadge map={VEHICLE_STATUS} value={s} />
                        <span className="font-semibold text-slate-800">{formatNumber(n)}</span>
                      </div>
                      <div className="mt-2 h-1.5 overflow-hidden rounded-full bg-slate-100">
                        <div className="h-full rounded-full bg-brand-600" style={{ width: `${pct}%` }} />
                      </div>
                    </li>
                  );
                })}
            </ul>
          </Card>
        )}

        {d.assignedVehicles && (
          <Card className="xl:col-span-2">
            <CardHeader title="المركبات المسندة إليّ" />
            {d.assignedVehicles.length === 0 ? (
              <EmptyState icon="truck" title="لا توجد مركبات مسندة إليك حاليًا" />
            ) : (
              <ul className="divide-y divide-slate-100">
                {d.assignedVehicles.map((v) => (
                  <li key={v.id}>
                    <Link to={`/vehicles/${v.id}`} className="flex items-center justify-between gap-3 px-5 py-3 hover:bg-slate-50">
                      <span className="flex items-center gap-3">
                        <Icon name="truck" className="size-5 text-slate-400" />
                        <span className="font-medium ltr">{v.plateNumber}</span>
                        <span className="text-sm text-slate-500">{v.make} {v.model}</span>
                      </span>
                      <StatusBadge map={VEHICLE_STATUS} value={v.status} />
                    </Link>
                  </li>
                ))}
              </ul>
            )}
          </Card>
        )}

        {d.recentActivity && (
          <Card className="xl:col-span-2">
            <CardHeader title="آخر النشاطات" action={<Link to="/audit" className="text-sm font-medium text-brand-700 hover:underline">سجل التدقيق</Link>} />
            {d.recentActivity.length === 0 ? (
              <EmptyState icon="log" title="لا توجد نشاطات بعد" />
            ) : (
              <ul className="divide-y divide-slate-100">
                {d.recentActivity.map((a) => (
                  <li key={a.id} className="flex items-center justify-between gap-3 px-5 py-3 text-sm">
                    <span>
                      <span className="font-medium text-slate-800">{a.userName ?? "النظام"}</span>
                      <span className="text-slate-500"> — {AUDIT_ACTION[a.action] ?? a.action}</span>
                    </span>
                    <span className="shrink-0 text-xs text-slate-400">{timeAgo(a.createdAt)}</span>
                  </li>
                ))}
              </ul>
            )}
          </Card>
        )}

        {!d.recentActivity && !d.assignedVehicles && (
          <Card className="xl:col-span-2">
            <CardHeader title="اختصارات" />
            <div className="grid grid-cols-1 gap-3 p-5 sm:grid-cols-2">
              <Link to="/my-assignments" className="flex items-center gap-3 rounded-lg border border-slate-200 p-4 hover:border-brand-300 hover:bg-brand-50/40">
                <Icon name="inbox" className="text-brand-700" /> <span className="font-medium">إسناداتي</span>
              </Link>
              {d.projects && (
                <Link to="/projects" className="flex items-center gap-3 rounded-lg border border-slate-200 p-4 hover:border-brand-300 hover:bg-brand-50/40">
                  <Icon name="folder" className="text-brand-700" /> <span className="font-medium">المشاريع</span>
                </Link>
              )}
              {d.vehicles && (
                <Link to="/vehicles" className="flex items-center gap-3 rounded-lg border border-slate-200 p-4 hover:border-brand-300 hover:bg-brand-50/40">
                  <Icon name="truck" className="text-brand-700" /> <span className="font-medium">المركبات</span>
                </Link>
              )}
            </div>
          </Card>
        )}
      </div>
    </>
  );
}
