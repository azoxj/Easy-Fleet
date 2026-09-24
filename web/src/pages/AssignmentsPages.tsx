import { useEffect, useState } from "react";
import { Link } from "react-router";
import { Alert, Badge, Button, Card, EmptyState, Field, Input, Loading, Modal, PageHeader, Pagination, Select, StatusBadge, Table, Td, Textarea } from "../components/ui";
import { useApi } from "../hooks/useApi";
import { api, type Paged } from "../lib/api";
import { useAuth } from "../lib/auth";
import { formatDate } from "../lib/format";
import { clean, errorMessage, fieldErrors } from "../lib/forms";
import { ASSIGNMENT_STATUS, ASSIGNMENT_TYPE, PRIORITY } from "../lib/labels";
import type { Assignment, Project, Vehicle } from "../lib/types";

function Reference({ a }: { a: Assignment }) {
  if (a.vehicleId && a.vehiclePlate) return <Link to={`/vehicles/${a.vehicleId}`} className="text-brand-700 hover:underline ltr">{a.vehiclePlate}</Link>;
  if (a.projectId && a.projectName) return <Link to={`/projects/${a.projectId}`} className="text-brand-700 hover:underline">{a.projectName}</Link>;
  return <span className="text-slate-400">—</span>;
}

function StatusFilter({ value, onChange }: { value: string; onChange: (v: string) => void }) {
  return (
    <Select value={value} onChange={(e) => onChange(e.target.value)} className="sm:max-w-48">
      <option value="">كل الحالات</option>
      {Object.entries(ASSIGNMENT_STATUS).map(([k, l]) => <option key={k} value={k}>{l.label}</option>)}
    </Select>
  );
}

export function MyAssignmentsPage() {
  const [status, setStatus] = useState("");
  const [page, setPage] = useState(1);
  const [error, setError] = useState<string | null>(null);
  const { data, loading, error: loadError, reload } = useApi<Paged<Assignment> & { summary: Record<string, number> }>("/assignments/mine", { status, page, pageSize: 20 });

  const move = async (a: Assignment, next: string) => {
    setError(null);
    try {
      await api(`/assignments/${a.id}/status`, { method: "PATCH", body: { status: next } });
      reload();
    } catch (err) {
      setError(errorMessage(err));
    }
  };

  return (
    <>
      <PageHeader title="إسناداتي" subtitle="كل ما تم إسناده إليك من مشاريع ومركبات ومهام" />
      {data && (
        <div className="mb-4 flex flex-wrap gap-2">
          {Object.entries(ASSIGNMENT_STATUS).map(([k, l]) => (
            <button key={k} onClick={() => { setStatus(status === k ? "" : k); setPage(1); }} className={`rounded-full border px-3 py-1 text-sm transition ${status === k ? "border-brand-600 bg-brand-50 text-brand-800" : "border-slate-200 bg-white text-slate-600 hover:border-slate-300"}`}>
              {l.label} <span className="font-semibold">{data.summary[k] ?? 0}</span>
            </button>
          ))}
        </div>
      )}
      {error && <div className="mb-4"><Alert>{error}</Alert></div>}
      <Card>
        {loading ? <Loading /> : loadError ? <div className="p-4"><Alert>{loadError.message}</Alert></div> : !data?.data.length ? (
          <EmptyState icon="inbox" title="لا توجد إسنادات" description="عندما يُسند إليك مشروع أو مركبة أو مهمة ستظهر هنا." />
        ) : (
          <>
            <ul className="divide-y divide-slate-100">
              {data.data.map((a) => (
                <li key={a.id} className="flex flex-col gap-3 px-5 py-4 sm:flex-row sm:items-center sm:justify-between">
                  <div className="min-w-0">
                    <div className="flex flex-wrap items-center gap-2">
                      <Badge tone="slate">{ASSIGNMENT_TYPE[a.type] ?? a.type}</Badge>
                      <p className="font-medium text-slate-900">{a.title}</p>
                      <StatusBadge map={PRIORITY} value={a.priority} />
                    </div>
                    {a.description && <p className="mt-1 text-sm text-slate-600">{a.description}</p>}
                    <p className="mt-1.5 flex flex-wrap gap-x-4 gap-y-1 text-xs text-slate-500">
                      <span>المرجع: <Reference a={a} /></span>
                      <span>من: {a.assignedByName}</span>
                      {a.dueDate && <span>الاستحقاق: {formatDate(a.dueDate)}</span>}
                    </p>
                  </div>
                  <div className="flex shrink-0 items-center gap-2">
                    <StatusBadge map={ASSIGNMENT_STATUS} value={a.status} />
                    {a.status === "PENDING" && <Button variant="secondary" onClick={() => void move(a, "IN_PROGRESS")}>بدء التنفيذ</Button>}
                    {(a.status === "PENDING" || a.status === "IN_PROGRESS") && <Button onClick={() => void move(a, "COMPLETED")} icon="check">إنجاز</Button>}
                  </div>
                </li>
              ))}
            </ul>
            <Pagination {...data.meta} onPage={setPage} />
          </>
        )}
      </Card>
    </>
  );
}

