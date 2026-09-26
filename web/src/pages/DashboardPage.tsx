import { Link, useNavigate } from "react-router";
import { LineChart, StackedBars } from "../components/charts";
import { FleetMapWidget } from "../components/FleetMapWidget";
import { Icon } from "../components/icons";
import { Alert, Card, CardHeader, EmptyState, Loading, PageHeader, StatCard, StatusBadge } from "../components/ui";
import { useApi } from "../hooks/useApi";
import { useAuth } from "../lib/auth";
import { formatMoney, formatNumber, timeAgo } from "../lib/format";
import { AUDIT_ACTION, COST_CATEGORY, VEHICLE_STATUS } from "../lib/labels";
import { entityLink, withRange } from "../lib/links";

type Dashboard = {
  view: "admin" | "project_manager" | "finance" | "driver" | "general";
  vehicles: { total: number; active: number; inMaintenance: number; byStatus: Record<string, number> } | null;
  projects: { total: number; active: number } | null;
  myAssignments: Record<string, number> | null;
  unreadNotifications: number;
  assignedVehicles: { id: string; plateNumber: string; make: string; model: string; status: string }[] | null;
  recentActivity: { id: number; action: string; entity: string; entityId: string | null; createdAt: string; userName: string | null }[] | null;
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
  const { me, can } = useAuth();
  const navigate = useNavigate();
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
              <Link to={a.link} className={`flex min-h-12 items-center gap-3 rounded-lg px-4 py-3 text-sm ring-1 transition hover:shadow-sm active:scale-[0.99] ${a.level === "danger" ? "bg-red-50 text-red-800 ring-red-200" : a.level === "warning" ? "bg-amber-50 text-amber-900 ring-amber-200" : "bg-blue-50 text-blue-800 ring-blue-200"}`}>
                <Icon name={a.level === "info" ? "bell" : "alert"} className="size-4 shrink-0" />
                <span className="flex-1">{a.title}</span>
                <b>{formatNumber(a.count)}</b>
                <Icon name="chevron" className="size-4 shrink-0 rotate-180 opacity-60" />
              </Link>
            </li>
          ))}
        </ul>
      )}

      <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 xl:grid-cols-4">
        {d.vehicles && <StatCard to="/vehicles" label={d.view === "driver" ? "مركباتي" : "إجمالي المركبات"} value={formatNumber(d.vehicles.total)} icon="truck" />}
        {d.vehicles && d.view !== "driver" && <StatCard to="/vehicles" label="مركبات نشطة" value={formatNumber(d.vehicles.active)} icon="check" tone="green" />}
        {d.vehicles && d.view !== "driver" && <StatCard to="/vehicles?status=IN_MAINTENANCE" label="في الصيانة" value={formatNumber(d.vehicles.inMaintenance)} icon="wrench" tone="amber" />}
        {d.projects && <StatCard to="/projects" label="المشاريع" value={formatNumber(d.projects.total)} icon="folder" tone="violet" hint={`${formatNumber(d.projects.active)} نشط`} />}
        <StatCard to="/my-assignments" label="إسناداتي المفتوحة" value={formatNumber(pendingMine)} icon="inbox" tone="blue" />
        <StatCard to="/notifications" label="إشعارات غير مقروءة" value={formatNumber(d.unreadNotifications)} icon="bell" tone="red" />
        {d.expiring.total !== null && (
          <StatCard
            to="/documents?status=EXPIRING"
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
        {d.pendingApprovals > 0 && <StatCard to="/approvals" label="بانتظار اعتمادي" value={formatNumber(d.pendingApprovals)} icon="stamp" tone="violet" />}
        {d.accidents && <StatCard to="/accidents?open=true" label="حوادث مفتوحة" value={formatNumber(d.accidents.open)} icon="alert" tone={d.accidents.open ? "red" : "green"} hint={`هذا الشهر: ${d.accidents.thisMonth}`} />}
        {d.violations && <StatCard to="/violations?status=OPEN" label="مخالفات غير مسددة" value={formatNumber(d.violations.open)} icon="ticket" tone="amber" hint={formatMoney(d.violations.openAmount)} />}
        {d.fuel && <StatCard to="/fuel" label="وقود هذا الشهر" value={formatMoney(d.fuel.cost)} icon="fuel" tone="blue" hint={`${formatNumber(d.fuel.liters)} لتر · ${d.fuel.fills} تعبئة`} />}
        {d.monthlyCost !== null && <StatCard to="/finance" label="التكلفة الشهرية" value={formatMoney(d.monthlyCost)} icon="receipt" tone="slate" hint="جميع فئات التكاليف" />}
        {d.invoices && (
          <>
            <StatCard to="/finance/invoices?status=SUBMITTED" label="فواتير بانتظار المراجعة" value={formatNumber(d.invoices.pending)} icon="receipt" tone="violet" />
            <StatCard to="/finance/invoices?status=TRANSFER_PENDING" label="بانتظار التحويل" value={formatNumber(d.invoices.transferPending)} icon="clock" tone="amber" hint={formatMoney(d.invoices.pendingPaymentAmount)} />
            <StatCard to="/finance/invoices?status=TRANSFERRED" label="فواتير محولة/مدفوعة" value={formatNumber(d.invoices.paid)} icon="check" tone="green" hint={d.invoices.overdue ? `متأخرة: ${d.invoices.overdue}` : undefined} />
            {d.view === "finance" && <StatCard label="إجمالي القيمة المالية" value={formatMoney(d.invoices.totalValue)} icon="chart" tone="slate" />}
          </>
        )}
        {d.currentHandover && <StatCard to={`/handovers/${d.currentHandover.id}`} label={d.currentHandover.status === "PENDING_HANDOVER" ? "مطلوب استلام مركبة" : "مركبة مستلمة (للإرجاع)"} value={<span className="ltr">{d.currentHandover.plateNumber}</span>} icon="key" tone="amber" />}
        {d.view === "driver" && <StatCard to="/tracking" label="تتبع الرحلة" value={d.activeTrip ? "رحلة نشطة" : "لا توجد رحلة"} icon="navigation" tone={d.activeTrip ? "green" : "gray"} />}
      </div>

      {can("gps.read") && d.view !== "driver" && <FleetMapWidget />}

      {d.maintenance && (
        <Card className="mt-6">
          <CardHeader title="الصيانة" action={<Link to="/maintenance" className="text-sm font-medium text-brand-700 hover:underline">كل الطلبات</Link>} />
          <div className="grid grid-cols-2 gap-px bg-slate-100 sm:grid-cols-3 xl:grid-cols-6">
            {[
              { label: "طلبات مفتوحة", value: d.maintenance.open, to: "/maintenance" },
              { label: "بانتظار الفحص", value: d.maintenance.awaitingInspection, to: "/maintenance?status=REQUESTED" },
              { label: "بانتظار الاعتماد", value: d.maintenance.awaitingApproval, to: "/maintenance?status=PENDING_APPROVAL" },
              { label: "قيد الإصلاح", value: d.maintenance.inRepair, to: "/maintenance?status=IN_REPAIR" },
              { label: "بانتظار الاستلام", value: d.maintenance.awaitingHandover, to: "/maintenance?status=READY_FOR_HANDOVER" },
              { label: "تكلفة الشهر", value: d.maintenance.costThisMonth !== null ? formatMoney(d.maintenance.costThisMonth) : "—", to: can("reports.read") ? "/reports" : undefined },
            ].map((k) => {
              const inner = (
                <>
                  <p className="text-xs text-slate-500">{k.label}</p>
                  <p className="mt-1 text-xl font-bold text-slate-900">{typeof k.value === "number" ? formatNumber(k.value) : k.value}</p>
                </>
              );
              return k.to ? (
                <Link key={k.label} to={k.to} className="block bg-white p-4 transition hover:bg-brand-50/40 active:bg-brand-50">{inner}</Link>
              ) : (
                <div key={k.label} className="bg-white p-4">{inner}</div>
              );
            })}
          </div>
        </Card>
      )}

      {(d.charts.costs || d.charts.fuel || d.charts.accidents || d.charts.maintenance) && (
        <div className="mt-6 grid grid-cols-1 gap-6 xl:grid-cols-2">
          {d.charts.costs && (
            <Card><CardHeader title="التكاليف الشهرية حسب الفئة" subtitle="آخر 6 أشهر" /><div className="p-5"><StackedBars rows={d.charts.costs} money onSelect={() => navigate(can("finance.read") ? "/finance" : "/reports")} series={Object.keys(COST_CATEGORY).filter((c) => d.charts.costs!.some((r) => Number(r[c] ?? 0) > 0)).map((c) => ({ key: c, label: COST_CATEGORY[c]! }))} /></div></Card>
          )}
          {d.charts.fuel && <Card><CardHeader title="تكلفة الوقود" subtitle="آخر 6 أشهر" /><div className="p-5"><LineChart points={d.charts.fuel.map((f) => ({ label: f.month, value: f.cost }))} onSelect={(m) => navigate(withRange("/fuel", m))} /></div></Card>}
          {d.charts.maintenance && <Card><CardHeader title="طلبات الصيانة الجديدة" /><div className="p-5"><StackedBars rows={d.charts.maintenance} series={[{ key: "count", label: "طلبات", color: "#d97706" }]} height={160} onSelect={(r) => navigate(withRange("/maintenance", String(r.month)))} /></div></Card>}
          {d.charts.accidents && <Card><CardHeader title="الحوادث" /><div className="p-5"><StackedBars rows={d.charts.accidents} series={[{ key: "count", label: "حوادث", color: "#dc2626" }]} height={160} onSelect={(r) => navigate(withRange("/accidents", String(r.month)))} /></div></Card>}
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
                    <li key={s}>
                      <Link to={`/vehicles?status=${s}`} className="-mx-2 block rounded-lg px-2 py-3 transition hover:bg-slate-50 active:bg-slate-100">
                        <div className="flex items-center justify-between text-sm">
                          <StatusBadge map={VEHICLE_STATUS} value={s} />
                          <span className="font-semibold text-slate-800">{formatNumber(n)}</span>
                        </div>
                        <div className="mt-2 h-1.5 overflow-hidden rounded-full bg-slate-100">
                          <div className="h-full rounded-full bg-brand-600" style={{ width: `${pct}%` }} />
                        </div>
                      </Link>
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
                {d.recentActivity.map((a) => {
                  const to = entityLink(a.entity, a.entityId);
                  const inner = (
                    <>
                      <span className="min-w-0">
                        <span className="font-medium text-slate-800">{a.userName ?? "النظام"}</span>
                        <span className="text-slate-500"> — {AUDIT_ACTION[a.action] ?? a.action}</span>
                      </span>
                      <span className="flex shrink-0 items-center gap-1 text-xs text-slate-400">
                        {timeAgo(a.createdAt)}
                        {to && <Icon name="chevron" className="size-3.5 rotate-180" />}
                      </span>
                    </>
                  );
                  return (
                    <li key={a.id}>
                      {to ? (
                        <Link to={to} className="flex min-h-12 items-center justify-between gap-3 px-5 py-3 text-sm transition hover:bg-slate-50 active:bg-slate-100">{inner}</Link>
                      ) : (
                        <div className="flex min-h-12 items-center justify-between gap-3 px-5 py-3 text-sm">{inner}</div>
                      )}
                    </li>
                  );
                })}
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
