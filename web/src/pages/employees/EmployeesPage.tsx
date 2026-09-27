import { useState } from "react";
import { useNavigate } from "react-router";
import { DataList } from "../../components/DataList";
import { Alert, Badge, Button, Card, EmptyState, Input, Loading, PageHeader, Pagination, Select, StatusBadge } from "../../components/ui";
import { useApi } from "../../hooks/useApi";
import type { Paged } from "../../lib/api";
import { useAuth } from "../../lib/auth";
import { EMPLOYEE_STATUS } from "../../lib/labels";
import type { EmployeeRow, Project } from "../../lib/types";
import { EmployeeFormModal } from "./EmployeeFormModal";
import { t } from "../../i18n";

export function EmployeesPage() {
  const { can } = useAuth();
  const navigate = useNavigate();
  const [q, setQ] = useState("");
  const [projectId, setProjectId] = useState("");
  const [status, setStatus] = useState("");
  const [page, setPage] = useState(1);
  const [creating, setCreating] = useState(false);
  const { data, loading, error } = useApi<Paged<EmployeeRow>>("/employees", { q, projectId, status, page, pageSize: 20 });
  const projects = useApi<Paged<Project>>(can("projects.read") ? "/projects" : null, { pageSize: 100 });
  const reset = (fn: (v: string) => void) => (e: { target: { value: string } }) => { fn(e.target.value); setPage(1); };

  return (
    <>
      <PageHeader title={t("common.employees")} subtitle={t("employees.employeesInYourProjects")} actions={can("employees.create") && can("employees.create", "PROJECT") && <Button icon="plus" onClick={() => setCreating(true)}>{t("common.addEmployee")}</Button>} />
      <Card>
        <div className="grid grid-cols-1 gap-3 border-b border-slate-100 p-4 sm:grid-cols-3">
          <Input placeholder={t("employees.searchByNameNumberOr")} value={q} onChange={reset(setQ)} aria-label={t("common.search")} />
          {projects.data ? (
            <Select value={projectId} onChange={reset(setProjectId)} aria-label={t("common.project")}>
              <option value="">{t("common.allProjects")}</option>
              {projects.data.data.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}
            </Select>
          ) : <span className="hidden sm:block" />}
          <Select value={status} onChange={reset(setStatus)} aria-label={t("common.status")}>
            <option value="">{t("employees.allStatusesExceptArchived")}</option>
            {Object.entries(EMPLOYEE_STATUS).map(([k, l]) => <option key={k} value={k}>{l.label}</option>)}
          </Select>
        </div>
        {loading ? <Loading /> : error ? <div className="p-4"><Alert>{error.message}</Alert></div> : !data?.data.length ? (
          <EmptyState icon="id" title={t("employees.noEmployees")} description={q || projectId || status ? t("common.tryChangingTheSearchCriteria") : t("employees.noEmployeesHaveBeenAdded")} />
        ) : (
          <>
            <DataList
              rows={data.data}
              rowKey={(e) => e.id}
              onRowClick={(e) => navigate(`/employees/${e.id}`)}
              columns={[
                { header: t("employees.employee"), primary: true, cell: (e) => <span className="font-medium text-slate-900">{e.fullName} {e.driverId && <Badge tone="blue">{t("employees.driver")}</Badge>}</span> },
                { header: t("common.employeeNumber"), cell: (e) => <span className="ltr text-slate-500">{e.employeeNumber}</span> },
                { header: t("employees.title"), cell: (e) => e.jobTitle ?? "—" },
                { header: t("common.project"), cell: (e) => e.projectName ?? <span className="text-slate-400">{t("employees.none")}</span> },
                { header: t("common.mobile"), cell: (e) => (e.phone ? <span className="ltr">{e.phone}</span> : "—"), hideOnMobile: true },
                { header: t("common.status"), cell: (e) => <StatusBadge map={EMPLOYEE_STATUS} value={e.status} /> },
              ]}
            />
            <Pagination {...data.meta} onPage={setPage} />
          </>
        )}
      </Card>
      <EmployeeFormModal open={creating} onClose={() => setCreating(false)} onSaved={(id) => navigate(`/employees/${id}`)} />
    </>
  );
}