function NewAssignmentModal({ open, onClose, onSaved }: { open: boolean; onClose: () => void; onSaved: () => void }) {
  const [type, setType] = useState("TASK");
  const [projectId, setProjectId] = useState("");
  const [vehicleId, setVehicleId] = useState("");
  const [assignedTo, setAssignedTo] = useState("");
  const [title, setTitle] = useState("");
  const [description, setDescription] = useState("");
  const [priority, setPriority] = useState("MEDIUM");
  const [dueDate, setDueDate] = useState("");
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const projects = useApi<Paged<Project>>(open ? "/projects" : null, { pageSize: 100 });
  const vehicles = useApi<Paged<Vehicle>>(open && type === "VEHICLE" ? "/vehicles" : null, { pageSize: 100 });
  // For project-bound types, only members of the chosen project are eligible assignees.
  const users = useApi<{ data: { id: string; name: string }[] }>(open ? "/users/lookup/active" : null, type === "VEHICLE" ? {} : { projectId: projectId || undefined });

  useEffect(() => {
    if (open) {
      setType("TASK"); setProjectId(""); setVehicleId(""); setAssignedTo(""); setTitle(""); setDescription(""); setPriority("MEDIUM"); setDueDate(""); setErrors({}); setError(null);
    }
  }, [open]);

  const save = async () => {
    setBusy(true);
    setError(null);
    try {
      const base = clean({ title, description, dueDate });
      const body: Record<string, unknown> = { type, assignedTo, priority, ...base };
      if (type === "TASK") body.projectId = projectId;
      if (type === "PROJECT") body.referenceId = projectId;
      if (type === "VEHICLE") body.referenceId = vehicleId;
      await api("/assignments", { method: "POST", body });
      onSaved();
      onClose();
    } catch (err) {
      setErrors(fieldErrors(err));
      setError(errorMessage(err));
    } finally {
      setBusy(false);
    }
  };

  const ready = assignedTo && title && (type === "VEHICLE" ? vehicleId : projectId);
  return (
    <Modal open={open} onClose={onClose} size="lg" title="إسناد جديد" footer={<><Button variant="secondary" onClick={onClose}>إلغاء</Button><Button onClick={save} loading={busy} disabled={!ready}>إسناد</Button></>}>
      <div className="space-y-4">
        {error && <Alert>{error}</Alert>}
        <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
          <Field label="نوع الإسناد" htmlFor="a-type">
            <Select id="a-type" value={type} onChange={(e) => { setType(e.target.value); setAssignedTo(""); }}>
              <option value="TASK">مهمة</option>
              <option value="PROJECT">مشروع</option>
              <option value="VEHICLE">مركبة</option>
            </Select>
          </Field>
          {type === "VEHICLE" ? (
            <Field label="المركبة" required htmlFor="a-vehicle">
              <Select id="a-vehicle" value={vehicleId} onChange={(e) => setVehicleId(e.target.value)}>
                <option value="">اختر مركبة...</option>
                {vehicles.data?.data.map((v) => <option key={v.id} value={v.id}>{v.plateNumber} — {v.make} {v.model}</option>)}
              </Select>
            </Field>
          ) : (
            <Field label="المشروع" required htmlFor="a-project">
              <Select id="a-project" value={projectId} onChange={(e) => { setProjectId(e.target.value); setAssignedTo(""); }}>
                <option value="">اختر مشروعًا...</option>
                {projects.data?.data.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}
              </Select>
            </Field>
          )}
          <Field label="المسند إليه" required error={errors.assignedTo} htmlFor="a-user" hint={type !== "VEHICLE" ? "أعضاء المشروع فقط" : undefined}>
            <Select id="a-user" value={assignedTo} onChange={(e) => setAssignedTo(e.target.value)} disabled={type !== "VEHICLE" && !projectId}>
              <option value="">اختر مستخدمًا...</option>
              {users.data?.data.map((u) => <option key={u.id} value={u.id}>{u.name}</option>)}
            </Select>
          </Field>
          <Field label="الأولوية" htmlFor="a-priority">
            <Select id="a-priority" value={priority} onChange={(e) => setPriority(e.target.value)}>
              {Object.entries(PRIORITY).map(([k, l]) => <option key={k} value={k}>{l.label}</option>)}
            </Select>
          </Field>
          <Field label="العنوان" required error={errors.title} htmlFor="a-title"><Input id="a-title" value={title} onChange={(e) => setTitle(e.target.value)} /></Field>
          <Field label="تاريخ الاستحقاق" error={errors.dueDate} htmlFor="a-due"><Input id="a-due" type="date" value={dueDate} onChange={(e) => setDueDate(e.target.value)} /></Field>
        </div>
        <Field label="الوصف" error={errors.description} htmlFor="a-desc"><Textarea id="a-desc" value={description} onChange={(e) => setDescription(e.target.value)} /></Field>
        <Alert tone="blue">الإسناد لا يمنح المستخدم صلاحيات إضافية؛ يرى المرجع فقط إذا كان دوره يسمح بذلك.</Alert>
      </div>
    </Modal>
  );
}

