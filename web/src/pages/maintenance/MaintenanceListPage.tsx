import { useState } from "react";
import { Link, useNavigate, useSearchParams } from "react-router";
import { DataList } from "../../components/DataList";
import { Alert, Button, Card, EmptyState, Input, Loading, PageHeader, Pagination, Select, StatusBadge } from "../../components/ui";
import { useApi } from "../../hooks/useApi";
import type { Paged } from "../../lib/api";
import { useAuth } from "../../lib/auth";
import { formatDate, formatMoney } from "../../lib/format";
import { MAINTENANCE_PRIORITY, MAINTENANCE_STATUS, mrNumber } from "../../lib/maintenance";
import type { MaintenanceRow, Project, Vehicle } from "../../lib/types";
import { CreateMaintenanceModal } from "./CreateMaintenanceModal";

export function MaintenanceListPage() {
  const { can } = useAuth();
  const navigate = useNavigate();
  const [params] = useSearchParams();
  const [f, setF] = useState({ q: "", projectId: "", vehicleId: params.get("vehicleId") ?? "", status: params.get("status") ?? "", priority: "", technicianId: "", from: params.get("from") ?? "", to: params.get("to") ?? "" });
  const [page, setPage] = useState(1);
  const [creating, setCreating] = useState(false);
  const [showFilters, setShowFilters] = useState(false);
  const { data, loading, error } = useApi<Paged<MaintenanceRow>>("/maintenance", { ...f, page, pageSize: 20 });
  const projects = useApi<Paged<Project>>(can("projects.read") ? "/projects" : null, { pageSize: 100 });
  const vehicles = useApi<Paged<Vehicle>>(can("vehicles.read") ? "/vehicles" : null, { pageSize: 100, includeArchived: "true" });
  const techs = useApi<{ data: { id: string; name: string; roles: string[] }[] }>(can("users.read") ? "/users/lookup/active" : null);
  const set = (k: keyof typeof f) => (e: { target: { value: string } }) => { setF((s) => ({ ...s, [k]: e.target.value })); setPage(1); };
  const active = Object.entries(f).filter(([k, v]) => k !== "q" && v).length;

  return (
    <>
      <PageHeader title="الصيانة" subtitle="طلبات الصيانة ضمن نطاق صلاحياتك" actions={can("maintenance.create") && <Button icon="plus" onClick={() => setCreating(true)}>طلب صيانة جديد</Button>} />
      <Card>
        <div className="space-y-3 border-b border-slate-100 p-4">
          <div className="flex gap-2">
            <Input placeholder="بحث: رقم اللوحة، MR-رقم، العطل، الفني..." value={f.q} onChange={set("q")} aria-label="بحث" />
            <Button variant="secondary" onClick={() => setShowFilters((s) => !s)} aria-expanded={showFilters}>
              الفلاتر{active ? ` (${active})` : ""}
            </Button>
          </div>
          {showFilters && (
            <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-4">
              {projects.data && (
                <Select value={f.projectId} onChange={set("projectId")} aria-label="المشروع">
                  <option value="">كل المشاريع</option>
                  {projects.data.data.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}
                </Select>
              )}
              {vehicles.data && (
                <Select value={f.vehicleId} onChange={set("vehicleId")} aria-label="المركبة">
                  <option value="">كل المركبات</option>
                  {vehicles.data.data.map((v) => <option key={v.id} value={v.id}>{v.plateNumber}</option>)}
                </Select>
              )}
              <Select value={f.status} onChange={set("status")} aria-label="الحالة">
                <option value="">كل الحالات</option>
                {Object.entries(MAINTENANCE_STATUS).map(([k, l]) => <option key={k} value={k}>{l.label}</option>)}
              </Select>
              <Select value={f.priority} onChange={set("priority")} aria-label="الأولوية">
                <option value="">كل الأولويات</option>
                {Object.entries(MAINTENANCE_PRIORITY).map(([k, l]) => <option key={k} value={k}>{l.label}</option>)}
              </Select>
              {techs.data && (
                <Select value={f.technicianId} onChange={set("technicianId")} aria-label="الفني">
                  <option value="">كل الفنيين</option>
                  {techs.data.data.filter((u) => u.roles.includes("TECHNICAL")).map((u) => <option key={u.id} value={u.id}>{u.name}</option>)}
                </Select>
              )}
              <label className="flex items-center gap-2 text-sm text-slate-500">من <Input type="date" value={f.from} onChange={set("from")} aria-label="من تاريخ" /></label>
              <label className="flex items-center gap-2 text-sm text-slate-500">إلى <Input type="date" value={f.to} onChange={set("to")} aria-label="إلى تاريخ" /></label>
              {active > 0 && <Button variant="ghost" onClick={() => { setF({ ...f, projectId: "", vehicleId: "", status: "", priority: "", technicianId: "", from: "", to: "" }); setPage(1); }}>مسح الفلاتر</Button>}
            </div>
          )}
        </div>
        {loading ? <Loading /> : error ? <div className="p-4"><Alert>{error.message}</Alert></div> : !data?.data.length ? (
          <EmptyState icon="wrench" title="لا توجد طلبات صيانة" description={f.q || active ? "جرّب تغيير معايير البحث" : "لا توجد طلبات ضمن نطاقك حاليًا"} />
        ) : (
          <>
            <DataList
              rows={data.data}
              rowKey={(r) => r.id}
              onRowClick={(r) => navigate(`/maintenance/${r.id}`)}
              columns={[
                {
                  header: "الطلب",
                  primary: true,
                  cell: (r) => (
                    <span className="flex flex-wrap items-center gap-2">
                      <Link to={`/maintenance/${r.id}`} onClick={(e) => e.stopPropagation()} className="font-semibold text-slate-900 hover:text-brand-700 ltr">{mrNumber(r.number)}</Link>
                      <span className="max-w-64 truncate whitespace-normal text-slate-700">{r.issue}</span>
                    </span>
                  ),
                },
                { header: "المركبة", cell: (r) => <span className="ltr">{r.plateNumber}</span> },
                { header: "المشروع", cell: (r) => r.projectName ?? "—", hideOnMobile: true },
                { header: "الفني", cell: (r) => r.technicianName ?? <span className="text-slate-400">غير مسند</span> },
                { header: "الأولوية", cell: (r) => <StatusBadge map={MAINTENANCE_PRIORITY} value={r.priority} /> },
                { header: "الحالة", cell: (r) => <StatusBadge map={MAINTENANCE_STATUS} value={r.status} /> },
                ...(data.data.some((r) => r.cost !== null) ? [{ header: "التكلفة", cell: (r: MaintenanceRow) => formatMoney(r.cost), hideOnMobile: true }] : []),
                { header: "التاريخ", cell: (r) => formatDate(r.createdAt), hideOnMobile: true },
              ]}
            />
            <Pagination {...data.meta} onPage={setPage} />
          </>
        )}
      </Card>
      <CreateMaintenanceModal open={creating} onClose={() => setCreating(false)} onCreated={(id) => navigate(`/maintenance/${id}`)} />
    </>
  );
}
