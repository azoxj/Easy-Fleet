
import { Link } from "react-router";
import { ExpiryDate } from "../../components/common";
import { DataList, ListBody } from "../../components/DataList";
import { Card, EmptyState, Input, PageHeader, Pagination, Select, StatusBadge } from "../../components/ui";
import { useApi } from "../../hooks/useApi";
import { useListState } from "../../hooks/useListState";
import type { Paged } from "../../lib/api";
import { useAuth } from "../../lib/auth";
import { DRIVER_STATUS, LICENSE_TYPE } from "../../lib/labels";
import type { DriverRow, Project } from "../../lib/types";
import { t } from "../../i18n";

export function DriversPage() {
  const { can } = useAuth();
  const list = useListState({ q: "", projectId: "", status: "", licenseStatus: "" });
  const { q, projectId, status, licenseStatus } = list.f;
  const { data, loading, error } = useApi<Paged<DriverRow>>("/drivers", list.query);
  const projects = useApi<Paged<Project>>(can("projects.read") ? "/projects" : null, { pageSize: 100 });

  return (
    <>
      <PageHeader
        title={t("common.drivers")}
        subtitle={<>{t("drivers.aDriverProfileIsCreated")} {can("employees.read") && <Link to="/employees" className="text-brand-700 hover:underline">{t("common.employees")}</Link>}</>}
      />
      <Card>
        <div className="grid grid-cols-1 gap-3 border-b border-slate-100 p-4 sm:grid-cols-2 lg:grid-cols-4">
          <Input placeholder={t("drivers.searchByNameEmployeeNumber")} value={list.search} onChange={(e) => list.setSearch(e.target.value)} aria-label={t("common.search")} />
          {projects.data ? (
            <Select value={projectId} onChange={list.bind("projectId")} aria-label={t("common.project")}>
              <option value="">{t("common.allProjects")}</option>
              {projects.data.data.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}
            </Select>
          ) : <span className="hidden lg:block" />}
          <Select value={status} onChange={list.bind("status")} aria-label={t("common.status")}>
            <option value="">{t("common.allStatuses")}</option>
            {Object.entries(DRIVER_STATUS).map(([k, l]) => <option key={k} value={k}>{l.label}</option>)}
          </Select>
          <Select value={licenseStatus} onChange={list.bind("licenseStatus")} aria-label={t("drivers.licenseStatus")}>
            <option value="">{t("drivers.allLicenses")}</option>
            <option value="EXPIRING_SOON">{t("common.expiringWithin30Days")}</option>
            <option value="EXPIRED">{t("common.expired")}</option>
          </Select>
        </div>
        <ListBody loading={loading} error={error} hasData={!!data} cols={7} empty={data && !data.data.length ? <EmptyState icon="user" title={t("drivers.noDrivers")} description={q || projectId || status || licenseStatus ? t("common.tryChangingTheSearchCriteria") : t("drivers.createADriverProfileFrom")} /> : null}>
          {data && (
          <>
            <DataList
              rows={data.data}
              rowKey={(d) => d.id}
              sort={list.sort}
              onSortChange={list.setSort}
              preview={{ title: (d) => d.fullName, href: (d) => `/drivers/${d.id}` }}
              columns={[
                { header: t("common.driver"), primary: true, cell: (d) => <span className="font-medium text-slate-900">{d.fullName}</span>, sortKey: "fullName" },
                { header: t("common.licenseNumber"), cell: (d) => (d.licenseNumber ? <span className="ltr">{d.licenseNumber}</span> : "—"), sortKey: "licenseNumber" },
                { header: t("common.type"), cell: (d) => (d.licenseType ? LICENSE_TYPE[d.licenseType] : "—"), hideOnMobile: true },
                { header: t("drivers.licenseExpiry"), cell: (d) => <ExpiryDate date={d.licenseExpiryDate} status={d.licenseStatus} daysLeft={d.licenseDaysLeft} />, sortKey: "licenseExpiryDate" },
                { header: t("common.project"), cell: (d) => d.projectName ?? "—", sortKey: "projectName" },
                { header: t("drivers.currentVehicle"), cell: (d) => (d.currentVehiclePlate ? <span className="ltr">{d.currentVehiclePlate}</span> : "—"), sortKey: "currentVehiclePlate" },
                { header: t("common.status"), cell: (d) => <StatusBadge map={DRIVER_STATUS} value={d.status} /> },
              ]}
            />
            <Pagination {...data.meta} onPage={list.setPage} />
          </>
          )}
        </ListBody>
      </Card>
    </>
  );
}
