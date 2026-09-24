import { useState } from "react";
import { Link, useNavigate } from "react-router";
import { Alert, Button, Card, EmptyState, Input, Loading, PageHeader, Pagination, Select, StatusBadge, Table, Td } from "../../components/ui";
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
            <Table head={["المشروع", "الرمز", "مدير التشغيل", "الحالة", "المركبات", "الأعضاء", "الميزانية", "البداية"]}>
              {data.data.map((p) => (
                <tr key={p.id} className="cursor-pointer hover:bg-slate-50" onClick={() => navigate(`/projects/${p.id}`)}>
                  <Td><Link to={`/projects/${p.id}`} className="font-medium text-slate-900 hover:text-brand-700" onClick={(e) => e.stopPropagation()}>{p.name}</Link></Td>
                  <Td><span className="ltr text-slate-500">{p.code}</span></Td>
                  <Td>{p.managerName ?? "—"}</Td>
                  <Td><StatusBadge map={PROJECT_STATUS} value={p.status} /></Td>
                  <Td>{p.vehicleCount}</Td>
                  <Td>{p.memberCount}</Td>
                  <Td>{formatMoney(p.budget)}</Td>
                  <Td>{formatDate(p.startDate)}</Td>
                </tr>
              ))}
            </Table>
            <Pagination {...data.meta} onPage={setPage} />
          </>
        )}
      </Card>
      <ProjectFormModal open={creating} onClose={() => setCreating(false)} sensitive onSaved={(p) => navigate(`/projects/${p.id}`)} />
    </>
  );
}
