import { useState } from "react";
import { Link, useNavigate } from "react-router";
import { DataList } from "../../components/DataList";
import { Alert, Button, Card, EmptyState, Input, Loading, PageHeader, Pagination, Select, StatusBadge } from "../../components/ui";
import { useApi } from "../../hooks/useApi";
import type { Paged } from "../../lib/api";
import { useAuth } from "../../lib/auth";
import { formatDate, formatMoney } from "../../lib/format";
import { PROJECT_STATUS } from "../../lib/labels";
import type { Project } from "../../lib/types";
import { ProjectFormModal } from "./ProjectFormModal";

export function ProjectsPage() {
  const { can } = useAuth();
  const navigate = useNavigate();
  const [q, setQ] = useState("");
  const [status, setStatus] = useState("");
  const [page, setPage] = useState(1);
  const [creating, setCreating] = useState(false);
  const { data, loading, error } = useApi<Paged<Project>>("/projects", { q, status, page, pageSize: 20 });

  return (
    <>
      <PageHeader
        title="المشاريع"
        subtitle="المشاريع التي تملك صلاحية الوصول إليها"
        actions={can("projects.create", "ALL") && <Button icon="plus" onClick={() => setCreating(true)}>مشروع جديد</Button>}
      />
      <Card>
        <div className="flex flex-col gap-3 border-b border-slate-100 p-4 sm:flex-row">
          <Input placeholder="بحث بالاسم أو الرمز..." value={q} onChange={(e) => { setQ(e.target.value); setPage(1); }} className="sm:max-w-xs" />
          <Select value={status} onChange={(e) => { setStatus(e.target.value); setPage(1); }} className="sm:max-w-48">
            <option value="">كل الحالات</option>
            {Object.entries(PROJECT_STATUS).map(([k, l]) => (
              <option key={k} value={k}>{l.label}</option>
            ))}
          </Select>
        </div>
        {loading ? (
          <Loading />
        ) : error ? (
          <div className="p-4"><Alert>{error.message}</Alert></div>
        ) : !data || data.data.length === 0 ? (
          <EmptyState icon="folder" title="لا توجد مشاريع" description={q || status ? "جرّب تغيير معايير البحث" : "لم يتم إسناد أي مشروع إليك بعد"} />
        ) : (
          <>
            <DataList
              rows={data.data}
              rowKey={(p) => p.id}
              onRowClick={(p) => navigate(`/projects/${p.id}`)}
              columns={[
                { header: "المشروع", primary: true, cell: (p) => <Link to={`/projects/${p.id}`} className="font-medium text-slate-900 hover:text-brand-700" onClick={(e) => e.stopPropagation()}>{p.name}</Link> },
                { header: "الرمز", cell: (p) => <span className="ltr text-slate-500">{p.code}</span> },
                { header: "مدير التشغيل", cell: (p) => p.managerName ?? "—" },
                { header: "الحالة", cell: (p) => <StatusBadge map={PROJECT_STATUS} value={p.status} /> },
                { header: "المركبات", cell: (p) => p.vehicleCount },
                { header: "الأعضاء", cell: (p) => p.memberCount, hideOnMobile: true },
                { header: "الميزانية", cell: (p) => formatMoney(p.budget), hideOnMobile: true },
                { header: "البداية", cell: (p) => formatDate(p.startDate), hideOnMobile: true },
              ]}
            />
            <Pagination {...data.meta} onPage={setPage} />
          </>
        )}
      </Card>
      <ProjectFormModal open={creating} onClose={() => setCreating(false)} sensitive onSaved={(p) => navigate(`/projects/${p.id}`)} />
    </>
  );
}
