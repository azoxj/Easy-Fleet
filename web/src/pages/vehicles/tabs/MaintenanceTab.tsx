import { useState } from "react";
import { Link, useNavigate } from "react-router";
import { DataList } from "../../../components/DataList";
import { Alert, Button, Card, CardHeader, EmptyState, Loading, StatCard, StatusBadge } from "../../../components/ui";
import { useApi } from "../../../hooks/useApi";
import { useAuth } from "../../../lib/auth";
import { formatDate, formatMoney, formatNumber } from "../../../lib/format";
import { MAINTENANCE_PRIORITY, MAINTENANCE_STATUS, mrNumber } from "../../../lib/maintenance";
import type { VehicleMaintenanceSummary } from "../../../lib/types";
import { CreateMaintenanceModal } from "../../maintenance/CreateMaintenanceModal";

export function MaintenanceTab({ vehicleId, archived }: { vehicleId: string; archived: boolean }) {
  const { can } = useAuth();
  const navigate = useNavigate();
  const { data, loading, error, reload } = useApi<{ data: VehicleMaintenanceSummary }>(`/vehicles/${vehicleId}/maintenance`);
  const [creating, setCreating] = useState(false);
  if (loading) return <Loading />;
  if (error) return <Alert>{error.message}</Alert>;
  const s = data!.data;
  return (
    <div className="space-y-6">
      <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 xl:grid-cols-4">
        <StatCard
          label="الحالة الحالية"
          value={s.current ? <StatusBadge map={MAINTENANCE_STATUS} value={s.current.status} /> : <span className="text-base font-medium text-slate-500">لا توجد صيانة مفتوحة</span>}
          icon="wrench"
          hint={s.current ? <Link to={`/maintenance/${s.current.id}`} className="text-brand-700 hover:underline">{mrNumber(s.current.number)}</Link> : undefined}
        />
        <StatCard label="طلبات مفتوحة" value={formatNumber(s.openCount)} icon="inbox" tone="amber" hint={`بانتظار الاعتماد ${s.awaitingApproval} · بانتظار الاستلام ${s.awaitingHandover}`} />
        <StatCard label="آخر صيانة" value={<span className="text-base">{s.lastMaintenance ? formatDate(s.lastMaintenance.completedAt) : "—"}</span>} icon="check" tone="green" hint={s.lastMaintenance?.issue} />
        <StatCard label="إجمالي تكلفة الصيانة" value={<span className="text-lg">{s.totalCost !== null ? formatMoney(s.totalCost) : "غير متاح لصلاحياتك"}</span>} icon="receipt" tone="violet" />
      </div>
      <Card>
        <CardHeader title="الصيانة الدورية القادمة" />
        <div className="p-5 text-sm text-slate-500">
          <span className="rounded bg-slate-100 px-2 py-0.5 text-xs">قريبًا</span> جدولة الصيانة الدورية لم تُبنَ بعد — لا تُعرض تواريخ تقديرية.
        </div>
      </Card>
      <Card>
        <CardHeader title="سجل الصيانة" action={can("maintenance.create") && !archived && <Button icon="plus" onClick={() => setCreating(true)}>طلب صيانة</Button>} />
        {s.history.length === 0 ? <EmptyState icon="wrench" title="لا توجد طلبات صيانة لهذه المركبة" /> : (
          <DataList
            rows={s.history}
            rowKey={(r) => r.id}
            onRowClick={(r) => navigate(`/maintenance/${r.id}`)}
            columns={[
              { header: "الطلب", primary: true, cell: (r) => <span><span className="font-semibold ltr">{mrNumber(r.number)}</span> — {r.issue}</span> },
              { header: "الأولوية", cell: (r) => <StatusBadge map={MAINTENANCE_PRIORITY} value={r.priority} /> },
              { header: "الحالة", cell: (r) => <StatusBadge map={MAINTENANCE_STATUS} value={r.status} /> },
              { header: "الفني", cell: (r) => r.technicianName ?? "—", hideOnMobile: true },
              { header: "التكلفة", cell: (r) => (r.cost !== null ? formatMoney(r.cost) : "—"), hideOnMobile: true },
              { header: "التاريخ", cell: (r) => formatDate(r.createdAt) },
            ]}
          />
        )}
      </Card>
      <CreateMaintenanceModal open={creating} onClose={() => setCreating(false)} vehicleId={vehicleId} onCreated={(id) => { reload(); navigate(`/maintenance/${id}`); }} />
    </div>
  );
}
