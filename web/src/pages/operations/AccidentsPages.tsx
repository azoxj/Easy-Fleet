import { useEffect, useRef, useState } from "react";
import { Link, useNavigate, useParams, useSearchParams } from "react-router";
import { DataList } from "../../components/DataList";
import { useToast } from "../../components/feedback";
import { Icon } from "../../components/icons";
import { BackLink, DateRange, FilterBar, localToIso, Money, nowLocalInput, ProjectSelect, RecordTimeline, useAction, useProjects, useVehicles, VehicleSelect, type AuditRow } from "../../components/shared";
import { Alert, Button, Card, CardHeader, DescList, EmptyState, Field, Input, Loading, Modal, PageHeader, Pagination, Select, StatusBadge, Textarea } from "../../components/ui";
import { useApi } from "../../hooks/useApi";
import { api, apiUpload, fileUrl, type Paged } from "../../lib/api";
import { useAuth } from "../../lib/auth";
import { formatDateTime } from "../../lib/format";
import { errorMessage, fieldErrors } from "../../lib/forms";
import { ACCIDENT_SEVERITY, ACCIDENT_STATUS, RESPONSIBILITY } from "../../lib/labels";
import type { AccidentRow } from "../../lib/types";

export function ReportAccidentModal({ open, onClose, onCreated, vehicleId }: { open: boolean; onClose: () => void; onCreated: (id: string) => void; vehicleId?: string }) {
  const toast = useToast();
  const vehicles = useVehicles();
  const empty = { vehicleId: vehicleId ?? "", occurredAt: nowLocalInput(), location: "", description: "", severity: "MINOR", responsibility: "UNKNOWN", policeReportNumber: "" };
  const [v, setV] = useState(empty);
  const [geo, setGeo] = useState<{ lat: number; lng: number } | null>(null);
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  // eslint-disable-next-line react-hooks/exhaustive-deps
  useEffect(() => { if (open) { setV(empty); setGeo(null); setErrors({}); setError(null); } }, [open]);
  const set = (k: keyof typeof v) => (e: { target: { value: string } }) => setV((s) => ({ ...s, [k]: e.target.value }));
  const locate = () => navigator.geolocation?.getCurrentPosition((p) => setGeo({ lat: Number(p.coords.latitude.toFixed(6)), lng: Number(p.coords.longitude.toFixed(6)) }), () => toast.error("تعذر تحديد الموقع — تحقق من إذن الموقع"), { enableHighAccuracy: true, timeout: 10000 });
  const save = async () => {
    const e: Record<string, string> = {};
    if (!v.vehicleId) e.vehicleId = "اختر المركبة";
    if (v.description.trim().length < 3) e.description = "اكتب وصف الحادث";
    setErrors(e);
    if (Object.keys(e).length) return;
    setBusy(true);
    try {
      const r = await api<{ data: { id: string } }>("/accidents", { method: "POST", body: { vehicleId: v.vehicleId, occurredAt: localToIso(v.occurredAt), description: v.description.trim(), severity: v.severity, responsibility: v.responsibility, ...(v.location.trim() ? { location: v.location.trim() } : {}), ...(v.policeReportNumber.trim() ? { policeReportNumber: v.policeReportNumber.trim() } : {}), ...(geo ? { latitude: geo.lat, longitude: geo.lng } : {}) } });
      toast.success("تم تسجيل الحادث وإشعار المسؤولين");
      onCreated(r.data.id);
      onClose();
    } catch (err) {
      setErrors(fieldErrors(err));
      setError(errorMessage(err));
    } finally {
      setBusy(false);
    }
  };
  return (
    <Modal open={open} onClose={onClose} title="تسجيل حادث" footer={<><Button variant="secondary" onClick={onClose}>إلغاء</Button><Button variant="danger" loading={busy} onClick={save}>تسجيل الحادث</Button></>}>
      <div className="space-y-4">
        {error && <Alert>{error}</Alert>}
        <Alert tone="amber">تسجيل الحادث يغيّر حالة المركبة إلى «حادث» حتى إغلاقه.</Alert>
        {!vehicleId && <Field label="المركبة" required error={errors.vehicleId} htmlFor="a-vehicle"><VehicleSelect id="a-vehicle" value={v.vehicleId} onChange={(x) => setV((s) => ({ ...s, vehicleId: x }))} vehicles={vehicles.filter((x) => x.status !== "ARCHIVED")} all="اختر المركبة..." /></Field>}
        <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
          <Field label="وقت الحادث" required htmlFor="a-at"><Input id="a-at" type="datetime-local" value={v.occurredAt} onChange={set("occurredAt")} /></Field>
          <Field label="الخطورة" required htmlFor="a-sev"><Select id="a-sev" value={v.severity} onChange={set("severity")}>{Object.entries(ACCIDENT_SEVERITY).map(([k, l]) => <option key={k} value={k}>{l.label}</option>)}</Select></Field>
          <Field label="المسؤولية" htmlFor="a-resp"><Select id="a-resp" value={v.responsibility} onChange={set("responsibility")}>{Object.entries(RESPONSIBILITY).map(([k, l]) => <option key={k} value={k}>{l}</option>)}</Select></Field>
          <Field label="رقم محضر المرور/نجم" htmlFor="a-police"><Input id="a-police" dir="ltr" value={v.policeReportNumber} onChange={set("policeReportNumber")} /></Field>
        </div>
        <Field label="الموقع" htmlFor="a-loc">
          <div className="flex gap-2"><Input id="a-loc" value={v.location} onChange={set("location")} /><Button variant="secondary" icon="pin" onClick={locate}>موقعي</Button></div>
          {geo && <p className="mt-1 text-xs text-emerald-700 ltr">{geo.lat}, {geo.lng}</p>}
        </Field>
        <Field label="وصف الحادث" required error={errors.description} htmlFor="a-desc"><Textarea id="a-desc" value={v.description} onChange={set("description")} /></Field>
      </div>
    </Modal>
  );
}

