import { useState } from "react";
import { useNavigate } from "react-router";
import { DataList, ListBody } from "../../components/DataList";
import { Badge, Button, Card, EmptyState, Input, PageHeader, Pagination, Select, StatusBadge } from "../../components/ui";
import { useApi } from "../../hooks/useApi";
import { useListState } from "../../hooks/useListState";
import type { Paged } from "../../lib/api";
import { useAuth } from "../../lib/auth";
import { EMPLOYEE_STATUS } from "../../lib/labels";
import type { EmployeeRow, Project } from "../../lib/types";
import { EmployeeFormModal } from "./EmployeeFormModal";
import { t } from "../../i18n";

export function EmployeesPage() {
  const { can } = useAuth();
  const navigate = useNavigate();
  const list = useListState({ q: "", projectId: "", status: "" });
  const { q, projectId, status } = list.f;
  const [creating, setCreating] = useState(false);
  const { data, loading, error } = useApi<Paged<EmployeeRow>>("/employees", list.query);
  const projects = useApi<Paged<Project>>(can("projects.read") ? "/projects" : null, { pageSize: 100 });

  return (
    <>
      <PageHeader title={t("common.employees")} subtitle={t("employees.employeesInYourProjects")} actions={can("employees.create") && can("employees.create", "PROJECT") && <Button icon="plus" onClick={() => setCreating(true)}>{t("common.addEmployee")}</Button>} />
      <Card>
        <div className="grid grid-cols-1 gap-3 border-b border-slate-100 p-4 sm:grid-cols-3">
          <Input placeholder={t("employees.searchByNameNumberOr")} value={list.search} onChange={(e) => list.setSearch(e.target.value)} aria-label={t("common.search")} />
          {projects.data ? (
            <Select value={projectId} onChange={list.bind("projectId")} aria-label={t("common.project")}>
              <option value="">{t("common.allProjects")}</option>
              {projects.data.data.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}
            </Select>
          ) : <span className="hidden sm:block" />}
          <Select value={status} onChange={list.bind("status")} aria-label={t("common.status")}>
            <option value="">{t("employees.allStatusesExceptArchived")}</option>
            {Object.entries(EMPLOYEE_STATUS).map(([k, l]) => <option key={k} value={k}>{l.label}</option>)}
          </Select>
        </div>
        <ListBody loading={loading} error={error} hasData={!!data} cols={6} empty={data && !data.data.length ? <EmptyState icon="id" title={t("employees.noEmployees")} description={q || projectId || status ? t("common.tryChangingTheSearchCriteria") : t("employees.noEmployeesHaveBeenAdded")} /> : null}>
          {data && (
          <>
            <DataList
              rows={data.data}
              rowKey={(e) => e.id}
              sort={list.sort}
              onSortChange={list.setSort}
              preview={{ title: (e) => e.fullName, href: (e) => `/employees/${e.id}` }}
              columns={[
                { header: t("employees.employee"), primary: true, cell: (e) => <span className="font-medium text-slate-900">{e.fullName} {e.driverId && <Badge tone="blue">{t("employees.driver")}</Badge>}</span>, sortKey: "fullName" },
                { header: t("common.employeeNumber"), cell: (e) => <span className="ltr text-slate-500">{e.employeeNumber}</span>, sortKey: "employeeNumber" },
                { header: t("employees.title"), cell: (e) => e.jobTitle ?? "—", sortKey: "jobTitle" },
                { header: t("common.project"), cell: (e) => e.projectName ?? <span className="text-slate-400">{t("employees.none")}</span>, sortKey: "projectName" },
                { header: t("common.mobile"), cell: (e) => (e.phone ? <span className="ltr">{e.phone}</span> : "—"), hideOnMobile: true },
                { header: t("common.status"), cell: (e) => <StatusBadge map={EMPLOYEE_STATUS} value={e.status} />, sortKey: "status" },
              ]}
            />
            <Pagination {...data.meta} onPage={list.setPage} />
          </>
          )}
        </ListBody>
      </Card>
      <EmployeeFormModal open={creating} onClose={() => setCreating(false)} onSaved={(id) => navigate(`/employees/${id}`)} />
    </>
  );
}
