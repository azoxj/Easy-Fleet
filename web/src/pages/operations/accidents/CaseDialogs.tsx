import { useEffect, useState } from "react";
import { Alert, Button, Field, Input, Loading, Modal, Select, Textarea } from "../../../components/ui";
import { useApi } from "../../../hooks/useApi";
import { t } from "../../../i18n";
import { api } from "../../../lib/api";
import { missingFromError, REOPEN_TARGETS, requirementText, returnTargetsFrom, stageLabel, type CaseDetail, type WorkflowStage } from "../../../lib/accidentWorkflow";
import { errorMessage } from "../../../lib/forms";
import { ACCIDENT_SEVERITY, RESPONSIBILITY } from "../../../lib/labels";

/** Closing, returning and reopening: one dialog, three modes. The server validates the move and its requirements. */
export function MoveDialog({ mode, c, onClose, onDone }: { mode: "close" | "return" | "reopen" | null; c: CaseDetail; onClose: () => void; onDone: () => void }) {
  const targets: WorkflowStage[] = mode === "return" ? returnTargetsFrom(c.workflowStage) : REOPEN_TARGETS;
  const [to, setTo] = useState<string>("");
  const [text, setText] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [missing, setMissing] = useState<string[] | null>(null);
  useEffect(() => {
    if (mode) {
      setTo(mode === "return" ? (returnTargetsFrom(c.workflowStage)[0] ?? "") : mode === "reopen" ? "AWAITING_FINAL_CLOSURE" : "CLOSED");
      setText("");
      setError(null);
      setMissing(null);
    }
  }, [mode, c.workflowStage]);
  if (!mode) return null;
  // What the server says is still missing for closing (the resolution is typed here).
  const closeMissing = mode === "close" ? (c.requirements.find((r) => r.to === "CLOSED")?.missing ?? []).filter((m) => m !== "resolution") : [];
  const submit = async () => {
    setBusy(true);
    setError(null);
    setMissing(null);
    try {
      await api(`/accident-cases/${c.id}/transition`, { method: "POST", body: mode === "close" ? { to: "CLOSED", resolution: text.trim() } : { to, reason: text.trim() } });
      onDone();
      onClose();
    } catch (err) {
      const m = missingFromError(err);
      if (m) setMissing(m);
      else setError(errorMessage(err));
    } finally {
      setBusy(false);
    }
  };
  const need = 3;
  const title = mode === "close" ? t("accidentFlow.dialog.closeTitle") : mode === "return" ? t("accidentFlow.dialog.returnTitle") : t("accidentFlow.dialog.reopenTitle");
  return (
    <Modal open onClose={onClose} title={title} footer={<><Button variant="secondary" onClick={onClose}>{t("common.cancel")}</Button><Button variant={mode === "close" ? "primary" : "danger"} loading={busy} disabled={text.trim().length < need || (mode !== "close" && !to)} onClick={() => void submit()}>{t("common.confirm")}</Button></>}>
      <div className="space-y-4">
        {error && <Alert>{error}</Alert>}
        {mode === "close" && <Alert tone="blue">{t("accidentFlow.dialog.closeNote")}</Alert>}
        {closeMissing.length > 0 && <MissingList items={closeMissing} />}
        {missing && <MissingList items={missing} />}
        {mode !== "close" && (
          <Field label={mode === "return" ? t("accidentFlow.dialog.returnTo") : t("accidentFlow.dialog.reopenTo")} htmlFor="mv-to">
            <Select id="mv-to" value={to} onChange={(e) => setTo(e.target.value)}>{targets.map((s) => <option key={s} value={s}>{stageLabel(s)}</option>)}</Select>
          </Field>
        )}
        <Field label={mode === "close" ? t("accidents.decisionOutcomeRequired") : t("accidentFlow.dialog.reasonRequired")} hint={mode === "return" ? t("accidentFlow.dialog.returnHint") : undefined} required htmlFor="mv-text">
          <Textarea id="mv-text" rows={4} value={text} onChange={(e) => setText(e.target.value)} maxLength={mode === "close" ? 2000 : 1000} />
        </Field>
      </div>
    </Modal>
  );
}

/** What the server says is missing before a step, as a list the user can act on. */
export function MissingList({ items }: { items: string[] }) {
  if (!items.length) return null;
  return (
    <Alert tone="amber">
      <p className="mb-1 font-medium">{t("accidentFlow.missing.title")}</p>
      <ul className="list-disc space-y-0.5 ps-5">{items.map((m) => <li key={m}>{requirementText(m)}</li>)}</ul>
    </Alert>
  );
}

