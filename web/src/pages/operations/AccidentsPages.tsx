import { useEffect, useRef, useState } from "react";
import { Link, useNavigate, useParams } from "react-router";
import { DataList, ListBody } from "../../components/DataList";
import { useToast } from "../../components/feedback";
import { Icon } from "../../components/icons";
import { BackLink, DateRange, FilterBar, localToIso, Money, nowLocalInput, ProjectSelect, RecordTimeline, useAction, useProjects, useVehicles, VehicleSelect, type AuditRow } from "../../components/shared";
import { Alert, Button, Card, CardHeader, DescList, EmptyState, Field, Input, Loading, Modal, PageHeader, Pagination, Select, StatusBadge, Tabs, Textarea } from "../../components/ui";
import { useApi } from "../../hooks/useApi";
import { useListState } from "../../hooks/useListState";
import { api, apiUpload, fileUrl, type Paged } from "../../lib/api";
import { useAuth } from "../../lib/auth";
import { formatDateTime } from "../../lib/format";
import { errorMessage, fieldErrors } from "../../lib/forms";
import { ACCIDENT_SEVERITY, ACCIDENT_STATUS, RESPONSIBILITY } from "../../lib/labels";
import type { AccidentRow } from "../../lib/types";
import { t } from "../../i18n";
import { accidentTabs, isTabKey, nextActionLabel, type AccidentTabKey } from "../../lib/accidentWorkflow";
import { activeFilters } from "../../lib/listState";
import { AccidentKpis } from "./accidents/AccidentKpis";
import { CaseFlags, StageBadge } from "./accidents/AccidentBadges";
import { CaseDetailPage } from "./accidents/CaseDetail";
import { useAccidentFeatures } from "./accidents/useAccidentFeatures";

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

