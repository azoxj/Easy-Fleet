import { useState } from "react";
import { Link, useNavigate } from "react-router";
import { DataList, ListBody } from "../../components/DataList";
import { Button, Card, EmptyState, Input, PageHeader, Pagination, Select, StatusBadge } from "../../components/ui";
import { useApi } from "../../hooks/useApi";
import { useListState } from "../../hooks/useListState";
import type { Paged } from "../../lib/api";
import { useAuth } from "../../lib/auth";
import { formatDate, formatMoney } from "../../lib/format";
import { MAINTENANCE_PRIORITY, MAINTENANCE_STATUS, mrNumber } from "../../lib/maintenance";
import type { MaintenanceRow, Project, Vehicle } from "../../lib/types";
import { CreateMaintenanceModal } from "./CreateMaintenanceModal";
import { t } from "../../i18n";

export function MaintenanceListPage() {
  const { can } = useAuth();
  const navigate = useNavigate();
  const list = useListState({ q: "", projectId: "", vehicleId: "", status: "", priority: "", technicianId: "", from: "", to: "" });
  const f = list.f;
  const [creating, setCreating] = useState(false);
  const [showFilters, setShowFilters] = useState(false);
  const { data, loading, error } = useApi<Paged<MaintenanceRow>>("/maintenance", list.query);
  const projects = useApi<Paged<Project>>(can("projects.read") ? "/projects" : null, { pageSize: 100 });
  const vehicles = useApi<Paged<Vehicle>>(can("vehicles.read") ? "/vehicles" : null, { pageSize: 100, includeArchived: "true" });
  const techs = useApi<{ data: { id: string; name: string; roles: string[] }[] }>(can("users.read") ? "/users/lookup/active" : null);
  const set = list.bind;
  const active = list.active;

  return (
    <>
      <PageHeader title={t("common.maintenance")} subtitle={t("maintenanceList.maintenanceRequestsWithinYourPermissions")} actions={can("maintenance.create") && <Button icon="plus" onClick={() => setCreating(true)}>{t("common.newMaintenanceRequest")}</Button>} />
      <Card>
        <div className="space-y-3 border-b border-slate-100 p-4">
          <div className="flex gap-2">
            <Input placeholder={t("maintenanceList.searchPlateNumberMrNumber")} value={list.search} onChange={(e) => list.setSearch(e.target.value)} aria-label={t("common.search")} />
            <Button variant="secondary" onClick={() => setShowFilters((s) => !s)} aria-expanded={showFilters}>
              {t("common.filters", { value: active ? ` (${active})` : "" })}
            </Button>
          </div>
          {showFilters && (
            <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-4">
              {projects.data && (
                <Select value={f.projectId} onChange={set("projectId")} aria-label={t("common.project")}>
                  <option value="">{t("common.allProjects")}</option>
                  {projects.data.data.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}
                </Select>
              )}
              {vehicles.data && (
                <Select value={f.vehicleId} onChange={set("vehicleId")} aria-label={t("common.vehicle")}>
                  <option value="">{t("common.allVehicles")}</option>
                  {vehicles.data.data.map((v) => <option key={v.id} value={v.id}>{v.plateNumber}</option>)}
                </Select>
              )}
              <Select value={f.status} onChange={set("status")} aria-label={t("common.status")}>
                <option value="">{t("common.allStatuses")}</option>
                {Object.entries(MAINTENANCE_STATUS).map(([k, l]) => <option key={k} value={k}>{l.label}</option>)}
              </Select>
              <Select value={f.priority} onChange={set("priority")} aria-label={t("common.priority")}>
                <option value="">{t("maintenanceList.allPriorities")}</option>
                {Object.entries(MAINTENANCE_PRIORITY).map(([k, l]) => <option key={k} value={k}>{l.label}</option>)}
              </Select>
              {techs.data && (
                <Select value={f.technicianId} onChange={set("technicianId")} aria-label={t("common.technician")}>
                  <option value="">{t("maintenanceList.allTechnicians")}</option>
                  {techs.data.data.filter((u) => u.roles.includes("TECHNICAL")).map((u) => <option key={u.id} value={u.id}>{u.name}</option>)}
                </Select>
              )}
              <label className="flex items-center gap-2 text-sm text-slate-500">{t("common.from")} <Input type="date" value={f.from} onChange={set("from")} aria-label={t("common.fromDate")} /></label>
              <label className="flex items-center gap-2 text-sm text-slate-500">{t("common.to")} <Input type="date" value={f.to} onChange={set("to")} aria-label={t("common.toDate")} /></label>
              {active > 0 && <Button variant="ghost" onClick={() => list.clear()}>{t("common.clearFilters")}</Button>}
            </div>
          )}
        </div>
        <ListBody
          loading={loading}
          error={error}
          hasData={!!data}
          cols={7}
          empty={data && !data.data.length ? <EmptyState icon="wrench" title={t("maintenanceList.noMaintenanceRequests")} description={f.q || active ? t("common.tryChangingTheSearchCriteria") : t("maintenanceList.noRequestsWithinYourScope")} /> : null}
        >
          {data && (
          <>
            <DataList
              rows={data.data}
              rowKey={(r) => r.id}
              sort={list.sort}
              onSortChange={list.setSort}
              preview={{ title: (r) => <span className="ltr">{mrNumber(r.number)}</span>, href: (r) => `/maintenance/${r.id}` }}
              columns={[
                {
                  header: t("common.request"),
                  primary: true,
                  sortKey: "number",
                  sortFirst: "desc",
                  cell: (r) => (
                    <span className="flex flex-wrap items-center gap-2">
                      <Link to={`/maintenance/${r.id}`} onClick={(e) => e.stopPropagation()} className="font-semibold text-slate-900 hover:text-brand-700 ltr">{mrNumber(r.number)}</Link>
                      <span className="max-w-64 truncate whitespace-normal text-slate-700">{r.issue}</span>
                    </span>
                  ),
                },
                { header: t("common.vehicle"), cell: (r) => <span className="ltr">{r.plateNumber}</span>, sortKey: "plateNumber" },
                { header: t("common.project"), cell: (r) => r.projectName ?? "—", hideOnMobile: true, sortKey: "projectName" },
                { header: t("common.technician"), cell: (r) => r.technicianName ?? <span className="text-slate-400">{t("common.unassigned")}</span>, sortKey: "technicianName" },
                { header: t("common.priority"), cell: (r) => <StatusBadge map={MAINTENANCE_PRIORITY} value={r.priority} />, sortKey: "priority", sortFirst: "desc" },
                { header: t("common.status"), cell: (r) => <StatusBadge map={MAINTENANCE_STATUS} value={r.status} />, sortKey: "status" },
                ...(data.data.some((r) => r.cost !== null) ? [{ header: t("common.cost"), cell: (r: MaintenanceRow) => formatMoney(r.cost), hideOnMobile: true, sortKey: "cost", sortFirst: "desc" as const }] : []),
                { header: t("common.date"), cell: (r) => formatDate(r.createdAt), hideOnMobile: true, sortKey: "createdAt", sortFirst: "desc" },
              ]}
            />
            <Pagination {...data.meta} onPage={list.setPage} />
          </>
          )}
        </ListBody>
      </Card>
      <CreateMaintenanceModal open={creating} onClose={() => setCreating(false)} onCreated={(id) => navigate(`/maintenance/${id}`)} />
    </>
  );
}
