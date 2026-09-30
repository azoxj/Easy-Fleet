import { useState } from "react";
import { Link, useNavigate } from "react-router";
import { DataList, ListBody } from "../../components/DataList";
import { Button, Card, EmptyState, Input, PageHeader, Pagination, Select, StatusBadge } from "../../components/ui";
import { useApi } from "../../hooks/useApi";
import { useListState } from "../../hooks/useListState";
import type { Paged } from "../../lib/api";
import { useAuth } from "../../lib/auth";
import { formatNumber } from "../../lib/format";
import { VEHICLE_STATUS } from "../../lib/labels";
import type { Project, Vehicle } from "../../lib/types";
import { VehicleFormModal } from "./VehicleFormModal";
import { t } from "../../i18n";

export function VehiclesPage() {
  const { can } = useAuth();
  const navigate = useNavigate();
  const list = useListState({ q: "", status: "", projectId: "" });
  const [creating, setCreating] = useState(false);
  const { data, loading, error } = useApi<Paged<Vehicle>>("/vehicles", list.query);
  const projects = useApi<Paged<Project>>(can("projects.read") ? "/projects" : null, { pageSize: 100 });
  const { status, projectId } = list.f;

  return (
    <>
      <PageHeader
        title={t("common.vehicles")}
        subtitle={t("vehicles.vehiclesWithinYourPermissions")}
        actions={can("vehicles.create") && <Button icon="plus" onClick={() => setCreating(true)}>{t("common.addVehicle")}</Button>}
      />
      <Card>
        <div className="grid grid-cols-1 gap-3 border-b border-slate-100 p-4 sm:grid-cols-3 lg:flex">
          <Input placeholder={t("vehicles.plateNumberVinMakeOr")} value={list.search} onChange={(e) => list.setSearch(e.target.value)} aria-label={t("common.search")} className="lg:max-w-xs" />
          <Select value={status} onChange={list.bind("status")} aria-label={t("common.status")} className="lg:max-w-48">
            <option value="">{t("vehicles.allStatusesExceptArchived")}</option>
            {Object.entries(VEHICLE_STATUS).map(([k, l]) => (
              <option key={k} value={k}>{l.label}</option>
            ))}
          </Select>
          {projects.data && (
            <Select value={projectId} onChange={list.bind("projectId")} aria-label={t("common.project")} className="lg:max-w-56">
              <option value="">{t("common.allProjects")}</option>
              {projects.data.data.map((p) => (
                <option key={p.id} value={p.id}>{p.name}</option>
              ))}
            </Select>
          )}
        </div>
        <ListBody
          loading={loading}
          error={error}
          hasData={!!data}
          cols={6}
          empty={data && !data.data.length ? <EmptyState icon="truck" title={t("common.noVehicles")} description={list.f.q || list.active ? t("common.tryChangingTheSearchCriteria") : t("vehicles.noVehiclesWithinYourScope")} /> : null}
        >
          {data && (
          <>
            <DataList
              rows={data.data}
              rowKey={(v) => v.id}
              sort={list.sort}
              onSortChange={list.setSort}
              preview={{ title: (v) => <span className="ltr">{v.plateNumber}</span>, href: (v) => `/vehicles/${v.id}` }}
              columns={[
                {
                  header: t("common.plateNumber"),
                  primary: true,
                  sortKey: "plateNumber",
                  cell: (v) => (
                    <span>
                      <Link to={`/vehicles/${v.id}`} onClick={(e) => e.stopPropagation()} className="font-semibold text-slate-900 hover:text-brand-700 ltr">{v.plateNumber}</Link>
                      {v.vehicleNumber && <span className="ms-2 text-xs text-slate-400">#{v.vehicleNumber}</span>}
                    </span>
                  ),
                },
                { header: t("common.vehicle"), cell: (v) => `${v.make} ${v.model}`, sortKey: "make" },
                { header: t("common.year"), cell: (v) => v.year ?? "—", hideOnMobile: true, sortKey: "year", sortFirst: "desc" },
                { header: t("common.project"), cell: (v) => v.projectName ?? <span className="text-slate-400">{t("common.unassigned2")}</span>, sortKey: "projectName" },
                { header: t("common.odometer"), cell: (v) => t("common.km", { currentOdometer: formatNumber(v.currentOdometer) }), sortKey: "currentOdometer", sortFirst: "desc" },
                { header: t("common.status"), cell: (v) => <StatusBadge map={VEHICLE_STATUS} value={v.status} />, sortKey: "status" },
              ]}
            />
            <Pagination {...data.meta} onPage={list.setPage} />
          </>
          )}
        </ListBody>
      </Card>
      <VehicleFormModal open={creating} onClose={() => setCreating(false)} onSaved={(v) => navigate(`/vehicles/${v.id}`)} />
    </>
  );
}
