import { useRef, useState } from "react";
import { Link, useNavigate, useSearchParams } from "react-router";
import { useToast } from "../../../components/feedback";
import { Icon } from "../../../components/icons";
import { BackLink, localToIso, nowLocalInput, ProjectSelect, useProjects, useVehicles, VehicleSelect } from "../../../components/shared";
import { Alert, Badge, Button, Card, CardHeader, Field, Input, Loading, PageHeader, Select, Textarea } from "../../../components/ui";
import { useApi } from "../../../hooks/useApi";
import { t } from "../../../i18n";
import { api, apiUpload, type Paged } from "../../../lib/api";
import { docLabel, draftBody, missingFromError, REQUIRED_DOCS, requirementText } from "../../../lib/accidentWorkflow";
import { useAuth } from "../../../lib/auth";
import { errorMessage, fieldErrors } from "../../../lib/forms";
import { ACCIDENT_SEVERITY, RESPONSIBILITY } from "../../../lib/labels";
import type { DriverRow } from "../../../lib/types";
import { useAccidentFeatures } from "./useAccidentFeatures";

/**
 * Report an accident (inside the Accidents section, /accidents/new). The report is first saved as a draft, then
 * submitted when the four required documents are there. A driver files a preliminary report that the project manager completes.
 * Everything shown here is checked again by the server; nothing is submitted from the screen alone.
 */
