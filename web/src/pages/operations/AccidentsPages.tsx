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
import { t } from "../../i18n";

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
  const locate = () => navigator.geolocation?.getCurrentPosition((p) => setGeo({ lat: Number(p.coords.latitude.toFixed(6)), lng: Number(p.coords.longitude.toFixed(6)) }), () => toast.error(t("accidents.couldNotGetTheLocation")), { enableHighAccuracy: true, timeout: 10000 });
  const save = async () => {
    const e: Record<string, string> = {};
    if (!v.vehicleId) e.vehicleId = t("common.selectAVehicle2");
    if (v.description.trim().length < 3) e.description = t("accidents.describeTheAccident");
    setErrors(e);
    if (Object.keys(e).length) return;
    setBusy(true);
    try {
      const r = await api<{ data: { id: string } }>("/accidents", { method: "POST", body: { vehicleId: v.vehicleId, occurredAt: localToIso(v.occurredAt), description: v.description.trim(), severity: v.severity, responsibility: v.responsibility, ...(v.location.trim() ? { location: v.location.trim() } : {}), ...(v.policeReportNumber.trim() ? { policeReportNumber: v.policeReportNumber.trim() } : {}), ...(geo ? { latitude: geo.lat, longitude: geo.lng } : {}) } });
      toast.success(t("accidents.accidentReportedAndTheResponsible"));
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
    <Modal open={open} onClose={onClose} title={t("accidents.reportNewAccident")} footer={<><Button variant="secondary" onClick={onClose}>{t("common.cancel")}</Button><Button variant="danger" loading={busy} onClick={save}>{t("accidents.reportAccident")}</Button></>}>
      <div className="space-y-4">
        {error && <Alert>{error}</Alert>}
        <Alert tone="amber">{t("accidents.reportingAnAccidentSetsThe")}</Alert>
        {!vehicleId && <Field label={t("common.vehicle")} required error={errors.vehicleId} htmlFor="a-vehicle"><VehicleSelect id="a-vehicle" value={v.vehicleId} onChange={(x) => setV((s) => ({ ...s, vehicleId: x }))} vehicles={vehicles.filter((x) => x.status !== "ARCHIVED")} all={t("common.selectAVehicle3")} /></Field>}
        <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
          <Field label={t("accidents.accidentTime")} required htmlFor="a-at"><Input id="a-at" type="datetime-local" value={v.occurredAt} onChange={set("occurredAt")} /></Field>
          <Field label={t("accidents.severity")} required htmlFor="a-sev"><Select id="a-sev" value={v.severity} onChange={set("severity")}>{Object.entries(ACCIDENT_SEVERITY).map(([k, l]) => <option key={k} value={k}>{l.label}</option>)}</Select></Field>
          <Field label={t("accidents.responsibility")} htmlFor="a-resp"><Select id="a-resp" value={v.responsibility} onChange={set("responsibility")}>{Object.entries(RESPONSIBILITY).map(([k, l]) => <option key={k} value={k}>{l}</option>)}</Select></Field>
          <Field label={t("accidents.trafficNajmReportNumber")} htmlFor="a-police"><Input id="a-police" dir="ltr" value={v.policeReportNumber} onChange={set("policeReportNumber")} /></Field>
        </div>
        <Field label={t("accidents.location")} htmlFor="a-loc">
          <div className="flex gap-2"><Input id="a-loc" value={v.location} onChange={set("location")} /><Button variant="secondary" icon="pin" onClick={locate}>{t("accidents.myLocation")}</Button></div>
          {geo && <p className="mt-1 text-xs text-emerald-700 ltr">{geo.lat}, {geo.lng}</p>}
        </Field>
        <Field label={t("accidents.accidentDescription")} required error={errors.description} htmlFor="a-desc"><Textarea id="a-desc" value={v.description} onChange={set("description")} /></Field>
      </div>
    </Modal>
  );
}

