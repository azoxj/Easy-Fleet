import { useState } from "react";
import { Link, useNavigate, useParams } from "react-router";
import { useConfirm, useToast } from "../../components/feedback";
import { Icon } from "../../components/icons";
import { EmployeeDocuments } from "./EmployeeDocuments";
import { Button, Card, CardHeader, DescList, EmptyState, Loading, PageHeader, StatusBadge } from "../../components/ui";
import { useApi } from "../../hooks/useApi";
import { api } from "../../lib/api";
import { formatDate, formatDateTime } from "../../lib/format";
import { errorMessage } from "../../lib/forms";
import { EMPLOYEE_STATUS } from "../../lib/labels";
import type { EmployeeDetail } from "../../lib/types";
import { DriverFormModal } from "../drivers/DriverFormModal";
import { EmployeeFormModal } from "./EmployeeFormModal";
import { t } from "../../i18n";

export function EmployeeDetailPage() {
  const { id = "" } = useParams();
  const navigate = useNavigate();
  const toast = useToast();
  const confirm = useConfirm();
  const { data, loading, error, reload } = useApi<{ data: EmployeeDetail }>(`/employees/${id}`);
  const [editing, setEditing] = useState(false);
  const [creatingDriver, setCreatingDriver] = useState(false);

  if (loading) return <Loading />;
  if (error || !data) return <EmptyState icon="id" title={error?.status === 404 ? t("employeeDetail.employeeNotFound") : t("employeeDetail.couldNotLoadTheEmployee")} description={error?.message} action={<Link to="/employees" className="text-sm text-brand-700">{t("employeeDetail.backToEmployees")}</Link>} />;
  const e = data.data;

  const archive = async () => {
    const ok = await confirm({ title: t("employeeDetail.archiveEmployee"), message: t("employeeDetail.willBeArchivedTheEmployee", { fullName: e.fullName, value: e.driver ? t("employeeDetail.andTheLinkedDriverProfile") : "" }), confirmLabel: t("common.archive"), danger: true });
    if (!ok) return;
    try {
      await api(`/employees/${id}/archive`, { method: "POST" });
      toast.success(t("employeeDetail.employeeArchived"));
      reload();
    } catch (err) {
      toast.error(errorMessage(err));
    }
  };

  return (
    <>
      <PageHeader
        back={<Link to="/employees" className="mb-2 inline-flex items-center gap-1 text-sm text-slate-500 hover:text-slate-700"><Icon name="chevron" className="size-4" /> {t("common.employees")}</Link>}
        title={<span className="flex flex-wrap items-center gap-3">{e.fullName} <StatusBadge map={EMPLOYEE_STATUS} value={e.status} /></span>}
        subtitle={<span className="ltr">{e.employeeNumber}</span>}
        actions={
          <>
            {e.capabilities.createDriver && <Button variant="secondary" icon="plus" onClick={() => setCreatingDriver(true)}>{t("employeeDetail.createDriverProfile")}</Button>}
            {e.capabilities.update && <Button variant="secondary" icon="edit" onClick={() => setEditing(true)}>{t("common.edit")}</Button>}
            {e.capabilities.archive && <Button variant="danger" icon="archive" onClick={() => void archive()}>{t("common.archive")}</Button>}
          </>
        }
      />
      <div className="grid grid-cols-1 gap-6 xl:grid-cols-3">
        <Card className="xl:col-span-2">
          <CardHeader title={t("common.employeeDetails")} />
          <div className="p-5">
            <DescList
              items={[
                { label: t("common.nationalIdIqamaNumber"), value: e.nationalIdOrIqama ? <span className="ltr">{e.nationalIdOrIqama}</span> : "—" },
                { label: t("common.mobile"), value: e.phone ? <span className="ltr">{e.phone}</span> : "—" },
                { label: t("common.email"), value: e.email ? <span className="ltr break-all">{e.email}</span> : "—" },
                { label: t("common.jobTitle"), value: e.jobTitle ?? "—" },
                { label: t("common.project"), value: e.projectId ? <Link className="text-brand-700 hover:underline" to={`/projects/${e.projectId}`}>{e.projectName}</Link> : t("common.noProject") },
                { label: t("common.startDate"), value: formatDate(e.hireDate) },
                { label: t("employeeDetail.linkedLoginAccount"), value: e.linkedUser ? `${e.linkedUser.name}` : t("employeeDetail.none") },
                { label: t("common.lastUpdated"), value: formatDateTime(e.updatedAt) },
              ]}
            />
            {e.notes && <p className="mt-5 rounded-lg bg-slate-50 p-4 text-sm whitespace-pre-line text-slate-700">{e.notes}</p>}
          </div>
        </Card>
        <Card>
          <CardHeader title={t("common.driverProfile")} />
          {e.driver ? (
            <div className="space-y-3 p-5 text-sm">
              <p>{t("employeeDetail.licenseExpiryDate")} <span className="font-medium">{formatDate(e.driver.licenseExpiryDate)}</span></p>
              <p>{t("common.currentVehicle")} <span className="font-medium ltr">{e.driver.currentVehiclePlate ?? "—"}</span></p>
              <Link to={`/drivers/${e.driver.id}`} className="inline-flex items-center gap-1 font-medium text-brand-700 hover:underline">{t("employeeDetail.viewDriverProfile")} <Icon name="back" className="size-4" /></Link>
            </div>
          ) : (
            <EmptyState icon="user" title={t("employeeDetail.notADriver")} description={t("employeeDetail.aDriverProfileCanBe")} />
          )}
        </Card>
      </div>
      <EmployeeDocuments employeeId={e.id} canEdit={e.capabilities.update} />
      <EmployeeFormModal open={editing} onClose={() => setEditing(false)} employee={e} onSaved={() => reload()} />
      <DriverFormModal open={creatingDriver} onClose={() => setCreatingDriver(false)} employeeId={e.id} employeeName={e.fullName} onSaved={(driverId) => navigate(`/drivers/${driverId}`)} />
    </>
  );
}
