import { useState } from "react";
import { Link, useNavigate } from "react-router";
import { ExpiryDate } from "../../components/common";
import { DataList } from "../../components/DataList";
import { Alert, Card, EmptyState, Input, Loading, PageHeader, Pagination, Select, StatusBadge } from "../../components/ui";
import { useApi } from "../../hooks/useApi";
import type { Paged } from "../../lib/api";
import { useAuth } from "../../lib/auth";
import { DRIVER_STATUS, LICENSE_TYPE } from "../../lib/labels";
import type { DriverRow, Project } from "../../lib/types";
import { t } from "../../i18n";

export function DriversPage() {
  const { can } = useAuth();
  const navigate = useNavigate();
  const [q, setQ] = useState("");
  const [projectId, setProjectId] = useState("");
  const [status, setStatus] = useState("");
  const [licenseStatus, setLicenseStatus] = useState("");
  const [page, setPage] = useState(1);
  const { data, loading, error } = useApi<Paged<DriverRow>>("/drivers", { q, projectId, status, licenseStatus, page, pageSize: 20 });
  const projects = useApi<Paged<Project>>(can("projects.read") ? "/projects" : null, { pageSize: 100 });
  const reset = (fn: (v: string) => void) => (e: { target: { value: string } }) => { fn(e.target.value); setPage(1); };

  return (
    <>
      <PageHeader
        title={t("common.drivers")}
        subtitle={<>{t("drivers.aDriverProfileIsCreated")} {can("employees.read") && <Link to="/employees" className="text-brand-700 hover:underline">{t("common.employees")}</Link>}</>}
      />
      <Card>
        <div className="grid grid-cols-1 gap-3 border-b border-slate-100 p-4 sm:grid-cols-2 lg:grid-cols-4">
          <Input placeholder={t("drivers.searchByNameEmployeeNumber")} value={q} onChange={reset(setQ)} aria-label={t("common.search")} />
          {projects.data ? (
            <Select value={projectId} onChange={reset(setProjectId)} aria-label={t("common.project")}>
              <option value="">{t("common.allProjects")}</option>
              {projects.data.data.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}
            </Select>
          ) : <span className="hidden lg:block" />}
          <Select value={status} onChange={reset(setStatus)} aria-label={t("common.status")}>
            <option value="">{t("common.allStatuses")}</option>
            {Object.entries(DRIVER_STATUS).map(([k, l]) => <option key={k} value={k}>{l.label}</option>)}
          </Select>
          <Select value={licenseStatus} onChange={reset(setLicenseStatus)} aria-label={t("drivers.licenseStatus")}>
            <option value="">{t("drivers.allLicenses")}</option>
            <option value="EXPIRING_SOON">{t("common.expiringWithin30Days")}</option>
            <option value="EXPIRED">{t("common.expired")}</option>
          </Select>
        </div>
        {loading ? <Loading /> : error ? <div className="p-4"><Alert>{error.message}</Alert></div> : !data?.data.length ? (
          <EmptyState icon="user" title={t("drivers.noDrivers")} description={q || projectId || status || licenseStatus ? t("common.tryChangingTheSearchCriteria") : t("drivers.createADriverProfileFrom")} />
        ) : (
          <>
            <DataList
              rows={data.data}
              rowKey={(d) => d.id}
              onRowClick={(d) => navigate(`/drivers/${d.id}`)}
              columns={[
                { header: t("common.driver"), primary: true, cell: (d) => <span className="font-medium text-slate-900">{d.fullName}</span> },
                { header: t("common.licenseNumber"), cell: (d) => (d.licenseNumber ? <span className="ltr">{d.licenseNumber}</span> : "—") },
                { header: t("common.type"), cell: (d) => (d.licenseType ? LICENSE_TYPE[d.licenseType] : "—"), hideOnMobile: true },
                { header: t("drivers.licenseExpiry"), cell: (d) => <ExpiryDate date={d.licenseExpiryDate} status={d.licenseStatus} daysLeft={d.licenseDaysLeft} /> },
                { header: t("common.project"), cell: (d) => d.projectName ?? "—" },
                { header: t("drivers.currentVehicle"), cell: (d) => (d.currentVehiclePlate ? <span className="ltr">{d.currentVehiclePlate}</span> : "—") },
                { header: t("common.status"), cell: (d) => <StatusBadge map={DRIVER_STATUS} value={d.status} /> },
              ]}
            />
            <Pagination {...data.meta} onPage={setPage} />
          </>
        )}
      </Card>
    </>
  );
}