export function AccidentFormPage() {
  const { can } = useAuth();
  const navigate = useNavigate();
  const toast = useToast();
  const [params] = useSearchParams();
  const { workflow, loading: featuresLoading } = useAccidentFeatures();
  // A driver (own records only) files a preliminary report; project-wide users can complete and submit.
  const staff = can("accidents.create", "PROJECT");
  const canSubmit = can("accidents.update", "PROJECT");
  const projects = useProjects();
  const [projectId, setProjectId] = useState("");
  const vehicles = useVehicles(projectId ? { projectId } : {});
  const [v, setV] = useState({ vehicleId: params.get("vehicleId") ?? "", driverId: "", occurredAt: nowLocalInput(), location: "", description: "", severity: "MINOR", responsibility: "UNKNOWN", policeReportNumber: "" });
  const drivers = useApi<Paged<DriverRow>>(staff && can("drivers.read") && projectId ? "/drivers" : null, { projectId, pageSize: 100 }).data?.data ?? [];
  const [geo, setGeo] = useState<{ lat: number; lng: number } | null>(null);
  const [files, setFiles] = useState<Partial<Record<string, File>>>({});
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [error, setError] = useState<string | null>(null);
  const [missingServer, setMissingServer] = useState<string[] | null>(null);
  const [busy, setBusy] = useState<"draft" | "submit" | null>(null);
  const pickers = useRef<Record<string, HTMLInputElement | null>>({});
  const set = (k: keyof typeof v) => (e: { target: { value: string } }) => setV((s) => ({ ...s, [k]: e.target.value }));
  const missing = REQUIRED_DOCS.filter((c) => !files[c]);
  const locate = () => navigator.geolocation?.getCurrentPosition((p) => setGeo({ lat: Number(p.coords.latitude.toFixed(6)), lng: Number(p.coords.longitude.toFixed(6)) }), () => toast.error(t("accidents.couldNotGetTheLocation")), { enableHighAccuracy: true, timeout: 10000 });

  if (featuresLoading) return <Loading />;
  // The workflow is off: this screen does not exist (the legacy dialog on the accidents list is used instead).
  if (!workflow || !can("accidents.create")) return <Alert tone="amber">{t("accidentFlow.form.unavailable")} <Link className="text-brand-700 underline" to="/accidents">{t("common.accidents")}</Link></Alert>;

  const validate = () => {
    const e: Record<string, string> = {};
    if (!v.vehicleId) e.vehicleId = t("common.selectAVehicle2");
    if (v.description.trim().length < 3) e.description = t("accidents.describeTheAccident");
    if (!v.occurredAt) e.occurredAt = t("accidentFlow.form.timeRequired");
    setErrors(e);
    return Object.keys(e).length === 0;
  };

  /** Saves the draft, files the chosen documents, and (when asked and complete) submits. */
  const save = async (submit: boolean) => {
    setError(null);
    setMissingServer(null);
    if (!validate()) return;
    if (submit && missing.length) {
      setMissingServer(missing.map((c) => `attachment:${c}`));
      return;
    }
    setBusy(submit ? "submit" : "draft");
    try {
      const r = await api<{ data: { id: string } }>("/accident-cases", { method: "POST", body: draftBody({ ...v, driverId: staff ? v.driverId : "" }, localToIso, geo) });
      const id = r.data.id;
      const failed: string[] = [];
      for (const [cat, file] of Object.entries(files)) {
        if (!file) continue;
        try {
          await apiUpload(`/accident-cases/${id}/attachments?category=${cat}`, file, fetch, "POST");
        } catch {
          failed.push(cat);
        }
      }
      if (failed.length) toast.error(t("accidentFlow.form.uploadFailed", { docs: failed.map(docLabel).join(", ") }));
      if (submit && !failed.length) {
        try {
          await api(`/accident-cases/${id}/submit`, { method: "POST" });
          toast.success(t("accidentFlow.form.submitted"));
        } catch (err) {
          toast.error(missingFromError(err) ? t("accidentFlow.form.savedNotSubmitted") : errorMessage(err));
        }
      } else if (!failed.length) {
        toast.success(staff ? t("accidentFlow.form.draftSaved") : t("accidentFlow.form.preliminarySaved"));
      }
      navigate(`/accidents/${id}`);
    } catch (err) {
      setErrors(fieldErrors(err));
      setError(errorMessage(err));
      setBusy(null);
    }
  };

  return (
    <>
      <PageHeader back={<BackLink to="/accidents" label={t("common.accidents")} />} title={t("accidentFlow.form.title")} subtitle={staff ? t("accidentFlow.form.subtitleStaff") : t("accidentFlow.form.subtitleDriver")} />
      <div className="mx-auto max-w-3xl space-y-6">
        {error && <Alert>{error}</Alert>}
        {!staff && <Alert tone="blue">{t("accidentFlow.form.driverNote")}</Alert>}
        <Card>
          <CardHeader title={t("accidentFlow.form.details")} />
          <div className="space-y-4 p-5">
            <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
              {projects.length > 0 && (
                <Field label={t("common.project")} htmlFor="f-project">
                  <ProjectSelect id="f-project" value={projectId} onChange={(x) => { setProjectId(x); setV((s) => ({ ...s, vehicleId: "", driverId: "" })); }} projects={projects} all={t("accidentFlow.form.allProjects")} />
                </Field>
              )}
              <Field label={t("common.vehicle")} required error={errors.vehicleId} htmlFor="f-vehicle">
                <VehicleSelect id="f-vehicle" value={v.vehicleId} onChange={(x) => setV((s) => ({ ...s, vehicleId: x }))} vehicles={vehicles.filter((x) => x.status !== "ARCHIVED")} all={t("common.selectAVehicle3")} />
              </Field>
              {staff && can("drivers.read") && (
                <Field label={t("common.driver")} hint={projectId ? t("accidentFlow.form.driverDefault") : t("accidentFlow.form.driverNeedsProject")} htmlFor="f-driver">
                  <Select id="f-driver" value={v.driverId} onChange={set("driverId")} disabled={!projectId}>
                    <option value="">{t("accidentFlow.form.vehicleDriver")}</option>
                    {drivers.map((d) => <option key={d.id} value={d.id}>{d.fullName}</option>)}
                  </Select>
                </Field>
              )}
              <Field label={t("accidents.accidentTime")} required error={errors.occurredAt} htmlFor="f-at"><Input id="f-at" type="datetime-local" value={v.occurredAt} onChange={set("occurredAt")} /></Field>
              <Field label={t("accidents.severity")} required htmlFor="f-sev"><Select id="f-sev" value={v.severity} onChange={set("severity")}>{Object.entries(ACCIDENT_SEVERITY).map(([k, l]) => <option key={k} value={k}>{l.label}</option>)}</Select></Field>
              <Field label={t("accidents.responsibility")} htmlFor="f-resp"><Select id="f-resp" value={v.responsibility} onChange={set("responsibility")}>{Object.entries(RESPONSIBILITY).map(([k, l]) => <option key={k} value={k}>{l}</option>)}</Select></Field>
              <Field label={t("accidents.trafficNajmReportNumber")} htmlFor="f-police"><Input id="f-police" dir="ltr" value={v.policeReportNumber} onChange={set("policeReportNumber")} /></Field>
            </div>
            <Field label={t("accidents.location")} htmlFor="f-loc">
              <div className="flex gap-2"><Input id="f-loc" value={v.location} onChange={set("location")} /><Button variant="secondary" icon="pin" onClick={locate}>{t("accidents.myLocation")}</Button></div>
              {geo && <p className="mt-1 text-xs text-emerald-700 ltr">{geo.lat}, {geo.lng}</p>}
            </Field>
            <Field label={t("accidents.accidentDescription")} required error={errors.description} htmlFor="f-desc"><Textarea id="f-desc" rows={4} value={v.description} onChange={set("description")} /></Field>
          </div>
        </Card>
        <Card>
          <CardHeader title={t("accidentFlow.form.requiredDocs")} subtitle={t("accidentFlow.form.requiredDocsHint")} />
          <ul className="divide-y divide-slate-100">
            {REQUIRED_DOCS.map((c) => {
              const f = files[c];
              return (
                <li key={c} className="flex flex-wrap items-center justify-between gap-3 px-5 py-3 text-sm">
                  <div className="flex min-w-0 items-center gap-2">
                    <Icon name={f ? "check" : "file"} className={f ? "size-4 text-emerald-600" : "size-4 text-slate-400"} />
                    <span className="font-medium text-slate-800">{docLabel(c)}</span>
                    {f ? <Badge tone="green">{t("accidentFlow.form.chosen")}</Badge> : <Badge tone="amber">{t("accidentFlow.doc.missingBadge")}</Badge>}
                    {f && <span className="truncate text-xs text-slate-500 ltr">{f.name}</span>}
                  </div>
                  <div className="flex items-center gap-2">
                    <input ref={(el) => { pickers.current[c] = el; }} type="file" accept="application/pdf,image/png,image/jpeg,image/webp" capture="environment" className="hidden" data-testid={`doc-${c}`} onChange={(e) => { const file = e.target.files?.[0]; if (file) setFiles((s) => ({ ...s, [c]: file })); }} />
                    <Button variant="secondary" icon="camera" onClick={() => pickers.current[c]?.click()}>{f ? t("accidentFlow.doc.replace") : t("accidents.attach")}</Button>
                    {f && <Button variant="ghost" icon="x" aria-label={t("accidentFlow.form.removeFile")} onClick={() => setFiles((s) => { const n = { ...s }; delete n[c]; return n; })} />}
                  </div>
                </li>
              );
            })}
          </ul>
          {missingServer && (
            <div className="px-5 pb-5"><Alert tone="amber"><p className="mb-1 font-medium">{t("accidentFlow.form.cannotSubmit")}</p><ul className="list-disc ps-5">{missingServer.map((m) => <li key={m}>{requirementText(m)}</li>)}</ul></Alert></div>
          )}
        </Card>
        <div className="sticky bottom-0 -mx-4 flex flex-wrap items-center justify-end gap-2 border-t border-slate-200 bg-white/95 px-4 py-3 backdrop-blur sm:static sm:mx-0 sm:border-0 sm:bg-transparent sm:p-0">
          <Link to="/accidents"><Button variant="secondary">{t("common.cancel")}</Button></Link>
          {canSubmit ? (
            <>
              <Button variant="secondary" loading={busy === "draft"} disabled={busy !== null} onClick={() => void save(false)}>{t("accidentFlow.form.saveDraft")}</Button>
              <Button variant="danger" loading={busy === "submit"} disabled={busy !== null} onClick={() => void save(true)}>{t("accidentFlow.form.submit")}</Button>
            </>
          ) : (
            <Button variant="danger" loading={busy === "draft"} disabled={busy !== null} onClick={() => void save(false)}>{staff ? t("accidentFlow.form.saveDraft") : t("accidentFlow.form.sendPreliminary")}</Button>
          )}
        </div>
      </div>
    </>
  );
}
