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
import { t } from "../../../i18n";

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
          label={t("vehicleMaintenance.currentStatus")}
          value={s.current ? <StatusBadge map={MAINTENANCE_STATUS} value={s.current.status} /> : <span className="text-base font-medium text-slate-500">{t("vehicleMaintenance.noOpenMaintenance")}</span>}
          icon="wrench"
          hint={s.current ? <Link to={`/maintenance/${s.current.id}`} className="text-brand-700 hover:underline">{mrNumber(s.current.number)}</Link> : undefined}
        />
        <StatCard label={t("common.openRequests")} value={formatNumber(s.openCount)} icon="inbox" tone="amber" hint={t("vehicleMaintenance.pendingApprovalAwaitingPickup", { awaitingApproval: s.awaitingApproval, awaitingHandover: s.awaitingHandover })} />
        <StatCard label={t("common.lastMaintenance")} value={<span className="text-base">{s.lastMaintenance ? formatDate(s.lastMaintenance.completedAt) : "—"}</span>} icon="check" tone="green" hint={s.lastMaintenance?.issue} />
        <StatCard label={t("vehicleMaintenance.totalMaintenanceCost")} value={<span className="text-lg">{s.totalCost !== null ? formatMoney(s.totalCost) : t("vehicleMaintenance.notAvailableForYourPermissions")}</span>} icon="receipt" tone="violet" />
      </div>
      <Card>
        <CardHeader title={t("vehicleMaintenance.nextScheduledMaintenance")} />
        <div className="p-5 text-sm text-slate-500">
          <span className="rounded bg-slate-100 px-2 py-0.5 text-xs">{t("common.comingSoon")}</span> {t("vehicleMaintenance.scheduledMaintenancePlanningIsNot")}
        </div>
      </Card>
      <Card>
        <CardHeader title={t("vehicleMaintenance.maintenanceHistory")} action={can("maintenance.create") && !archived && <Button icon="plus" onClick={() => setCreating(true)}>{t("vehicleMaintenance.maintenanceRequest")}</Button>} />
        {s.history.length === 0 ? <EmptyState icon="wrench" title={t("vehicleMaintenance.noMaintenanceRequestsForThis")} /> : (
          <DataList
            rows={s.history}
            rowKey={(r) => r.id}
            onRowClick={(r) => navigate(`/maintenance/${r.id}`)}
            columns={[
              { header: t("common.request"), primary: true, cell: (r) => <span><span className="font-semibold ltr">{mrNumber(r.number)}</span> — {r.issue}</span> },
              { header: t("common.priority"), cell: (r) => <StatusBadge map={MAINTENANCE_PRIORITY} value={r.priority} /> },
              { header: t("common.status"), cell: (r) => <StatusBadge map={MAINTENANCE_STATUS} value={r.status} /> },
              { header: t("common.technician"), cell: (r) => r.technicianName ?? "—", hideOnMobile: true },
              { header: t("common.cost"), cell: (r) => (r.cost !== null ? formatMoney(r.cost) : "—"), hideOnMobile: true },
              { header: t("common.date"), cell: (r) => formatDate(r.createdAt) },
            ]}
          />
        )}
      </Card>
      <CreateMaintenanceModal open={creating} onClose={() => setCreating(false)} vehicleId={vehicleId} onCreated={(id) => { reload(); navigate(`/maintenance/${id}`); }} />
    </div>
  );
}