/** Manual assignment and reassignment: the server offers who may be chosen for this stage. */
export function AssignDialog({ open, c, onClose, onDone }: { open: boolean; c: CaseDetail; onClose: () => void; onDone: () => void }) {
  const { data, loading, error } = useApi<{ data: { id: string; name: string; designated: boolean }[] }>(open ? `/accident-cases/${c.id}/assignable` : null);
  const [userId, setUserId] = useState("");
  const [reason, setReason] = useState("");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  useEffect(() => {
    if (open) {
      setUserId("");
      setReason("");
      setErr(null);
    }
  }, [open]);
  const people = data?.data ?? [];
  const submit = async () => {
    setBusy(true);
    setErr(null);
    try {
      await api(`/accident-cases/${c.id}/assign`, { method: "POST", body: { userId, ...(reason.trim() ? { reason: reason.trim() } : {}) } });
      onDone();
      onClose();
    } catch (e) {
      setErr(errorMessage(e));
    } finally {
      setBusy(false);
    }
  };
  return (
    <Modal open={open} onClose={onClose} title={c.assignedToName ? t("accidentFlow.dialog.reassignTitle") : t("accidentFlow.dialog.assignTitle")} footer={<><Button variant="secondary" onClick={onClose}>{t("common.cancel")}</Button><Button loading={busy} disabled={!userId} onClick={() => void submit()}>{t("accidentFlow.dialog.assignConfirm")}</Button></>}>
      <div className="space-y-4">
        {err && <Alert>{err}</Alert>}
        {c.assignedToName && <p className="text-sm text-slate-600">{t("accidentFlow.dialog.currentAssignee", { name: c.assignedToName })}</p>}
        {loading ? <Loading /> : error ? <Alert>{error.message}</Alert> : people.length === 0 ? <Alert tone="amber">{t("accidentFlow.dialog.nobodyToAssign")}</Alert> : (
          <Field label={t("accidentFlow.dialog.assignTo")} required htmlFor="as-user">
            <Select id="as-user" value={userId} onChange={(e) => setUserId(e.target.value)}>
              <option value="">{t("accidentFlow.dialog.chooseEmployee")}</option>
              {people.map((p) => <option key={p.id} value={p.id}>{p.name}{p.designated ? ` — ${t("accidentFlow.dialog.designated")}` : ""}</option>)}
            </Select>
          </Field>
        )}
        <Field label={t("accidentFlow.dialog.reasonOptional")} htmlFor="as-reason"><Input id="as-reason" value={reason} onChange={(e) => setReason(e.target.value)} maxLength={500} /></Field>
      </div>
    </Modal>
  );
}

/** Editing the draft's details (creator, or the project manager completing it). */
export function EditDraftDialog({ open, c, onClose, onDone }: { open: boolean; c: CaseDetail; onClose: () => void; onDone: () => void }) {
  const [v, setV] = useState({ location: "", description: "", severity: "MINOR", responsibility: "UNKNOWN", policeReportNumber: "" });
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  useEffect(() => {
    if (open) {
      setV({ location: c.location ?? "", description: c.description, severity: c.severity, responsibility: c.responsibility, policeReportNumber: c.policeReportNumber ?? "" });
      setErr(null);
    }
  }, [open, c]);
  const submit = async () => {
    setBusy(true);
    setErr(null);
    try {
      await api(`/accident-cases/${c.id}`, { method: "PATCH", body: { description: v.description.trim(), severity: v.severity, responsibility: v.responsibility, location: v.location.trim() || null, policeReportNumber: v.policeReportNumber.trim() || null } });
      onDone();
      onClose();
    } catch (e) {
      setErr(errorMessage(e));
    } finally {
      setBusy(false);
    }
  };
  return (
    <Modal open={open} onClose={onClose} title={t("accidentFlow.dialog.editTitle")} footer={<><Button variant="secondary" onClick={onClose}>{t("common.cancel")}</Button><Button loading={busy} disabled={v.description.trim().length < 3} onClick={() => void submit()}>{t("common.save")}</Button></>}>
      <div className="space-y-4">
        {err && <Alert>{err}</Alert>}
        <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
          <Field label={t("accidents.severity")} htmlFor="ed-sev"><Select id="ed-sev" value={v.severity} onChange={(e) => setV({ ...v, severity: e.target.value })}>{Object.entries(ACCIDENT_SEVERITY).map(([k, l]) => <option key={k} value={k}>{l.label}</option>)}</Select></Field>
          <Field label={t("accidents.responsibility")} htmlFor="ed-resp"><Select id="ed-resp" value={v.responsibility} onChange={(e) => setV({ ...v, responsibility: e.target.value })}>{Object.entries(RESPONSIBILITY).map(([k, l]) => <option key={k} value={k}>{l}</option>)}</Select></Field>
          <Field label={t("accidents.trafficNajmReportNumber")} htmlFor="ed-police"><Input id="ed-police" dir="ltr" value={v.policeReportNumber} onChange={(e) => setV({ ...v, policeReportNumber: e.target.value })} /></Field>
          <Field label={t("accidents.location")} htmlFor="ed-loc"><Input id="ed-loc" value={v.location} onChange={(e) => setV({ ...v, location: e.target.value })} /></Field>
        </div>
        <Field label={t("accidents.accidentDescription")} required htmlFor="ed-desc"><Textarea id="ed-desc" rows={4} value={v.description} onChange={(e) => setV({ ...v, description: e.target.value })} /></Field>
      </div>
    </Modal>
  );
}
