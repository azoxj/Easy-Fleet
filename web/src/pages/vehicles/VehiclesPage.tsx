import { useState } from "react";
import { Link, useNavigate } from "react-router";
import { Alert, Button, Card, EmptyState, Input, Loading, PageHeader, Pagination, Select, StatusBadge, Table, Td } from "../../components/ui";
import { useApi } from "../../hooks/useApi";
import type { Paged } from "../../lib/api";
import { useAuth } from "../../lib/auth";
import { formatNumber } from "../../lib/format";
import { VEHICLE_STATUS } from "../../lib/labels";
import type { Project, Vehicle } from "../../lib/types";
import { VehicleFormModal } from "./VehicleFormModal";

export function VehiclesPage() {
  const { can } = useAuth();
  const navigate = useNavigate();
  const [q, setQ] = useState("");
  const [status, setStatus] = useState("");
  const [projectId, setProjectId] = useState("");
  const [page, setPage] = useState(1);
  const [creating, setCreating] = useState(false);
  const { data, loading, error } = useApi<Paged<Vehicle>>("/vehicles", { q, status, projectId, page, pageSize: 20 });
  const projects = useApi<Paged<Project>>(can("projects.read") ? "/projects" : null, { pageSize: 100 });
  const reset = <T,>(fn: (v: T) => void) => (v: T) => { fn(v); setPage(1); };

  return (
    <>
      <PageHeader
        title="المركبات"
        subtitle="المركبات ضمن نطاق صلاحياتك"
        actions={can("vehicles.create") && <Button icon="plus" onClick={() => setCreating(true)}>إضافة مركبة</Button>}
      />
      <Card>
        <div className="grid grid-cols-1 gap-3 border-b border-slate-100 p-4 sm:grid-cols-3 lg:flex">
          <Input placeholder="لوحة، رقم، VIN، شركة أو طراز..." value={q} onChange={(e) => reset(setQ)(e.target.value)} className="lg:max-w-xs" />
          <Select value={status} onChange={(e) => reset(setStatus)(e.target.value)} className="lg:max-w-48">
            <option value="">كل الحالات (عدا المؤرشفة)</option>
            {Object.entries(VEHICLE_STATUS).map(([k, l]) => (
              <option key={k} value={k}>{l.label}</option>
            ))}
          </Select>
          {projects.data && (
            <Select value={projectId} onChange={(e) => reset(setProjectId)(e.target.value)} className="lg:max-w-56">
              <option value="">كل المشاريع</option>
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
          <EmptyState icon="truck" title="لا توجد مركبات" description={q || status || projectId ? "جرّب تغيير معايير البحث" : "لا توجد مركبات ضمن نطاقك حاليًا"} />
        ) : (
          <>
            <Table head={["رقم اللوحة", "المركبة", "سنة الصنع", "المشروع", "العداد", "الحالة"]}>
              {data.data.map((v) => (
                <tr key={v.id} className="cursor-pointer hover:bg-slate-50" onClick={() => navigate(`/vehicles/${v.id}`)}>
                  <Td>
                    <Link to={`/vehicles/${v.id}`} onClick={(e) => e.stopPropagation()} className="font-semibold text-slate-900 hover:text-brand-700 ltr">{v.plateNumber}</Link>
                    {v.vehicleNumber && <span className="ms-2 text-xs text-slate-400">#{v.vehicleNumber}</span>}
                  </Td>
                  <Td>{v.make} {v.model}</Td>
                  <Td>{v.year ?? "—"}</Td>
                  <Td>{v.projectName ?? <span className="text-slate-400">غير مخصصة</span>}</Td>
                  <Td>{formatNumber(v.currentOdometer)} كم</Td>
                  <Td><StatusBadge map={VEHICLE_STATUS} value={v.status} /></Td>
                </tr>
              ))}
            </Table>
            <Pagination {...data.meta} onPage={setPage} />
          </>
        )}
      </Card>
      <VehicleFormModal open={creating} onClose={() => setCreating(false)} onSaved={(v) => navigate(`/vehicles/${v.id}`)} />
    </>
  );
}
