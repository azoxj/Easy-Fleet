import { useEffect, useState } from "react";
import { Link } from "react-router";
import { useToast } from "../../../components/feedback";
import { BackLink, useProjects } from "../../../components/shared";
import { Alert, Badge, Button, Card, CardHeader, Field, Input, Loading, Modal, PageHeader, Select } from "../../../components/ui";
import { useApi } from "../../../hooks/useApi";
import { t } from "../../../i18n";
import { api } from "../../../lib/api";
import { useAuth } from "../../../lib/auth";
import { errorMessage } from "../../../lib/forms";
import { useAccidentFeatures } from "./useAccidentFeatures";

type Stage = "TECHNICAL" | "INSURANCE";
type Officer = { id: string; stage: Stage; userId: string; userName: string; userStatus: string; projectId: string | null; projectName: string | null };
type Candidate = { id: string; name: string; member: boolean };
const STAGES: Stage[] = ["TECHNICAL", "INSURANCE"];
const stageName = (s: Stage) => (s === "TECHNICAL" ? t("accidentFlow.admin.stageTechnical") : t("accidentFlow.admin.stageInsurance"));

/**
 * Accident officers and delay limits. Inside the Accidents section (/accidents/settings). Officers need accidents.assign;
 * the delay limits are changed only with accidents.settings.manage (the server decides and says so in `canEdit`).
 * The lists of who may be chosen come from the server and the server refuses anyone without the stage's permission.
 */
export function AccidentSettingsPage() {
  const { can } = useAuth();
  const { workflow, loading } = useAccidentFeatures();
  if (loading) return <Loading />;
  const assign = can("accidents.assign");
  if (!workflow || (!assign && !can("accidents.settings.manage"))) return <Alert tone="amber">{t("accidentFlow.admin.unavailable")} <Link className="text-brand-700 underline" to="/accidents">{t("common.accidents")}</Link></Alert>;
  return (
    <>
      <PageHeader back={<BackLink to="/accidents" label={t("common.accidents")} />} title={t("accidentFlow.admin.title")} subtitle={t("accidentFlow.admin.subtitle")} />
      <div className="space-y-6">
        {assign && <OfficersPanel />}
        <SlaPanel />
      </div>
    </>
  );
}