export function AccidentsList({ vehicleId, embedded }: { vehicleId?: string; embedded?: boolean }) {
  const { can } = useAuth();
  const navigate = useNavigate();
  const [params] = useSearchParams();
  const projects = useProjects();
  const init = { q: "", status: "", severity: "", projectId: "", open: params.get("open") ?? "", from: embedded ? "" : (params.get("from") ?? ""), to: embedded ? "" : (params.get("to") ?? "") };
  const [f, setF] = useState(init);
  const [page, setPage] = useState(1);
  const [adding, setAdding] = useState(false);
  const { data, loading, error } = useApi<Paged<AccidentRow>>("/accidents", { ...f, vehicleId, page, pageSize: 20 });
  const upd = (k: keyof typeof f, v: string) => { setF((s) => ({ ...s, [k]: v })); setPage(1); };
  const active = Object.entries(f).filter(([k, v]) => k !== "q" && v).length;
  return (
    <Card>
      <div className="flex items-center justify-between gap-2 border-b border-slate-100 px-4 py-3">
        <p className="text-sm text-slate-500">{t("accidents.reportedAccidents")}</p>
        {can("accidents.create") && <Button variant="danger" icon="alert" onClick={() => setAdding(true)}>{t("accidents.reportNewAccident")}</Button>}
      </div>
      {!embedded && (
        <FilterBar q={f.q} onQ={(v) => upd("q", v)} placeholder={t("accidents.searchAccNumberPlateLocation")} active={active} onClear={() => { setF({ ...init, q: f.q, open: "" }); setPage(1); }}>
          <Select value={f.status} onChange={(e) => upd("status", e.target.value)} aria-label={t("common.status")}><option value="">{t("common.allStatuses")}</option>{Object.entries(ACCIDENT_STATUS).map(([k, l]) => <option key={k} value={k}>{l.label}</option>)}</Select>
          <Select value={f.severity} onChange={(e) => upd("severity", e.target.value)} aria-label={t("accidents.severity")}><option value="">{t("accidents.allSeverities")}</option>{Object.entries(ACCIDENT_SEVERITY).map(([k, l]) => <option key={k} value={k}>{l.label}</option>)}</Select>
          <Select value={f.open} onChange={(e) => upd("open", e.target.value)} aria-label={t("accidents.open")}><option value="">{t("common.all")}</option><option value="true">{t("accidents.notClosedOnly")}</option></Select>
          {projects.length > 0 && <ProjectSelect value={f.projectId} onChange={(v) => upd("projectId", v)} projects={projects} />}
          <DateRange from={f.from} to={f.to} onFrom={(v) => upd("from", v)} onTo={(v) => upd("to", v)} />
        </FilterBar>
      )}
      {loading ? <Loading /> : error ? <div className="p-4"><Alert>{error.message}</Alert></div> : !data?.data.length ? <EmptyState icon="alert" title={t("accidents.noAccidents")} /> : (
        <>
          <DataList rows={data.data} rowKey={(r) => r.id} onRowClick={(r) => navigate(`/accidents/${r.id}`)} columns={[
            { header: t("accidents.accident"), primary: true, cell: (r) => <span className="flex gap-2"><Link to={`/accidents/${r.id}`} onClick={(e) => e.stopPropagation()} className="font-semibold ltr hover:text-brand-700">{r.label}</Link><span className="ltr">{r.plateNumber}</span></span> },
            { header: t("common.time"), cell: (r) => formatDateTime(r.occurredAt) },
            { header: t("accidents.severity"), cell: (r) => <StatusBadge map={ACCIDENT_SEVERITY} value={r.severity} /> },
            { header: t("common.status"), cell: (r) => <StatusBadge map={ACCIDENT_STATUS} value={r.status} /> },
            { header: t("common.driver"), cell: (r) => r.driverName ?? "—", hideOnMobile: true },
            { header: t("common.project"), cell: (r) => r.projectName ?? "—", hideOnMobile: true },
            { header: t("accidents.repairCost"), cell: (r) => <Money value={r.repairCost} />, hideOnMobile: true },
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
      <PageHeader title={t("common.accidents")} subtitle={t("accidents.openUnderReviewInsuranceRepair")} />
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

const ATTACH: Record<string, string> = { get PHOTO() { return t("enums.attach.PHOTO"); }, get POLICE_REPORT() { return t("enums.attach.POLICE_REPORT"); }, get INSURANCE() { return t("enums.attach.INSURANCE"); }, get REPAIR_INVOICE() { return t("enums.attach.REPAIR_INVOICE"); }, get OTHER() { return t("enums.attach.OTHER"); } };

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
  if (error || !data) return <Alert>{error?.message ?? t("common.couldNotLoad")}</Alert>;
  const a = data.data;
  const transitions = a.actions.filter((x) => x.startsWith("status:")).map((x) => x.slice(7));
  const upload = async (f: File | undefined) => {
    if (!f) return;
    try {
      await apiUpload(`/accidents/${a.id}/attachments?category=${cat}`, f, fetch, "POST");
      toast.success(t("common.attachmentUploaded"));
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
        back={<BackLink to="/accidents" label={t("common.accidents")} />}
        title={<span className="flex flex-wrap items-center gap-3"><span className="ltr">{a.label}</span><StatusBadge map={ACCIDENT_STATUS} value={a.status} /><StatusBadge map={ACCIDENT_SEVERITY} value={a.severity} /></span>}
        subtitle={<>{t("common.vehicle")} <Link className="text-brand-700 ltr" to={`/vehicles/${a.vehicleId}`}>{a.plateNumber}</Link> — {formatDateTime(a.occurredAt)}</>}
        actions={
          <>
            {a.actions.includes("edit") && <Button variant="secondary" icon="edit" onClick={() => { setEdit({ insuranceClaimNumber: a.insuranceClaimNumber ?? "", repairCost: a.repairCost ?? "", responsibility: a.responsibility, severity: a.severity }); setEditing(true); }}>{t("accidents.updateDetails")}</Button>}
            {transitions.map((item) => <Button key={item} variant={item === "CLOSED" ? "primary" : "secondary"} onClick={() => { setResolution(""); setStatusTo(item); }}>{item === "UNDER_REVIEW" && a.status === "CLOSED" ? t("common.reopen") : t("accidents.moveTo", { label: ACCIDENT_STATUS[item]!.label })}</Button>)}
          </>
        }
      />
      <div className="grid grid-cols-1 gap-6 lg:grid-cols-3">
        <div className="space-y-6 lg:col-span-2">
          <Card>
            <CardHeader title={t("accidents.accidentDetails")} />
            <div className="space-y-4 p-5">
              <p className="text-sm leading-7 text-slate-700">{a.description}</p>
              <DescList items={[
                { label: t("common.project"), value: a.projectName },
                { label: t("common.driver"), value: a.driverName },
                { label: t("accidents.responsibility"), value: RESPONSIBILITY[a.responsibility] },
                { label: t("accidents.location"), value: a.location },
                { label: t("common.coordinates"), value: a.latitude ? <a className="text-brand-700 ltr" target="_blank" rel="noreferrer noopener" href={`https://www.openstreetmap.org/?mlat=${a.latitude}&mlon=${a.longitude}#map=17/${a.latitude}/${a.longitude}`}>{a.latitude}, {a.longitude}</a> : null },
                { label: t("accidents.reportNumber"), value: a.policeReportNumber },
                { label: t("accidents.insuranceClaimNumber"), value: a.insuranceClaimNumber },
                { label: t("accidents.repairCost"), value: <Money value={a.repairCost} /> },
                { label: t("accidents.maintenanceRequest"), value: a.maintenanceRequestId ? <Link className="text-brand-700 ltr" to={`/maintenance/${a.maintenanceRequestId}`}>MR-{a.maintenanceNumber}</Link> : null },
                { label: t("accidents.reportedBy"), value: a.createdByName },
              ]} />
              {a.resolution && <Alert tone="green">{t("accidents.decisionOutcome", { resolution: a.resolution })}</Alert>}
            </div>
          </Card>
          <Card>
            <CardHeader title={t("accidents.attachments", { length: a.attachments.length })} action={canAttach && (
              <div className="flex items-center gap-2">
                <Select value={cat} onChange={(e) => setCat(e.target.value)} aria-label={t("common.attachmentType")} className="w-36">{Object.entries(ATTACH).map(([k, l]) => <option key={k} value={k}>{l}</option>)}</Select>
                <input ref={file} type="file" accept="application/pdf,image/png,image/jpeg,image/webp" capture="environment" className="hidden" onChange={(e) => void upload(e.target.files?.[0])} />
                <Button variant="secondary" icon="camera" onClick={() => file.current?.click()}>{t("accidents.attach")}</Button>
              </div>
            )} />
            {a.attachments.length === 0 ? <EmptyState icon="file" title={t("common.noAttachments")} /> : (
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
        <Card><CardHeader title={t("common.history")} /><div className="p-5"><RecordTimeline rows={a.timeline} /></div></Card>
      </div>
      <Modal open={!!statusTo} onClose={() => setStatusTo(null)} title={t("accidents.moveAccidentTo", { value: statusTo ? ACCIDENT_STATUS[statusTo]?.label : "" })} footer={<><Button variant="secondary" onClick={() => setStatusTo(null)}>{t("common.cancel")}</Button><Button loading={busy === "status"} onClick={async () => { if (await run("status", () => api(`/accidents/${a.id}/status`, { method: "POST", body: { to: statusTo, ...(resolution.trim() ? { resolution: resolution.trim() } : {}) } }), t("accidents.statusUpdated"))) { setStatusTo(null); reload(); } }}>{t("common.confirm")}</Button></>}>
        <div className="space-y-3">
          {statusTo === "CLOSED" && <Alert tone="blue">{t("accidents.onClosingTheVehicleReturns")}</Alert>}
          <Field label={statusTo === "CLOSED" ? t("accidents.decisionOutcomeRequired") : t("accidents.noteOptional")} htmlFor="acc-res"><Textarea id="acc-res" value={resolution} onChange={(e) => setResolution(e.target.value)} /></Field>
        </div>
      </Modal>
      <Modal open={editing} onClose={() => setEditing(false)} title={t("accidents.updateAccidentDetails")} footer={<><Button variant="secondary" onClick={() => setEditing(false)}>{t("common.cancel")}</Button><Button loading={busy === "edit"} onClick={async () => { if (await run("edit", () => api(`/accidents/${a.id}`, { method: "PATCH", body: { insuranceClaimNumber: edit.insuranceClaimNumber || null, repairCost: edit.repairCost || null, responsibility: edit.responsibility, severity: edit.severity } }), t("common.saved"))) { setEditing(false); reload(); } }}>{t("common.save")}</Button></>}>
        <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
          <Field label={t("accidents.severity")} htmlFor="ae-sev"><Select id="ae-sev" value={edit.severity} onChange={(e) => setEdit({ ...edit, severity: e.target.value })}>{Object.entries(ACCIDENT_SEVERITY).map(([k, l]) => <option key={k} value={k}>{l.label}</option>)}</Select></Field>
          <Field label={t("accidents.responsibility")} htmlFor="ae-resp"><Select id="ae-resp" value={edit.responsibility} onChange={(e) => setEdit({ ...edit, responsibility: e.target.value })}>{Object.entries(RESPONSIBILITY).map(([k, l]) => <option key={k} value={k}>{l}</option>)}</Select></Field>
          <Field label={t("accidents.insuranceClaimNumber")} htmlFor="ae-claim"><Input id="ae-claim" dir="ltr" value={edit.insuranceClaimNumber} onChange={(e) => setEdit({ ...edit, insuranceClaimNumber: e.target.value })} /></Field>
          <Field label={t("accidents.repairCost")} htmlFor="ae-cost"><Input id="ae-cost" dir="ltr" value={edit.repairCost} onChange={(e) => setEdit({ ...edit, repairCost: e.target.value })} /></Field>
        </div>
      </Modal>
    </>
  );
}