export function AccidentsList({ vehicleId, embedded, tabs }: { vehicleId?: string; embedded?: boolean; tabs?: { key: AccidentTabKey; label: string }[] }) {
  const { can } = useAuth();
  const { workflow } = useAccidentFeatures();
  const navigate = useNavigate();
  const projects = useProjects();
  const defaults = { q: "", status: "", severity: "", projectId: "", open: "", from: "", to: "", view: "" };
  const list = useListState(defaults, { persist: !embedded });
  const f = list.f;
  const [adding, setAdding] = useState(false);
  const view = (isTabKey(f.view) && tabs?.some((x) => x.key === f.view) ? f.view : "all") as AccidentTabKey;
  const { data, loading, error } = useApi<Paged<AccidentRow>>("/accidents", { ...list.query, view: view === "all" ? undefined : view, vehicleId });
  const upd = (k: keyof typeof f, v: string) => list.setValue(k, v);
  // The tab is not a filter: it is not counted on the filter button.
  const active = activeFilters(f, defaults, ["q", "view"]);
  return (
    <Card>
      <div className="flex items-center justify-between gap-2 border-b border-slate-100 px-4 py-3">
        <p className="text-sm text-slate-500">{t("accidents.reportedAccidents")}</p>
        {can("accidents.create") && (workflow ? <Link to={vehicleId ? `/accidents/new?vehicleId=${vehicleId}` : "/accidents/new"}><Button variant="danger" icon="alert">{t("accidents.reportNewAccident")}</Button></Link> : <Button variant="danger" icon="alert" onClick={() => setAdding(true)}>{t("accidents.reportNewAccident")}</Button>)}
      </div>
      {!embedded && tabs && tabs.length > 1 && <div className="border-b border-slate-100 px-4"><Tabs tabs={tabs} active={view} onChange={(k) => { list.clear(); list.setValue("view", k === "all" ? "" : k); }} /></div>}
      {!embedded && (
        <FilterBar q={list.search} onQ={list.setSearch} pending={list.pending} placeholder={t("accidents.searchAccNumberPlateLocation")} active={active} onClear={() => list.clear()}>
          <Select value={f.status} onChange={(e) => upd("status", e.target.value)} aria-label={t("common.status")}><option value="">{t("common.allStatuses")}</option>{Object.entries(ACCIDENT_STATUS).map(([k, l]) => <option key={k} value={k}>{l.label}</option>)}</Select>
          <Select value={f.severity} onChange={(e) => upd("severity", e.target.value)} aria-label={t("accidents.severity")}><option value="">{t("accidents.allSeverities")}</option>{Object.entries(ACCIDENT_SEVERITY).map(([k, l]) => <option key={k} value={k}>{l.label}</option>)}</Select>
          <Select value={f.open} onChange={(e) => upd("open", e.target.value)} aria-label={t("accidents.open")}><option value="">{t("common.all")}</option><option value="true">{t("accidents.notClosedOnly")}</option></Select>
          {projects.length > 0 && <ProjectSelect value={f.projectId} onChange={(v) => upd("projectId", v)} projects={projects} />}
          <DateRange from={f.from} to={f.to} onFrom={(v) => upd("from", v)} onTo={(v) => upd("to", v)} />
        </FilterBar>
      )}
      <ListBody loading={loading} error={error} hasData={!!data} cols={7} empty={data && !data.data.length ? <EmptyState icon="alert" title={view === "all" ? t("accidents.noAccidents") : t("accidentFlow.empty.tab")} /> : null}>
        {data && (
        <>
          <DataList rows={data.data} rowKey={(r) => r.id} sort={list.sort} onSortChange={list.setSort} preview={{ title: (r) => <span className="ltr">{r.label} · {r.plateNumber}</span>, href: (r) => `/accidents/${r.id}` }} columns={[
            { header: t("accidents.accident"), primary: true, cell: (r) => <span className="flex flex-wrap items-center gap-x-2 gap-y-1"><Link to={`/accidents/${r.id}`} onClick={(e) => e.stopPropagation()} className="font-semibold ltr hover:text-brand-700">{r.label}</Link><span className="ltr">{r.plateNumber}</span><CaseFlags row={r} /></span>, sortKey: "number", sortFirst: "desc" },
            { header: t("common.time"), cell: (r) => formatDateTime(r.occurredAt), sortKey: "occurredAt", sortFirst: "desc" },
            { header: t("accidents.severity"), cell: (r) => <StatusBadge map={ACCIDENT_SEVERITY} value={r.severity} />, sortKey: "severity", sortFirst: "desc" },
            { header: t("common.status"), cell: (r) => r.workflowStage ? <StageBadge stage={r.workflowStage} /> : <StatusBadge map={ACCIDENT_STATUS} value={r.status} />, sortKey: "status" },
            ...(workflow ? [{ header: t("accidentFlow.list.assignee"), cell: (r: AccidentRow) => r.workflowStage && r.workflowStage !== "CLOSED" && r.workflowStage !== "DRAFT" ? (r.assignedToName ?? <span className="text-xs text-slate-400">{nextActionLabel(r.workflowStage)}</span>) : "—", hideOnMobile: true }] : []),
            { header: t("common.driver"), cell: (r) => r.driverName ?? "—", hideOnMobile: true, sortKey: "driverName" },
            { header: t("common.project"), cell: (r) => r.projectName ?? "—", hideOnMobile: true, sortKey: "projectName" },
            { header: t("accidents.repairCost"), cell: (r) => <Money value={r.repairCost} />, hideOnMobile: true, sortKey: "repairCost", sortFirst: "desc" },
          ]} />
          <Pagination {...data.meta} onPage={list.setPage} />
        </>
        )}
      </ListBody>
      <ReportAccidentModal open={adding} onClose={() => setAdding(false)} onCreated={(id) => navigate(`/accidents/${id}`)} vehicleId={vehicleId} />
    </Card>
  );
}

export function AccidentsPage() {
  const { can } = useAuth();
  const { workflow } = useAccidentFeatures();
  // Tabs belong to the workflow and depend on the user's permissions; the server decides what each returns.
  const tabs = accidentTabs(can, workflow);
  return (
    <>
      <PageHeader title={t("common.accidents")} subtitle={t("accidents.openUnderReviewInsuranceRepair")} actions={workflow && (can("accidents.assign") || can("accidents.settings.manage")) ? <Link to="/accidents/settings"><Button variant="secondary" icon="settings">{t("accidentFlow.admin.entry")}</Button></Link> : undefined} />
      <AccidentKpis workflow={workflow} showDrafts={tabs.some((x) => x.key === "drafts")} />
      <AccidentsList tabs={tabs} />
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

function LegacyAccidentDetail() {
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

/** One route for both kinds: workflow cases (and the workflow switch on) get the case screen, legacy accidents keep theirs. */
export function AccidentDetailPage() {
  const { id } = useParams();
  const { workflow, loading: featuresLoading } = useAccidentFeatures();
  const { data, loading, error } = useApi<{ data: { workflowStage: string | null } }>(`/accidents/${id}`);
  if (featuresLoading || loading) return <Loading />;
  if (error || !data) return <Alert>{error?.message ?? t("common.couldNotLoad")}</Alert>;
  return workflow && data.data.workflowStage ? <CaseDetailPage /> : <LegacyAccidentDetail />;
}