function OfficersPanel() {
  const { can } = useAuth();
  const toast = useToast();
  const projects = useProjects();
  const allProjects = can("accidents.assign", "ALL");
  const { data, loading, error, reload } = useApi<{ data: Officer[] }>("/accident-cases/officers");
  const [stage, setStage] = useState<Stage>("TECHNICAL");
  const [projectId, setProjectId] = useState("");
  const [userId, setUserId] = useState("");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const scopeReady = allProjects || projectId !== "";
  const candidates = useApi<{ data: Candidate[] }>(scopeReady ? "/accident-cases/officers/candidates" : null, { stage, projectId: projectId || undefined });
  const [replacing, setReplacing] = useState<Officer | null>(null);
  const [removing, setRemoving] = useState<Officer | null>(null);
  useEffect(() => setUserId(""), [stage, projectId]);
  const officers = data?.data ?? [];
  const people = candidates.data?.data ?? [];
  const duplicate = officers.some((o) => o.stage === stage && (o.projectId ?? "") === projectId && o.userId === userId);

  const add = async () => {
    setBusy(true);
    setErr(null);
    try {
      await api("/accident-cases/officers", { method: "POST", body: { stage, userId, ...(projectId ? { projectId } : {}) } });
      toast.success(t("accidentFlow.admin.designated"));
      setUserId("");
      reload();
    } catch (e) {
      setErr(errorMessage(e));
    } finally {
      setBusy(false);
    }
  };
  const remove = async () => {
    if (!removing) return;
    setBusy(true);
    try {
      await api(`/accident-cases/officers/${removing.id}`, { method: "DELETE" });
      toast.success(t("accidentFlow.admin.removed"));
      setRemoving(null);
      reload();
    } catch (e) {
      toast.error(errorMessage(e));
    } finally {
      setBusy(false);
    }
  };
  // Several officers at the same level send the case to the queue: say so.
  const crowded = new Set(officers.filter((o) => officers.filter((x) => x.stage === o.stage && x.projectId === o.projectId).length > 1).map((o) => `${o.stage}|${o.projectId ?? ""}`));

  return (
    <Card>
      <CardHeader title={t("accidentFlow.admin.officers")} subtitle={t("accidentFlow.admin.officersHint")} />
      <div className="space-y-6 p-5">
        {loading && !data ? <Loading /> : error ? <Alert>{error.message}</Alert> : (
          STAGES.map((s) => {
            const rows = officers.filter((o) => o.stage === s);
            return (
              <section key={s} aria-label={stageName(s)} data-stage={s}>
                <h3 className="mb-2 text-sm font-semibold text-slate-800">{stageName(s)}</h3>
                {rows.length === 0 ? <p className="rounded-lg bg-amber-50 px-3 py-2 text-sm text-amber-800">{t("accidentFlow.admin.noOfficers")}</p> : (
                  <ul className="divide-y divide-slate-100 rounded-lg border border-slate-200">
                    {rows.map((o) => (
                      <li key={o.id} className="flex flex-wrap items-center justify-between gap-2 px-4 py-3 text-sm" data-officer={o.id}>
                        <div className="min-w-0">
                          <p className="flex flex-wrap items-center gap-2 font-medium text-slate-800">{o.userName}{o.userStatus !== "ACTIVE" && <Badge tone="red">{t("accidentFlow.admin.disabledUser")}</Badge>}{crowded.has(`${o.stage}|${o.projectId ?? ""}`) && <Badge tone="amber">{t("accidentFlow.admin.sharedLevel")}</Badge>}</p>
                          <p className="text-xs text-slate-500">{o.projectName ?? t("accidentFlow.admin.allProjects")}</p>
                        </div>
                        <div className="flex gap-2">
                          <Button variant="secondary" icon="edit" onClick={() => setReplacing(o)}>{t("accidentFlow.admin.change")}</Button>
                          <Button variant="ghost" icon="trash" onClick={() => setRemoving(o)}>{t("accidentFlow.admin.remove")}</Button>
                        </div>
                      </li>
                    ))}
                  </ul>
                )}
              </section>
            );
          })
        )}
        <div className="space-y-4 border-t border-slate-100 pt-5">
          <p className="text-sm font-medium text-slate-700">{t("accidentFlow.admin.addTitle")}</p>
          {err && <Alert>{err}</Alert>}
          <div className="grid grid-cols-1 gap-4 sm:grid-cols-3">
            <Field label={t("accidentFlow.admin.stage")} htmlFor="of-stage"><Select id="of-stage" value={stage} onChange={(e) => setStage(e.target.value as Stage)}>{STAGES.map((s) => <option key={s} value={s}>{stageName(s)}</option>)}</Select></Field>
            <Field label={t("common.project")} htmlFor="of-project" hint={allProjects ? undefined : t("accidentFlow.admin.projectRequired")}>
              <Select id="of-project" value={projectId} onChange={(e) => setProjectId(e.target.value)}>
                {allProjects ? <option value="">{t("accidentFlow.admin.allProjects")}</option> : <option value="">{t("accidentFlow.admin.chooseProject")}</option>}
                {projects.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}
              </Select>
            </Field>
            <Field label={t("accidentFlow.admin.employee")} htmlFor="of-user">
              <Select id="of-user" value={userId} onChange={(e) => setUserId(e.target.value)} disabled={!scopeReady}>
                <option value="">{t("accidentFlow.dialog.chooseEmployee")}</option>
                {people.map((p) => <option key={p.id} value={p.id}>{p.name}{p.member ? ` — ${t("accidentFlow.admin.projectMember")}` : ""}</option>)}
              </Select>
            </Field>
          </div>
          {scopeReady && !candidates.loading && people.length === 0 && <Alert tone="amber">{t("accidentFlow.admin.noCandidates", { stage: stageName(stage) })}</Alert>}
          {duplicate && <p className="text-xs text-amber-700">{t("accidentFlow.admin.alreadyThere")}</p>}
          <Button loading={busy} disabled={!userId || duplicate || !scopeReady} onClick={() => void add()}>{t("accidentFlow.admin.designate")}</Button>
        </div>
      </div>
      <ReplaceDialog officer={replacing} onClose={() => setReplacing(null)} onDone={() => { setReplacing(null); reload(); }} />
      <Modal open={!!removing} onClose={() => setRemoving(null)} title={t("accidentFlow.admin.removeTitle")} footer={<><Button variant="secondary" onClick={() => setRemoving(null)}>{t("common.cancel")}</Button><Button variant="danger" loading={busy} onClick={() => void remove()}>{t("accidentFlow.admin.removeConfirm")}</Button></>}>
        {removing && <p className="text-sm text-slate-700">{t("accidentFlow.admin.removeText", { name: removing.userName, stage: stageName(removing.stage), project: removing.projectName ?? t("accidentFlow.admin.allProjects") })}</p>}
      </Modal>
    </Card>
  );
}

