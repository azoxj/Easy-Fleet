import { useState } from "react";
import { Link, useParams } from "react-router";
import { Icon } from "../../components/icons";
import { Alert, Button, Card, CardHeader, DescList, EmptyState, Field, Loading, Modal, PageHeader, Select, StatCard, StatusBadge, Table, Td } from "../../components/ui";
import { useApi } from "../../hooks/useApi";
import { api, type Paged } from "../../lib/api";
import { useAuth } from "../../lib/auth";
import { formatDate, formatMoney, formatNumber } from "../../lib/format";
import { errorMessage } from "../../lib/forms";
import { PROJECT_STATUS, VEHICLE_STATUS } from "../../lib/labels";
import type { ProjectDetail, Vehicle } from "../../lib/types";
import { ProjectFormModal } from "./ProjectFormModal";

type Member = { id: string; name: string; email: string; status: string; isManager: boolean; addedAt: string };

function AddMemberModal({ open, onClose, projectId, existing, onAdded }: { open: boolean; onClose: () => void; projectId: string; existing: string[]; onAdded: () => void }) {
  const { data } = useApi<{ data: { id: string; name: string; email: string }[] }>(open ? "/users/lookup/active" : null);
  const [userId, setUserId] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const options = (data?.data ?? []).filter((u) => !existing.includes(u.id));

  const add = async () => {
    setBusy(true);
    setError(null);
    try {
      await api(`/projects/${projectId}/members`, { method: "POST", body: { userId } });
      setUserId("");
      onAdded();
      onClose();
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setBusy(false);
    }
  };
  return (
    <Modal open={open} onClose={onClose} title="إضافة عضو للمشروع" footer={<><Button variant="secondary" onClick={onClose}>إلغاء</Button><Button onClick={add} loading={busy} disabled={!userId}>إضافة</Button></>}>
      <div className="space-y-4">
        {error && <Alert>{error}</Alert>}
        <Alert tone="blue">العضوية تمنح المستخدم نطاق هذا المشروع فقط، وفق صلاحيات دوره.</Alert>
        <Field label="المستخدم" htmlFor="m-user">
          <Select id="m-user" value={userId} onChange={(e) => setUserId(e.target.value)}>
            <option value="">اختر مستخدمًا...</option>
            {options.map((u) => (
              <option key={u.id} value={u.id}>{u.name} — {u.email}</option>
            ))}
          </Select>
        </Field>
      </div>
    </Modal>
  );
}

