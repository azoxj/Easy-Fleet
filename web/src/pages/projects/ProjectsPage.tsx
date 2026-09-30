import { useState } from "react";
import { Link, useNavigate } from "react-router";
import { DataList, ListBody } from "../../components/DataList";
import { Button, Card, EmptyState, Input, PageHeader, Pagination, Select, StatusBadge } from "../../components/ui";
import { useApi } from "../../hooks/useApi";
import { useListState } from "../../hooks/useListState";
import type { Paged } from "../../lib/api";
import { useAuth } from "../../lib/auth";
import { formatDate, formatMoney } from "../../lib/format";
import { PROJECT_STATUS } from "../../lib/labels";
import type { Project } from "../../lib/types";
import { ProjectFormModal } from "./ProjectFormModal";
import { t } from "../../i18n";

export function ProjectsPage() {
  const { can } = useAuth();
  const navigate = useNavigate();
  const list = useListState({ q: "", status: "" });
  const { q, status } = list.f;
  const [creating, setCreating] = useState(false);
  const { data, loading, error } = useApi<Paged<Project>>("/projects", list.query);

  return (
    <>
      <PageHeader
        title={t("common.projects")}
        subtitle={t("projects.projectsYouHaveAccessTo")}
        actions={can("projects.create", "ALL") && <Button icon="plus" onClick={() => setCreating(true)}>{t("common.newProject")}</Button>}
      />
      <Card>
        <div className="flex flex-col gap-3 border-b border-slate-100 p-4 sm:flex-row">
          <Input placeholder={t("projects.searchByNameOrCode")} value={list.search} onChange={(e) => list.setSearch(e.target.value)} aria-label={t("common.search")} className="sm:max-w-xs" />
          <Select value={status} onChange={list.bind("status")} aria-label={t("common.status")} className="sm:max-w-48">
            <option value="">{t("common.allStatuses")}</option>
            {Object.entries(PROJECT_STATUS).map(([k, l]) => (
              <option key={k} value={k}>{l.label}</option>
            ))}
          </Select>
        </div>
        <ListBody loading={loading} error={error} hasData={!!data} cols={8} empty={data && !data.data.length ? <EmptyState icon="folder" title={t("projects.noProjects")} description={q || status ? t("common.tryChangingTheSearchCriteria") : t("projects.noProjectHasBeenAssigned")} /> : null}>
          {data && (
          <>
            <DataList
              rows={data.data}
              rowKey={(p) => p.id}
              sort={list.sort}
              onSortChange={list.setSort}
              preview={{ title: (p) => p.name, href: (p) => `/projects/${p.id}` }}
              columns={[
                { header: t("common.project"), primary: true, cell: (p) => <Link to={`/projects/${p.id}`} className="font-medium text-slate-900 hover:text-brand-700" onClick={(e) => e.stopPropagation()}>{p.name}</Link>, sortKey: "name" },
                { header: t("projects.code"), cell: (p) => <span className="ltr text-slate-500">{p.code}</span>, sortKey: "code" },
                { header: t("common.operationsManager"), cell: (p) => p.managerName ?? "—", sortKey: "managerName" },
                { header: t("common.status"), cell: (p) => <StatusBadge map={PROJECT_STATUS} value={p.status} />, sortKey: "status" },
                { header: t("common.vehicles"), cell: (p) => p.vehicleCount, sortKey: "vehicleCount", sortFirst: "desc" },
                { header: t("common.members"), cell: (p) => p.memberCount, hideOnMobile: true, sortKey: "memberCount", sortFirst: "desc" },
                { header: t("common.budget"), cell: (p) => formatMoney(p.budget), hideOnMobile: true, sortKey: "budget", sortFirst: "desc" },
                { header: t("common.start"), cell: (p) => formatDate(p.startDate), hideOnMobile: true, sortKey: "startDate", sortFirst: "desc" },
              ]}
            />
            <Pagination {...data.meta} onPage={list.setPage} />
          </>
          )}
        </ListBody>
      </Card>
      <ProjectFormModal open={creating} onClose={() => setCreating(false)} sensitive onSaved={(p) => navigate(`/projects/${p.id}`)} />
    </>
  );
}
