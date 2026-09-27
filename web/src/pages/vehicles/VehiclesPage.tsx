import { useState } from "react";
import { Link, useNavigate, useSearchParams } from "react-router";
import { DataList } from "../../components/DataList";
import { Alert, Button, Card, EmptyState, Input, Loading, PageHeader, Pagination, Select, StatusBadge } from "../../components/ui";
import { useApi } from "../../hooks/useApi";
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
  const [params] = useSearchParams();
  const [q, setQ] = useState(params.get("q") ?? "");
  const [status, setStatus] = useState(params.get("status") ?? "");
  const [projectId, setProjectId] = useState(params.get("projectId") ?? "");
  const [page, setPage] = useState(1);
  const [creating, setCreating] = useState(false);
  const { data, loading, error } = useApi<Paged<Vehicle>>("/vehicles", { q, status, projectId, page, pageSize: 20 });
  const projects = useApi<Paged<Project>>(can("projects.read") ? "/projects" : null, { pageSize: 100 });
  const reset = <T,>(fn: (v: T) => void) => (v: T) => { fn(v); setPage(1); };

  return (
    <>
      <PageHeader
        title={t("common.vehicles")}
        subtitle={t("vehicles.vehiclesWithinYourPermissions")}
        actions={can("vehicles.create") && <Button icon="plus" onClick={() => setCreating(true)}>{t("common.addVehicle")}</Button>}
      />
      <Card>
        <div className="grid grid-cols-1 gap-3 border-b border-slate-100 p-4 sm:grid-cols-3 lg:flex">
          <Input placeholder={t("vehicles.plateNumberVinMakeOr")} value={q} onChange={(e) => reset(setQ)(e.target.value)} className="lg:max-w-xs" />
          <Select value={status} onChange={(e) => reset(setStatus)(e.target.value)} className="lg:max-w-48">
            <option value="">{t("vehicles.allStatusesExceptArchived")}</option>
            {Object.entries(VEHICLE_STATUS).map(([k, l]) => (
              <option key={k} value={k}>{l.label}</option>
            ))}
          </Select>
          {projects.data && (
            <Select value={projectId} onChange={(e) => reset(setProjectId)(e.target.value)} className="lg:max-w-56">
              <option value="">{t("common.allProjects")}</option>
              {projects.data.data.map((p) => (
                <option key={p.id} value={p.id}>{p.name}</option>
              ))}
            </Select>
          )}
        </div>
        {loading ? (
          <Loading />
        ) : error ? (
          <div className="p-4"><Alert>{error.message}</Alert></div>
        ) : !data || data.data.length === 0 ? (
          <EmptyState icon="truck" title={t("common.noVehicles")} description={q || status || projectId ? t("common.tryChangingTheSearchCriteria") : t("vehicles.noVehiclesWithinYourScope")} />
        ) : (
          <>
            <DataList
              rows={data.data}
              rowKey={(v) => v.id}
              onRowClick={(v) => navigate(`/vehicles/${v.id}`)}
              columns={[
                {
                  header: t("common.plateNumber"),
                  primary: true,
                  cell: (v) => (
                    <span>
                      <Link to={`/vehicles/${v.id}`} onClick={(e) => e.stopPropagation()} className="font-semibold text-slate-900 hover:text-brand-700 ltr">{v.plateNumber}</Link>
                      {v.vehicleNumber && <span className="ms-2 text-xs text-slate-400">#{v.vehicleNumber}</span>}
                    </span>
                  ),
                },
                { header: t("common.vehicle"), cell: (v) => `${v.make} ${v.model}` },
                { header: t("common.year"), cell: (v) => v.year ?? "—", hideOnMobile: true },
                { header: t("common.project"), cell: (v) => v.projectName ?? <span className="text-slate-400">{t("common.unassigned2")}</span> },
                { header: t("common.odometer"), cell: (v) => t("common.km", { currentOdometer: formatNumber(v.currentOdometer) }) },
                { header: t("common.status"), cell: (v) => <StatusBadge map={VEHICLE_STATUS} value={v.status} /> },
              ]}
            />
            <Pagination {...data.meta} onPage={setPage} />
          </>
        )}
      </Card>
      <VehicleFormModal open={creating} onClose={() => setCreating(false)} onSaved={(v) => navigate(`/vehicles/${v.id}`)} />
    </>
  );
}