export function ProjectDetailPage() {
  const { id = "" } = useParams();
  const { can } = useAuth();
  const project = useApi<{ data: ProjectDetail }>(`/projects/${id}`);
  const members = useApi<{ data: Member[] }>(`/projects/${id}/members`);
  const vehicles = useApi<Paged<Vehicle>>(can("vehicles.read") ? "/vehicles" : null, { projectId: id, pageSize: 50 });
  const [editing, setEditing] = useState(false);
  const [adding, setAdding] = useState(false);
  const [actionError, setActionError] = useState<string | null>(null);

  if (project.loading) return <Loading />;
  if (project.error || !project.data) return <EmptyState icon="folder" title={project.error?.status === 404 ? "المشروع غير موجود" : "تعذر تحميل المشروع"} description={project.error?.message} action={<Link to="/projects" className="text-sm text-brand-700">العودة للمشاريع</Link>} />;
  const p = project.data.data;

  const removeMember = async (userId: string) => {
    if (!window.confirm("هل تريد إزالة هذا العضو من المشروع؟")) return;
    setActionError(null);
    try {
      await api(`/projects/${id}/members/${userId}`, { method: "DELETE" });
      members.reload();
      project.reload();
    } catch (err) {
      setActionError(errorMessage(err));
    }
  };

  return (
    <>
      <PageHeader
        back={<Link to="/projects" className="mb-2 inline-flex items-center gap-1 text-sm text-slate-500 hover:text-slate-700"><Icon name="chevron" className="size-4" /> المشاريع</Link>}
        title={<span className="flex flex-wrap items-center gap-3">{p.name} <StatusBadge map={PROJECT_STATUS} value={p.status} /></span>}
        subtitle={<span className="ltr">{p.code}</span>}
        actions={p.capabilities.update && <Button variant="secondary" icon="edit" onClick={() => setEditing(true)}>تعديل</Button>}
      />
      {actionError && <div className="mb-4"><Alert>{actionError}</Alert></div>}

      <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 xl:grid-cols-4">
        <StatCard label="المركبات" value={formatNumber(p.vehicleCount)} icon="truck" />
        <StatCard label="الأعضاء" value={formatNumber(p.memberCount)} icon="users" tone="violet" />
        <StatCard label="الميزانية" value={<span className="text-lg">{formatMoney(p.budget)}</span>} icon="receipt" tone="green" />
        <StatCard label="المالية التفصيلية" value={<span className="text-base font-medium text-slate-400">قريبًا</span>} icon="receipt" tone="gray" hint="الفواتير والمصروفات والمتبقي" />
      </div>

      <div className="mt-6 grid grid-cols-1 gap-6 xl:grid-cols-3">
        <Card className="xl:col-span-2">
          <CardHeader title="بيانات المشروع" />
          <div className="p-5">
            <DescList
              items={[
                { label: "مدير التشغيل", value: p.managerName ?? "—" },
                { label: "تاريخ البداية", value: formatDate(p.startDate) },
                { label: "تاريخ النهاية", value: formatDate(p.endDate) },
                { label: "تاريخ الإنشاء", value: formatDate(p.createdAt) },
              ]}
            />
            {p.description && <p className="mt-5 text-sm leading-7 whitespace-pre-line text-slate-600">{p.description}</p>}
          </div>
        </Card>

        <Card>
          <CardHeader title="الأعضاء" action={p.capabilities.manageMembers && <Button variant="secondary" icon="plus" onClick={() => setAdding(true)}>إضافة</Button>} />
          {members.loading ? (
            <Loading />
          ) : !members.data?.data.length ? (
            <EmptyState icon="users" title="لا يوجد أعضاء" />
          ) : (
            <ul className="divide-y divide-slate-100">
              {members.data.data.map((m) => (
                <li key={m.id} className="flex items-center justify-between gap-3 px-5 py-3">
                  <div className="min-w-0">
                    <p className="flex items-center gap-2 truncate text-sm font-medium text-slate-800">
                      {m.name} {m.isManager && <span className="rounded bg-brand-50 px-1.5 py-0.5 text-[11px] text-brand-700">مدير</span>}
                    </p>
                    <p className="truncate text-xs text-slate-500 ltr">{m.email}</p>
                  </div>
                  {p.capabilities.manageMembers && !m.isManager && (
                    <button onClick={() => void removeMember(m.id)} className="rounded p-1 text-slate-400 hover:bg-red-50 hover:text-red-600" aria-label={`إزالة ${m.name}`}>
                      <Icon name="x" className="size-4" />
                    </button>
                  )}
                </li>
              ))}
            </ul>
          )}
        </Card>
      </div>

      {vehicles.data && (
        <Card className="mt-6">
          <CardHeader title="مركبات المشروع" subtitle={`${vehicles.data.meta.total} مركبة`} />
          {vehicles.data.data.length === 0 ? (
            <EmptyState icon="truck" title="لا توجد مركبات في هذا المشروع" />
          ) : (
            <Table head={["رقم اللوحة", "المركبة", "العداد", "الحالة"]}>
              {vehicles.data.data.map((v) => (
                <tr key={v.id} className="hover:bg-slate-50">
                  <Td><Link to={`/vehicles/${v.id}`} className="font-medium text-brand-700 hover:underline ltr">{v.plateNumber}</Link></Td>
                  <Td>{v.make} {v.model} {v.year ?? ""}</Td>
                  <Td>{formatNumber(v.currentOdometer)} كم</Td>
                  <Td><StatusBadge map={VEHICLE_STATUS} value={v.status} /></Td>
                </tr>
              ))}
            </Table>
          )}
        </Card>
      )}

      <ProjectFormModal open={editing} onClose={() => setEditing(false)} project={p} sensitive={p.capabilities.updateSensitive} onSaved={() => project.reload()} />
      <AddMemberModal open={adding} onClose={() => setAdding(false)} projectId={id} existing={members.data?.data.map((m) => m.id) ?? []} onAdded={() => { members.reload(); project.reload(); }} />
    </>
  );
}
