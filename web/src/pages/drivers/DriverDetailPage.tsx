import { useState } from "react";
import { Link, useParams } from "react-router";
import { AlertList, ExpiryDate } from "../../components/common";
import { useConfirm, useToast } from "../../components/feedback";
import { Icon } from "../../components/icons";
import { Button, Card, CardHeader, DescList, EmptyState, Loading, PageHeader, StatusBadge } from "../../components/ui";
import { useApi } from "../../hooks/useApi";
import { api } from "../../lib/api";
import { useAuth } from "../../lib/auth";
import { formatDate, formatDateTime } from "../../lib/format";
import { errorMessage } from "../../lib/forms";
import { DRIVER_STATUS, LICENSE_TYPE } from "../../lib/labels";
import type { DriverDetail } from "../../lib/types";
import { DriverFormModal } from "./DriverFormModal";
import { t } from "../../i18n";

function Later({ title }: { title: string }) {
  return (
    <Card>
      <CardHeader title={title} />
      <EmptyState icon="clock" title={t("common.comingSoon")} description={t("driverDetail.availableWithItsModuleIn")} />
    </Card>
  );
}

export function DriverDetailPage() {
  const { id = "" } = useParams();
  const { can } = useAuth();
  const toast = useToast();
  const confirm = useConfirm();
  const { data, loading, error, reload } = useApi<{ data: DriverDetail }>(`/drivers/${id}`);
  const [editing, setEditing] = useState(false);

  if (loading) return <Loading />;
  if (error || !data) return <EmptyState icon="user" title={error?.status === 404 ? t("driverDetail.driverNotFound") : t("driverDetail.couldNotLoadTheDriver")} description={error?.message} action={<Link to="/drivers" className="text-sm text-brand-700">{t("driverDetail.backToDrivers")}</Link>} />;
  const d = data.data;

  const archive = async () => {
    if (!(await confirm({ title: t("driverDetail.archiveDriver"), message: t("driverDetail.theDriverProfileOfWill", { fullName: d.fullName }), confirmLabel: t("common.archive"), danger: true }))) return;
    try {
      await api(`/drivers/${id}/archive`, { method: "POST" });
      toast.success(t("driverDetail.driverProfileArchived"));
      reload();
    } catch (err) {
      toast.error(errorMessage(err));
    }
  };

  return (
    <>
      <PageHeader
        back={<Link to="/drivers" className="mb-2 inline-flex items-center gap-1 text-sm text-slate-500 hover:text-slate-700"><Icon name="chevron" className="size-4" /> {t("common.drivers")}</Link>}
        title={<span className="flex flex-wrap items-center gap-3">{d.fullName} <StatusBadge map={DRIVER_STATUS} value={d.status} /> {d.archivedAt && <StatusBadge map={{ A: { label: t("driverDetail.archived"), tone: "gray" } }} value="A" />}</span>}
        subtitle={<span className="ltr">{d.employeeNumber}</span>}
        actions={
          <>
            {d.capabilities.update && <Button variant="secondary" icon="edit" onClick={() => setEditing(true)}>{t("common.edit")}</Button>}
            {d.capabilities.archive && <Button variant="danger" icon="archive" onClick={() => void archive()}>{t("common.archive")}</Button>}
          </>
        }
      />
      {d.alerts.length > 0 && <div className="mb-6"><AlertList alerts={d.alerts} /></div>}

      <div className="grid grid-cols-1 gap-6 xl:grid-cols-3">
        <Card className="xl:col-span-2">
          <CardHeader title={t("driverDetail.licenseDetails")} />
          <div className="p-5">
            <DescList
              items={[
                { label: t("common.licenseNumber"), value: d.licenseNumber ? <span className="ltr">{d.licenseNumber}</span> : "—" },
                { label: t("common.licenseType"), value: d.licenseType ? LICENSE_TYPE[d.licenseType] : "—" },
                { label: t("common.issueDate"), value: formatDate(d.licenseIssueDate) },
                { label: t("common.expiryDate"), value: <ExpiryDate date={d.licenseExpiryDate} status={d.licenseStatus} daysLeft={d.licenseDaysLeft} /> },
              ]}
            />
            {d.notes && <p className="mt-5 rounded-lg bg-slate-50 p-4 text-sm whitespace-pre-line text-slate-700">{d.notes}</p>}
          </div>
        </Card>
        <Card>
          <CardHeader title={t("common.employeeDetails")} />
          <div className="space-y-3 p-5 text-sm">
            <p>{t("common.project2")} <span className="font-medium">{d.projectId && can("projects.read") ? <Link to={`/projects/${d.projectId}`} className="text-brand-700 hover:underline">{d.projectName}</Link> : (d.projectName ?? "—")}</span></p>
            <p>{t("driverDetail.mobile")} <span className="font-medium ltr">{d.phone ?? "—"}</span></p>
            <p>
              {t("common.currentVehicle")}{" "}
              {d.currentVehicleId ? <Link to={`/vehicles/${d.currentVehicleId}`} className="font-medium text-brand-700 hover:underline ltr">{d.currentVehiclePlate}</Link> : <span className="font-medium">{t("common.none")}</span>}
            </p>
            {can("employees.read") && <Link to={`/employees/${d.employeeId}`} className="inline-flex items-center gap-1 font-medium text-brand-700 hover:underline">{t("driverDetail.employeeProfile")} <Icon name="back" className="size-4" /></Link>}
          </div>
        </Card>
      </div>

      <Card className="mt-6">
        <CardHeader title={t("driverDetail.vehicleHistory")} subtitle={t("driverDetail.vehiclesAssignedToThisDriver")} />
        {d.history.length === 0 ? (
          <EmptyState icon="truck" title={t("driverDetail.noVehicleHistoryYet")} />
        ) : (
          <ul className="divide-y divide-slate-100">
            {d.history.map((h) => (
              <li key={h.id} className="flex flex-wrap items-center justify-between gap-2 px-5 py-3 text-sm">
                <span className="font-medium">
                  {h.vehicleId ? <Link to={`/vehicles/${h.vehicleId}`} className="text-brand-700 hover:underline ltr">{h.plateNumber}</Link> : <span className="text-slate-400">{t("driverDetail.vehicleOutsideYourScope")}</span>}
                </span>
                <span className="text-slate-500">
                  {formatDateTime(h.assignedAt)} ← {h.unassignedAt ? formatDateTime(h.unassignedAt) : <span className="font-medium text-emerald-700">{t("driverDetail.current")}</span>}
                </span>
              </li>
            ))}
          </ul>
        )}
      </Card>

      <div className="mt-6 grid grid-cols-1 gap-6 lg:grid-cols-3">
        <Later title={t("driverDetail.handoverReturnHistory")} />
        <Later title={t("common.accidents")} />
        <Later title={t("common.violations")} />
      </div>

      <DriverFormModal open={editing} onClose={() => setEditing(false)} driver={d} onSaved={() => reload()} />
    </>
  );
}