export function AccidentsList({ vehicleId, embedded }: { vehicleId?: string; embedded?: boolean }) {
  const { can } = useAuth();
  const navigate = useNavigate();
  const [params] = useSearchParams();
  const projects = useProjects();
  const init = { q: "", status: "", severity: "", projectId: "", open: params.get("open") ?? "", from: "", to: "" };
  const [f, setF] = useState(init);
  const [page, setPage] = useState(1);
  const [adding, setAdding] = useState(false);
  const { data, loading, error } = useApi<Paged<AccidentRow>>("/accidents", { ...f, vehicleId, page, pageSize: 20 });
  const upd = (k: keyof typeof f, v: string) => { setF((s) => ({ ...s, [k]: v })); setPage(1); };
  const active = Object.entries(f).filter(([k, v]) => k !== "q" && v).length;
  return (
    <Card>
      <div className="flex items-center justify-between gap-2 border-b border-slate-100 px-4 py-3">
        <p className="text-sm text-slate-500">الحوادث المسجلة</p>
        {can("accidents.create") && <Button variant="danger" icon="alert" onClick={() => setAdding(true)}>تسجيل حادث</Button>}
      </div>
      {!embedded && (
        <FilterBar q={f.q} onQ={(v) => upd("q", v)} placeholder="بحث: ACC-رقم، اللوحة، الموقع..." active={active} onClear={() => { setF({ ...init, q: f.q, open: "" }); setPage(1); }}>
          <Select value={f.status} onChange={(e) => upd("status", e.target.value)} aria-label="الحالة"><option value="">كل الحالات</option>{Object.entries(ACCIDENT_STATUS).map(([k, l]) => <option key={k} value={k}>{l.label}</option>)}</Select>
          <Select value={f.severity} onChange={(e) => upd("severity", e.target.value)} aria-label="الخطورة"><option value="">كل درجات الخطورة</option>{Object.entries(ACCIDENT_SEVERITY).map(([k, l]) => <option key={k} value={k}>{l.label}</option>)}</Select>
          <Select value={f.open} onChange={(e) => upd("open", e.target.value)} aria-label="مفتوحة"><option value="">الكل</option><option value="true">غير المغلقة فقط</option></Select>
          {projects.length > 0 && <ProjectSelect value={f.projectId} onChange={(v) => upd("projectId", v)} projects={projects} />}
          <DateRange from={f.from} to={f.to} onFrom={(v) => upd("from", v)} onTo={(v) => upd("to", v)} />
        </FilterBar>
      )}
      {loading ? <Loading /> : error ? <div className="p-4"><Alert>{error.message}</Alert></div> : !data?.data.length ? <EmptyState icon="alert" title="لا توجد حوادث" /> : (
        <>
          <DataList rows={data.data} rowKey={(r) => r.id} onRowClick={(r) => navigate(`/accidents/${r.id}`)} columns={[
            { header: "الحادث", primary: true, cell: (r) => <span className="flex gap-2"><Link to={`/accidents/${r.id}`} onClick={(e) => e.stopPropagation()} className="font-semibold ltr hover:text-brand-700">{r.label}</Link><span className="ltr">{r.plateNumber}</span></span> },
            { header: "الوقت", cell: (r) => formatDateTime(r.occurredAt) },
            { header: "الخطورة", cell: (r) => <StatusBadge map={ACCIDENT_SEVERITY} value={r.severity} /> },
            { header: "الحالة", cell: (r) => <StatusBadge map={ACCIDENT_STATUS} value={r.status} /> },
            { header: "السائق", cell: (r) => r.driverName ?? "—", hideOnMobile: true },
            { header: "المشروع", cell: (r) => r.projectName ?? "—", hideOnMobile: true },
            { header: "تكلفة الإصلاح", cell: (r) => <Money value={r.repairCost} />, hideOnMobile: true },
          ]} />
          <Pagination {...data.meta} onPage={setPage} />
        </>
      )}
      <ReportAccidentModal open={adding} onClose={() => setAdding(false)} onCreated={(id) => navigate(`/accidents/${id}`)} vehicleId={vehicleId} />
    </Card>
  );
}