export function AssignmentsPage() {
  const { can, me } = useAuth();
  const [status, setStatus] = useState("");
  const [page, setPage] = useState(1);
  const [creating, setCreating] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const { data, loading, error: loadError, reload } = useApi<Paged<Assignment>>("/assignments", { status, page, pageSize: 20 });

  const cancel = async (a: Assignment) => {
    if (!window.confirm(`إلغاء الإسناد "${a.title}"؟`)) return;
    setError(null);
    try {
      await api(`/assignments/${a.id}/status`, { method: "PATCH", body: { status: "CANCELLED" } });
      reload();
    } catch (err) {
      setError(errorMessage(err));
    }
  };
  const canCancel = (a: Assignment) =>
    (a.status === "PENDING" || a.status === "IN_PROGRESS") &&
    (a.assignedBy === me?.id || can("assignments.manage", "ALL") || (can("assignments.manage", "PROJECT") && !!a.projectId && !!me?.projectIds.includes(a.projectId)));

  return (
    <>
      <PageHeader title="متابعة الإسنادات" subtitle="الإسنادات ضمن نطاقك" actions={can("assignments.create") && <Button icon="plus" onClick={() => setCreating(true)}>إسناد جديد</Button>} />
      {error && <div className="mb-4"><Alert>{error}</Alert></div>}
      <Card>
        <div className="border-b border-slate-100 p-4"><StatusFilter value={status} onChange={(v) => { setStatus(v); setPage(1); }} /></div>
        {loading ? <Loading /> : loadError ? <div className="p-4"><Alert>{loadError.message}</Alert></div> : !data?.data.length ? <EmptyState icon="clipboard" title="لا توجد إسنادات" /> : (
          <>
            <Table head={["العنوان", "النوع", "المرجع", "المسند إليه", "بواسطة", "الأولوية", "الحالة", "الاستحقاق", ""]}>
              {data.data.map((a) => (
                <tr key={a.id} className="hover:bg-slate-50">
                  <Td className="font-medium text-slate-900">{a.title}</Td>
                  <Td>{ASSIGNMENT_TYPE[a.type] ?? a.type}</Td>
                  <Td><Reference a={a} /></Td>
                  <Td>{a.assignedToName}</Td>
                  <Td>{a.assignedByName}</Td>
                  <Td><StatusBadge map={PRIORITY} value={a.priority} /></Td>
                  <Td><StatusBadge map={ASSIGNMENT_STATUS} value={a.status} /></Td>
                  <Td>{formatDate(a.dueDate)}</Td>
                  <Td>{canCancel(a) && <Button variant="ghost" className="text-red-600" onClick={() => void cancel(a)}>إلغاء</Button>}</Td>
                </tr>
              ))}
            </Table>
            <Pagination {...data.meta} onPage={setPage} />
          </>
        )}
      </Card>
      <NewAssignmentModal open={creating} onClose={() => setCreating(false)} onSaved={reload} />
    </>
  );
}