function ReplaceDialog({ officer, onClose, onDone }: { officer: Officer | null; onClose: () => void; onDone: () => void }) {
  const toast = useToast();
  const candidates = useApi<{ data: Candidate[] }>(officer ? "/accident-cases/officers/candidates" : null, { stage: officer?.stage, projectId: officer?.projectId ?? undefined });
  const [userId, setUserId] = useState("");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  useEffect(() => { setUserId(""); setErr(null); }, [officer?.id]);
  const people = (candidates.data?.data ?? []).filter((p) => p.id !== officer?.userId);
  const save = async () => {
    if (!officer) return;
    setBusy(true);
    setErr(null);
    try {
      await api(`/accident-cases/officers/${officer.id}`, { method: "PUT", body: { userId } });
      toast.success(t("accidentFlow.admin.changed"));
      onDone();
    } catch (e) {
      setErr(errorMessage(e));
    } finally {
      setBusy(false);
    }
  };
  return (
    <Modal open={!!officer} onClose={onClose} title={t("accidentFlow.admin.changeTitle")} footer={<><Button variant="secondary" onClick={onClose}>{t("common.cancel")}</Button><Button loading={busy} disabled={!userId} onClick={() => void save()}>{t("accidentFlow.admin.changeConfirm")}</Button></>}>
      {officer && (
        <div className="space-y-4">
          {err && <Alert>{err}</Alert>}
          <p className="text-sm text-slate-600">{t("accidentFlow.admin.changeText", { name: officer.userName, stage: stageName(officer.stage), project: officer.projectName ?? t("accidentFlow.admin.allProjects") })}</p>
          {candidates.loading ? <Loading /> : people.length === 0 ? <Alert tone="amber">{t("accidentFlow.admin.noCandidates", { stage: stageName(officer.stage) })}</Alert> : (
            <Field label={t("accidentFlow.admin.newEmployee")} required htmlFor="of-new"><Select id="of-new" value={userId} onChange={(e) => setUserId(e.target.value)}><option value="">{t("accidentFlow.dialog.chooseEmployee")}</option>{people.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}</Select></Field>
          )}
        </div>
      )}
    </Modal>
  );
}

const SLA_FIELDS = [
  { key: "slaTechnicalDays", label: "accidentFlow.admin.slaTechnical" },
  { key: "slaEstimatesDays", label: "accidentFlow.admin.slaEstimates" },
  { key: "slaInsuranceDays", label: "accidentFlow.admin.slaInsurance" },
  { key: "slaClosureDays", label: "accidentFlow.admin.slaClosure" },
] as const;
type Sla = Record<(typeof SLA_FIELDS)[number]["key"], number> & { canEdit: boolean };

function SlaPanel() {
  const toast = useToast();
  const { data, loading, error, reload } = useApi<{ data: Sla }>("/accident-cases/settings");
  const [v, setV] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  useEffect(() => { if (data) setV(Object.fromEntries(SLA_FIELDS.map((f) => [f.key, String(data.data[f.key])]))); }, [data]);
  if (loading && !data) return <Card><Loading /></Card>;
  if (error || !data) return <Alert>{error?.message ?? t("common.couldNotLoad")}</Alert>;
  const canEdit = data.data.canEdit;
  const valid = SLA_FIELDS.every((f) => /^\d{1,2}$/.test(v[f.key] ?? "") && Number(v[f.key]) >= 1 && Number(v[f.key]) <= 90);
  const dirty = SLA_FIELDS.some((f) => Number(v[f.key]) !== data.data[f.key]);
  const save = async () => {
    setBusy(true);
    setErr(null);
    try {
      await api("/accident-cases/settings", { method: "PUT", body: Object.fromEntries(SLA_FIELDS.map((f) => [f.key, Number(v[f.key])])) });
      toast.success(t("accidentFlow.admin.slaSaved"));
      reload();
    } catch (e) {
      setErr(errorMessage(e));
    } finally {
      setBusy(false);
    }
  };
  return (
    <Card>
      <CardHeader title={t("accidentFlow.admin.sla")} subtitle={t("accidentFlow.admin.slaHint")} />
      <div className="space-y-4 p-5">
        {err && <Alert>{err}</Alert>}
        {!canEdit && <Alert tone="blue">{t("accidentFlow.admin.slaReadOnly")}</Alert>}
        <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
          {SLA_FIELDS.map((f) => (
            <Field key={f.key} label={t(f.label)} htmlFor={`sla-${f.key}`} hint={t("accidentFlow.admin.slaDays")}>
              <Input id={`sla-${f.key}`} type="number" inputMode="numeric" min={1} max={90} dir="ltr" disabled={!canEdit} value={v[f.key] ?? ""} onChange={(e) => setV({ ...v, [f.key]: e.target.value })} />
            </Field>
          ))}
        </div>
        {canEdit && <Button loading={busy} disabled={!valid || !dirty} onClick={() => void save()}>{t("common.save")}</Button>}
        {canEdit && !valid && <p className="text-xs text-red-600">{t("accidentFlow.admin.slaInvalid")}</p>}
      </div>
    </Card>
  );
}