export function AccidentsPage() {
  return (
    <>
      <PageHeader title="الحوادث" subtitle="مفتوح ← قيد المراجعة ← التأمين/الإصلاح ← مغلق" />
      <AccidentsList />
    </>
  );
}

type AccidentDetail = AccidentRow & {
  description: string;
  policeReportNumber: string | null;
  resolution: string | null;
  latitude: string | null;
  longitude: string | null;
  vehicleStatus: string;
  createdByName: string;
  maintenanceNumber: number | null;
  maintenanceRequestId: string | null;
  attachments: { id: string; category: string; fileName: string; mimeType: string; createdAt: string }[];
  timeline: AuditRow[];
  actions: string[];
};

const ATTACH: Record<string, string> = { PHOTO: "صورة", POLICE_REPORT: "محضر", INSURANCE: "مستند تأمين", REPAIR_INVOICE: "فاتورة إصلاح", OTHER: "أخرى" };

export function AccidentDetailPage() {
  const { id } = useParams();
  const { data, loading, error, reload } = useApi<{ data: AccidentDetail }>(`/accidents/${id}`);
  const { can } = useAuth();
  const toast = useToast();
  const { busy, run } = useAction();
  const file = useRef<HTMLInputElement>(null);
  const [cat, setCat] = useState("PHOTO");
  const [statusTo, setStatusTo] = useState<string | null>(null);
  const [resolution, setResolution] = useState("");
  const [editing, setEditing] = useState(false);
  const [edit, setEdit] = useState({ insuranceClaimNumber: "", repairCost: "", responsibility: "UNKNOWN", severity: "MINOR" });
  if (loading) return <Loading />;
  if (error || !data) return <Alert>{error?.message ?? "تعذر التحميل"}</Alert>;
  const a = data.data;
  const transitions = a.actions.filter((x) => x.startsWith("status:")).map((x) => x.slice(7));
  const upload = async (f: File | undefined) => {
    if (!f) return;
    try {
      await apiUpload(`/accidents/${a.id}/attachments?category=${cat}`, f, fetch, "POST");
      toast.success("تم رفع المرفق");
      reload();
    } catch (err) {
      toast.error(errorMessage(err));
    } finally {
      if (file.current) file.current.value = "";
    }
  };
  const canAttach = a.status !== "CLOSED" && (a.actions.includes("attach") || can("accidents.create"));
  return (
    <>
      <PageHeader
        back={<BackLink to="/accidents" label="الحوادث" />}
        title={<span className="flex flex-wrap items-center gap-3"><span className="ltr">{a.label}</span><StatusBadge map={ACCIDENT_STATUS} value={a.status} /><StatusBadge map={ACCIDENT_SEVERITY} value={a.severity} /></span>}
        subtitle={<>المركبة <Link className="text-brand-700 ltr" to={`/vehicles/${a.vehicleId}`}>{a.plateNumber}</Link> — {formatDateTime(a.occurredAt)}</>}
        actions={
          <>
            {a.actions.includes("edit") && <Button variant="secondary" icon="edit" onClick={() => { setEdit({ insuranceClaimNumber: a.insuranceClaimNumber ?? "", repairCost: a.repairCost ?? "", responsibility: a.responsibility, severity: a.severity }); setEditing(true); }}>تحديث البيانات</Button>}
            {transitions.map((t) => <Button key={t} variant={t === "CLOSED" ? "primary" : "secondary"} onClick={() => { setResolution(""); setStatusTo(t); }}>{t === "UNDER_REVIEW" && a.status === "CLOSED" ? "إعادة فتح" : `نقل إلى: ${ACCIDENT_STATUS[t]!.label}`}</Button>)}
          </>
        }
      />
      <div className="grid grid-cols-1 gap-6 lg:grid-cols-3">
        <div className="space-y-6 lg:col-span-2">
          <Card>
            <CardHeader title="تفاصيل الحادث" />
            <div className="space-y-4 p-5">
              <p className="text-sm leading-7 text-slate-700">{a.description}</p>
              <DescList items={[
                { label: "المشروع", value: a.projectName },
                { label: "السائق", value: a.driverName },
                { label: "المسؤولية", value: RESPONSIBILITY[a.responsibility] },
                { label: "الموقع", value: a.location },
                { label: "الإحداثيات", value: a.latitude ? <a className="text-brand-700 ltr" target="_blank" rel="noreferrer noopener" href={`https://www.openstreetmap.org/?mlat=${a.latitude}&mlon=${a.longitude}#map=17/${a.latitude}/${a.longitude}`}>{a.latitude}, {a.longitude}</a> : null },
                { label: "رقم المحضر", value: a.policeReportNumber },
                { label: "رقم مطالبة التأمين", value: a.insuranceClaimNumber },
                { label: "تكلفة الإصلاح", value: <Money value={a.repairCost} /> },
                { label: "طلب الصيانة", value: a.maintenanceRequestId ? <Link className="text-brand-700 ltr" to={`/maintenance/${a.maintenanceRequestId}`}>MR-{a.maintenanceNumber}</Link> : null },
                { label: "سجّله", value: a.createdByName },
              ]} />
              {a.resolution && <Alert tone="green">القرار/النتيجة: {a.resolution}</Alert>}
            </div>
          </Card>
          <Card>
            <CardHeader title={`المرفقات (${a.attachments.length})`} action={canAttach && (
              <div className="flex items-center gap-2">
                <Select value={cat} onChange={(e) => setCat(e.target.value)} aria-label="نوع المرفق" className="w-36">{Object.entries(ATTACH).map(([k, l]) => <option key={k} value={k}>{l}</option>)}</Select>
                <input ref={file} type="file" accept="application/pdf,image/png,image/jpeg,image/webp" capture="environment" className="hidden" onChange={(e) => void upload(e.target.files?.[0])} />
                <Button variant="secondary" icon="camera" onClick={() => file.current?.click()}>إرفاق</Button>
              </div>
            )} />
            {a.attachments.length === 0 ? <EmptyState icon="file" title="لا توجد مرفقات" /> : (
              <ul className="divide-y divide-slate-100">
                {a.attachments.map((x) => (
                  <li key={x.id} className="flex items-center justify-between gap-3 px-5 py-3 text-sm">
                    <a className="flex items-center gap-2 text-brand-700 hover:underline" href={fileUrl(`/accident-attachments/${x.id}/file`)} download><Icon name="file" className="size-4" />{x.fileName}</a>
                    <span className="text-xs text-slate-500">{ATTACH[x.category] ?? x.category} · {formatDateTime(x.createdAt)}</span>
                  </li>
                ))}
              </ul>
            )}
          </Card>
        </div>
        <Card><CardHeader title="السجل" /><div className="p-5"><RecordTimeline rows={a.timeline} /></div></Card>
      </div>
      <Modal open={!!statusTo} onClose={() => setStatusTo(null)} title={`نقل الحادث إلى: ${statusTo ? ACCIDENT_STATUS[statusTo]?.label : ""}`} footer={<><Button variant="secondary" onClick={() => setStatusTo(null)}>إلغاء</Button><Button loading={busy === "status"} onClick={async () => { if (await run("status", () => api(`/accidents/${a.id}/status`, { method: "POST", body: { to: statusTo, ...(resolution.trim() ? { resolution: resolution.trim() } : {}) } }), "تم تحديث الحالة")) { setStatusTo(null); reload(); } }}>تأكيد</Button></>}>
        <div className="space-y-3">
          {statusTo === "CLOSED" && <Alert tone="blue">عند الإغلاق تعود المركبة لحالتها السابقة إذا لم يكن هناك حادث آخر مفتوح.</Alert>}
          <Field label={statusTo === "CLOSED" ? "القرار/النتيجة (مطلوب)" : "ملاحظة (اختياري)"} htmlFor="acc-res"><Textarea id="acc-res" value={resolution} onChange={(e) => setResolution(e.target.value)} /></Field>
        </div>
      </Modal>
      <Modal open={editing} onClose={() => setEditing(false)} title="تحديث بيانات الحادث" footer={<><Button variant="secondary" onClick={() => setEditing(false)}>إلغاء</Button><Button loading={busy === "edit"} onClick={async () => { if (await run("edit", () => api(`/accidents/${a.id}`, { method: "PATCH", body: { insuranceClaimNumber: edit.insuranceClaimNumber || null, repairCost: edit.repairCost || null, responsibility: edit.responsibility, severity: edit.severity } }), "تم الحفظ")) { setEditing(false); reload(); } }}>حفظ</Button></>}>
        <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
          <Field label="الخطورة" htmlFor="ae-sev"><Select id="ae-sev" value={edit.severity} onChange={(e) => setEdit({ ...edit, severity: e.target.value })}>{Object.entries(ACCIDENT_SEVERITY).map(([k, l]) => <option key={k} value={k}>{l.label}</option>)}</Select></Field>
          <Field label="المسؤولية" htmlFor="ae-resp"><Select id="ae-resp" value={edit.responsibility} onChange={(e) => setEdit({ ...edit, responsibility: e.target.value })}>{Object.entries(RESPONSIBILITY).map(([k, l]) => <option key={k} value={k}>{l}</option>)}</Select></Field>
          <Field label="رقم مطالبة التأمين" htmlFor="ae-claim"><Input id="ae-claim" dir="ltr" value={edit.insuranceClaimNumber} onChange={(e) => setEdit({ ...edit, insuranceClaimNumber: e.target.value })} /></Field>
          <Field label="تكلفة الإصلاح" htmlFor="ae-cost"><Input id="ae-cost" dir="ltr" value={edit.repairCost} onChange={(e) => setEdit({ ...edit, repairCost: e.target.value })} /></Field>
        </div>
      </Modal>
    </>
  );
}
