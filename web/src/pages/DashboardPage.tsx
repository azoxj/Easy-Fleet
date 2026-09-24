import { Link } from "react-router";
import { Icon } from "../components/icons";
import { Alert, Card, CardHeader, EmptyState, Loading, PageHeader, StatCard, StatusBadge } from "../components/ui";
import { useApi } from "../hooks/useApi";
import { useAuth } from "../lib/auth";
import { formatNumber, timeAgo } from "../lib/format";
import { AUDIT_ACTION, VEHICLE_STATUS } from "../lib/labels";

type Dashboard = {
  view: "admin" | "project_manager" | "finance" | "driver" | "general";
  vehicles: { total: number; active: number; inMaintenance: number; byStatus: Record<string, number> } | null;
  projects: { total: number; active: number } | null;
  myAssignments: Record<string, number> | null;
  unreadNotifications: number;
  assignedVehicles: { id: string; plateNumber: string; make: string; model: string; status: string }[] | null;
  recentActivity: { id: number; action: string; entity: string; createdAt: string; userName: string | null }[] | null;
  upcoming: Record<string, null>;
};

const VIEW_TITLE: Record<Dashboard["view"], string> = {
  admin: "نظرة عامة على الأسطول",
  project_manager: "مشاريعي",
  finance: "لوحة المالية",
  driver: "لوحتي",
  general: "لوحة التحكم",
};

/** Placeholder card for metrics owned by modules that are not built yet — never shows invented numbers. */
function Upcoming({ label, icon }: { label: string; icon: string }) {
  return <StatCard label={label} value={<span className="text-base font-medium text-slate-400">قريبًا</span>} icon={icon} tone="gray" hint="تتوفر مع الوحدة الخاصة بها" />;
}

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

      <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 xl:grid-cols-4">
        {d.vehicles && <StatCard label={d.view === "driver" ? "مركباتي" : "إجمالي المركبات"} value={formatNumber(d.vehicles.total)} icon="truck" />}
        {d.vehicles && d.view !== "driver" && <StatCard label="مركبات نشطة" value={formatNumber(d.vehicles.active)} icon="check" tone="green" />}
        {d.vehicles && d.view !== "driver" && <StatCard label="في الصيانة" value={formatNumber(d.vehicles.inMaintenance)} icon="wrench" tone="amber" />}
        {d.projects && <StatCard label="المشاريع" value={formatNumber(d.projects.total)} icon="folder" tone="violet" hint={`${formatNumber(d.projects.active)} نشط`} />}
        <StatCard label="إسناداتي المفتوحة" value={formatNumber(pendingMine)} icon="inbox" tone="blue" />
        <StatCard label="إشعارات غير مقروءة" value={formatNumber(d.unreadNotifications)} icon="bell" tone="red" />
        {d.view === "admin" && (
          <>
            <Upcoming label="مستندات تنتهي قريبًا" icon="calendar" />
            <Upcoming label="الحوادث" icon="alert" />
            <Upcoming label="المخالفات" icon="ticket" />
            <Upcoming label="التكلفة الشهرية" icon="receipt" />
            <Upcoming label="موافقات معلقة" icon="clock" />
            <Upcoming label="فواتير معلقة" icon="receipt" />
          </>
        )}
        {d.view === "project_manager" && (
          <>
            <Upcoming label="طلبات صيانة" icon="wrench" />
            <Upcoming label="جاهزة للاستلام" icon="key" />
          </>
        )}
        {d.view === "finance" && (
          <>
            <Upcoming label="فواتير بانتظار المراجعة" icon="receipt" />
            <Upcoming label="معتمدة" icon="check" />
            <Upcoming label="بانتظار الدفع" icon="clock" />
            <Upcoming label="مدفوعة" icon="receipt" />
            <Upcoming label="إجمالي القيمة المالية" icon="receipt" />
          </>
        )}
        {d.view === "driver" && <Upcoming label="عملية التسليم الحالية" icon="key" />}
      </div>

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
