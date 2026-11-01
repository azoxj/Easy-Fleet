import { useEffect, useRef, useState } from "react";
import { Link } from "react-router";
import { useToast } from "../../../components/feedback";
import { Icon } from "../../../components/icons";
import { Money } from "../../../components/shared";
import { Alert, Badge, Button, Card, CardHeader, DescList, EmptyState, Field, Input, Modal, Select, Textarea } from "../../../components/ui";
import { t } from "../../../i18n";
import { api, fileUrl } from "../../../lib/api";
import {
  CLAIM_TONE,
  claimStatusLabel,
  docLabel,
  missingDocuments,
  missingFor,
  pendingMissing,
  REPAIR_DECISIONS,
  repairDecisionLabel,
  REQUIRED_DOCS,
  stageLabel,
  type CaseDetail,
  type CaseTransition,
} from "../../../lib/accidentWorkflow";
import { formatDate, formatDateTime } from "../../../lib/format";
import { ACCIDENT_SEVERITY, RESPONSIBILITY } from "../../../lib/labels";
import { MissingList } from "./CaseDialogs";
import { fileProblem, uploadToCase, useCaseRunner } from "./caseRunner";

type Runner = ReturnType<typeof useCaseRunner>;
const ACCEPT = "application/pdf,image/png,image/jpeg,image/webp";
const fileLink = (c: { id: string }, attId: string) => fileUrl(`/accident-cases/${c.id}/attachments/${attId}/file`);

export function InfoSection({ c }: { c: CaseDetail }) {
  return (
    <Card>
      <CardHeader title={t("accidentFlow.section.info")} />
      <div className="space-y-4 p-5">
        <p className="text-sm leading-7 text-slate-700">{c.description}</p>
        <DescList items={[
          { label: t("common.project"), value: c.projectName },
          { label: t("common.vehicle"), value: <Link className="text-brand-700 ltr" to={`/vehicles/${c.vehicleId}`}>{c.plateNumber}</Link> },
          { label: t("common.driver"), value: c.driverName },
          { label: t("accidents.accidentTime"), value: formatDateTime(c.occurredAt) },
          { label: t("accidents.severity"), value: ACCIDENT_SEVERITY[c.severity]?.label ?? c.severity },
          { label: t("accidents.responsibility"), value: RESPONSIBILITY[c.responsibility] },
          { label: t("accidents.location"), value: c.location },
          { label: t("common.coordinates"), value: c.latitude ? <a className="text-brand-700 ltr" target="_blank" rel="noreferrer noopener" href={`https://www.openstreetmap.org/?mlat=${c.latitude}&mlon=${c.longitude}#map=17/${c.latitude}/${c.longitude}`}>{c.latitude}, {c.longitude}</a> : null },
          { label: t("accidents.reportNumber"), value: c.policeReportNumber },
          { label: t("accidents.insuranceClaimNumber"), value: c.insuranceClaimNumber },
          { label: t("accidentFlow.info.approvedEstimate"), value: <Money value={c.repairCost} /> },
          { label: t("accidents.reportedBy"), value: c.createdByName },
        ]} />
        {c.resolution && <Alert tone="green">{t("accidents.decisionOutcome", { resolution: c.resolution })}</Alert>}
      </div>
    </Card>
  );
}

/** Files of the case. The server already left out whatever this user may not see: nothing is hidden here, nothing is guessed. */
export function DocumentsSection({ c, runner, onChanged }: { c: CaseDetail; runner: Runner; onChanged: () => void }) {
  const toast = useToast();
  const input = useRef<HTMLInputElement>(null);
  const [cat, setCat] = useState("");
  const pendingCat = useRef<string>("");
  const allowed = c.uploadCategories;
  const draft = c.workflowStage === "DRAFT";
  const stillMissing = missingDocuments(c);
  const active = c.attachments.filter((a) => !a.supersededAt);
  const history = c.attachments.filter((a) => a.supersededAt);
  useEffect(() => { if (!allowed.includes(cat)) setCat(allowed.find((x) => !REQUIRED_DOCS.includes(x as (typeof REQUIRED_DOCS)[number])) ?? allowed[0] ?? ""); }, [allowed, cat]);
  const pick = (category: string) => { pendingCat.current = category; input.current?.click(); };
  const upload = async (file: File | undefined) => {
    if (!file || !pendingCat.current) return;
    const problem = fileProblem(file);
    if (problem) return void toast.error(problem);
    const category = pendingCat.current;
    await runner.run(`upload-${category}`, () => uploadToCase(c.id, category, file), t("common.attachmentUploaded"));
    if (input.current) input.current.value = "";
    onChanged();
  };
  const canUpload = allowed.length > 0;
  return (
    <Card>
      <CardHeader
        title={t("accidentFlow.section.documents", { count: active.length })}
        action={canUpload && !draft ? (
          <div className="flex items-center gap-2">
            <Select value={cat} onChange={(e) => setCat(e.target.value)} aria-label={t("common.attachmentType")} className="w-44">{allowed.map((k) => <option key={k} value={k}>{docLabel(k)}</option>)}</Select>
            <Button variant="secondary" icon="camera" loading={runner.busy === `upload-${cat}`} disabled={!cat} onClick={() => pick(cat)}>{t("accidents.attach")}</Button>
          </div>
        ) : undefined}
      />
      <input ref={input} type="file" accept={ACCEPT} capture="environment" className="hidden" data-testid="case-file-input" onChange={(e) => void upload(e.target.files?.[0])} />
      {draft && (
        <div className="border-b border-slate-100 px-5 py-4">
          <p className="mb-2 text-sm font-medium text-slate-700">{t("accidentFlow.form.requiredDocs")}</p>
          <ul className="space-y-2">
            {REQUIRED_DOCS.map((k) => {
              const missing = stillMissing.includes(k);
              const file = active.find((a) => a.category === k);
              return (
                <li key={k} className="flex flex-wrap items-center justify-between gap-2 text-sm" data-doc={k} data-missing={missing}>
                  <span className="flex items-center gap-2">
                    <Icon name={missing ? "file" : "check"} className={missing ? "size-4 text-slate-400" : "size-4 text-emerald-600"} />
                    <span className="font-medium text-slate-800">{docLabel(k)}</span>
                    {missing ? <Badge tone="amber">{t("accidentFlow.doc.missingBadge")}</Badge> : <Badge tone="green">{t("accidentFlow.doc.attachedBadge")}</Badge>}
                    {file && <a className="text-xs text-brand-700 hover:underline" href={fileLink(c, file.id)} download>{file.fileName}</a>}
                  </span>
                  {allowed.includes(k) && <Button variant="secondary" icon="camera" loading={runner.busy === `upload-${k}`} onClick={() => pick(k)}>{missing ? t("accidents.attach") : t("accidentFlow.doc.replace")}</Button>}
                </li>
              );
            })}
          </ul>
        </div>
      )}
      {draft && canUpload && (
        <div className="flex items-center gap-2 border-b border-slate-100 px-5 py-3">
          <Select value={cat} onChange={(e) => setCat(e.target.value)} aria-label={t("common.attachmentType")} className="w-44">{allowed.filter((k) => !REQUIRED_DOCS.includes(k as (typeof REQUIRED_DOCS)[number])).map((k) => <option key={k} value={k}>{docLabel(k)}</option>)}</Select>
          <Button variant="secondary" icon="camera" disabled={!cat || REQUIRED_DOCS.includes(cat as (typeof REQUIRED_DOCS)[number])} onClick={() => pick(cat)}>{t("accidentFlow.doc.addOther")}</Button>
        </div>
      )}
      {active.length === 0 ? <EmptyState icon="file" title={t("common.noAttachments")} /> : (
        <ul className="divide-y divide-slate-100">
          {active.map((x) => (
            <li key={x.id} className="flex flex-wrap items-center justify-between gap-2 px-5 py-3 text-sm">
              <a className="flex min-w-0 items-center gap-2 text-brand-700 hover:underline" href={fileLink(c, x.id)} download><Icon name="file" className="size-4 shrink-0" /><span className="truncate">{x.fileName}</span></a>
              <span className="text-xs text-slate-500">{docLabel(x.category)} · {formatDateTime(x.createdAt)}</span>
            </li>
          ))}
        </ul>
      )}
      {history.length > 0 && (
        <details className="border-t border-slate-100 px-5 py-3 text-xs text-slate-500">
          <summary className="cursor-pointer">{t("accidentFlow.doc.replacedCount", { count: history.length })}</summary>
          <ul className="mt-2 space-y-1">{history.map((x) => <li key={x.id}><a className="text-slate-600 hover:underline" href={fileLink(c, x.id)} download>{docLabel(x.category)} — {x.fileName}</a> · {formatDate(x.supersededAt)}</li>)}</ul>
        </details>
      )}
    </Card>
  );
}

export function TechnicalSection({ c, runner }: { c: CaseDetail; runner: Runner }) {
  const can = c.actions.includes("technical");
  const [v, setV] = useState({ damageDescription: c.damageDescription ?? "", technicalNotes: c.technicalNotes ?? "", repairDecision: c.repairDecision ?? "" });
  useEffect(() => setV({ damageDescription: c.damageDescription ?? "", technicalNotes: c.technicalNotes ?? "", repairDecision: c.repairDecision ?? "" }), [c.damageDescription, c.technicalNotes, c.repairDecision]);
  const save = () => runner.run("technical", () => api(`/accident-cases/${c.id}/technical`, { method: "PUT", body: { damageDescription: v.damageDescription.trim(), repairDecision: v.repairDecision, ...(v.technicalNotes.trim() ? { technicalNotes: v.technicalNotes.trim() } : {}) } }), t("common.saved"));
  const move = (to: string) => runner.run(`to-${to}`, () => api(`/accident-cases/${c.id}/transition`, { method: "POST", body: { to } }), t("accidentFlow.technical.moved"));
  const saved = !!c.damageDescription && !!c.repairDecision;
  const missing = pendingMissing(c);
  const toEstimates = c.actions.includes("to:AWAITING_ESTIMATES");
  const toInsurance = c.actions.includes("to:AWAITING_INSURANCE");
  return (
    <Card>
      <CardHeader title={t("accidentFlow.section.technical")} />
      <div className="space-y-4 p-5">
        {!can && !saved && <p className="text-sm text-slate-500">{t("accidentFlow.technical.notYet")}</p>}
        {!can && saved && (
          <DescList items={[
            { label: t("accidentFlow.technical.damage"), value: c.damageDescription },
            { label: t("accidentFlow.technical.decision"), value: <Badge tone={c.repairDecision === "REPAIR" ? "blue" : "slate"}>{repairDecisionLabel(c.repairDecision)}</Badge> },
            { label: t("accidentFlow.technical.notes"), value: c.technicalNotes },
          ]} />
        )}
        {can && (
          <div className="space-y-4">
            <Field label={t("accidentFlow.technical.damage")} required htmlFor="tc-damage"><Textarea id="tc-damage" rows={4} value={v.damageDescription} onChange={(e) => setV({ ...v, damageDescription: e.target.value })} /></Field>
            <fieldset>
              <legend className="mb-1.5 block text-sm font-medium text-slate-700">{t("accidentFlow.technical.decision")} <span className="text-red-600">*</span></legend>
              <div className="grid grid-cols-1 gap-2 sm:grid-cols-3">
                {REPAIR_DECISIONS.map((d) => (
                  <label key={d} className={`flex min-h-11 cursor-pointer items-center gap-2 rounded-lg border px-3 py-2 text-sm ${v.repairDecision === d ? "border-brand-600 bg-brand-50 text-brand-900" : "border-slate-200 bg-white text-slate-700"}`}>
                    <input type="radio" name="tc-decision" className="size-4" checked={v.repairDecision === d} onChange={() => setV({ ...v, repairDecision: d })} />
                    {repairDecisionLabel(d)}
                  </label>
                ))}
              </div>
              {v.repairDecision && v.repairDecision !== "REPAIR" && <p className="mt-1 text-xs text-slate-500">{t("accidentFlow.technical.notesRequiredHint")}</p>}
            </fieldset>
            <Field label={t("accidentFlow.technical.notes")} htmlFor="tc-notes"><Textarea id="tc-notes" rows={3} value={v.technicalNotes} onChange={(e) => setV({ ...v, technicalNotes: e.target.value })} /></Field>
            {saved && missing.length > 0 && <MissingList items={missing} />}
            <div className="flex flex-wrap items-center gap-2">
              <Button loading={runner.busy === "technical"} disabled={v.damageDescription.trim().length < 3 || !v.repairDecision} onClick={() => void save()}>{t("accidentFlow.technical.save")}</Button>
              {toEstimates && <Button variant="secondary" loading={runner.busy === "to-AWAITING_ESTIMATES"} disabled={!saved || c.repairDecision !== "REPAIR"} onClick={() => void move("AWAITING_ESTIMATES")}>{t("accidentFlow.technical.toEstimates")}</Button>}
              {toInsurance && <Button variant="secondary" loading={runner.busy === "to-AWAITING_INSURANCE"} disabled={!saved || c.repairDecision === "REPAIR" || !c.repairDecision} onClick={() => void move("AWAITING_INSURANCE")}>{t("accidentFlow.technical.toInsurance")}</Button>}
            </div>
            <p className="text-xs text-slate-500">{t("accidentFlow.technical.saveFirst")}</p>
          </div>
        )}
      </div>
    </Card>
  );
}

export function EstimatesSection({ c, runner }: { c: CaseDetail; runner: Runner }) {
  const toast = useToast();
  const can = c.actions.includes("estimate");
  const file = useRef<HTMLInputElement>(null);
  const [v, setV] = useState({ vendorName: "", amount: "", notes: "" });
  const [picked, setPicked] = useState<File | null>(null);
  const missing = missingFor(c, "AWAITING_INSURANCE");
  const add = () => {
    if (!picked) return;
    const problem = fileProblem(picked);
    if (problem) return void toast.error(problem);
    return runner.run("estimate", async () => {
      const up = await uploadToCase(c.id, "ESTIMATE", picked);
      await api(`/accident-cases/${c.id}/estimates`, { method: "POST", body: { vendorName: v.vendorName.trim(), amount: v.amount.trim(), ...(v.notes.trim() ? { notes: v.notes.trim() } : {}), attachmentId: (up as { data: { id: string } }).data.id } });
      setV({ vendorName: "", amount: "", notes: "" });
      setPicked(null);
      if (file.current) file.current.value = "";
    }, t("accidentFlow.estimates.added"));
  };
  const select = (id: string) => runner.run(`select-${id}`, () => api(`/accident-cases/${c.id}/estimates/${id}/select`, { method: "POST" }), t("accidentFlow.estimates.selected"));
  const toInsurance = () => runner.run("to-insurance", () => api(`/accident-cases/${c.id}/transition`, { method: "POST", body: { to: "AWAITING_INSURANCE" } }), t("accidentFlow.estimates.moved"));
  return (
    <Card>
      <CardHeader title={t("accidentFlow.section.estimates", { count: c.estimates.length })} />
      {c.estimates.length === 0 ? <EmptyState icon="receipt" title={t("accidentFlow.estimates.none")} /> : (
        <ul className="divide-y divide-slate-100">
          {c.estimates.map((e) => (
            <li key={e.id} className="flex flex-wrap items-center justify-between gap-3 px-5 py-3 text-sm" data-selected={e.selected}>
              <div className="min-w-0">
                <p className="flex flex-wrap items-center gap-2 font-medium text-slate-800">{e.vendorName}{e.selected && <Badge tone="green" dot>{t("accidentFlow.estimates.approved")}</Badge>}</p>
                {e.notes && <p className="text-xs text-slate-500">{e.notes}</p>}
                {e.attachmentId && c.attachments.some((a) => a.id === e.attachmentId) && <a className="text-xs text-brand-700 hover:underline" href={fileLink(c, e.attachmentId)} download>{t("accidentFlow.estimates.report")}</a>}
              </div>
              <div className="flex items-center gap-3"><Money value={e.amount} />{can && !e.selected && <Button variant="secondary" loading={runner.busy === `select-${e.id}`} onClick={() => void select(e.id)}>{t("accidentFlow.estimates.choose")}</Button>}</div>
            </li>
          ))}
        </ul>
      )}
      {can && (
        <div className="space-y-4 border-t border-slate-100 p-5">
          <p className="text-sm font-medium text-slate-700">{t("accidentFlow.estimates.addTitle")}</p>
          <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
            <Field label={t("accidentFlow.estimates.vendor")} required htmlFor="es-vendor"><Input id="es-vendor" value={v.vendorName} onChange={(e) => setV({ ...v, vendorName: e.target.value })} /></Field>
            <Field label={t("accidentFlow.estimates.amount")} required htmlFor="es-amount"><Input id="es-amount" dir="ltr" inputMode="decimal" value={v.amount} onChange={(e) => setV({ ...v, amount: e.target.value })} /></Field>
          </div>
          <Field label={t("accidentFlow.estimates.notes")} htmlFor="es-notes"><Input id="es-notes" value={v.notes} onChange={(e) => setV({ ...v, notes: e.target.value })} /></Field>
          <div className="flex flex-wrap items-center gap-2">
            <input ref={file} type="file" accept={ACCEPT} className="hidden" data-testid="estimate-file" onChange={(e) => setPicked(e.target.files?.[0] ?? null)} />
            <Button variant="secondary" icon="file" onClick={() => file.current?.click()}>{picked ? t("accidentFlow.doc.replace") : t("accidentFlow.estimates.pickReport")}</Button>
            {picked ? <span className="truncate text-xs text-slate-600 ltr">{picked.name}</span> : <span className="text-xs text-slate-500">{t("accidentFlow.estimates.reportRequired")}</span>}
            <Button loading={runner.busy === "estimate"} disabled={!picked || v.vendorName.trim().length < 2 || !/^\d{1,12}(\.\d{1,2})?$/.test(v.amount.trim())} onClick={() => void add()}>{t("accidentFlow.estimates.add")}</Button>
          </div>
        </div>
      )}
      {c.actions.includes("to:AWAITING_INSURANCE") && c.workflowStage === "AWAITING_ESTIMATES" && (
        <div className="space-y-3 border-t border-slate-100 p-5">
          {missing.length > 0 && <MissingList items={missing} />}
          <Button disabled={missing.length > 0} loading={runner.busy === "to-insurance"} onClick={() => void toInsurance()}>{t("accidentFlow.estimates.toInsurance")}</Button>
        </div>
      )}
    </Card>
  );
}

type ClaimDialog = "APPROVED" | "REJECTED" | "COMPENSATION_RECEIVED" | null;

export function ClaimSection({ c, runner }: { c: CaseDetail; runner: Runner }) {
  const toast = useToast();
  const can = c.actions.includes("claim");
  const [dialog, setDialog] = useState<ClaimDialog>(null);
  const [editing, setEditing] = useState(false);
  const claim = c.claim;
  const stage = c.workflowStage;
  const registering = can && stage === "AWAITING_INSURANCE";
  const [form, setForm] = useState({ insurerName: "", claimNumber: "", filedAt: new Date().toISOString().slice(0, 10), claimedAmount: "" });
  const [dlg, setDlg] = useState({ reason: "", amount: "" });
  const [picked, setPicked] = useState<File | null>(null);
  const file = useRef<HTMLInputElement>(null);
  useEffect(() => {
    if (claim) setForm({ insurerName: claim.insurerName ?? "", claimNumber: claim.claimNumber ?? "", filedAt: claim.filedAt ? claim.filedAt.slice(0, 10) : form.filedAt, claimedAmount: claim.claimedAmount ?? "" });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [claim?.id, claim?.insurerName, claim?.claimNumber, claim?.claimedAmount]);
  const saveClaim = async () => { if (await runner.run("claim", () => api(`/accident-cases/${c.id}/claim`, { method: "PUT", body: { insurerName: form.insurerName.trim(), claimNumber: form.claimNumber.trim(), filedAt: form.filedAt, ...(form.claimedAmount.trim() ? { claimedAmount: form.claimedAmount.trim() } : {}) } }), t("accidentFlow.claim.saved"))) setEditing(false); };
  const status = (s: string) => runner.run(`claim-${s}`, () => api(`/accident-cases/${c.id}/claim/status`, { method: "POST", body: { status: s } }), t("accidentFlow.claim.updated"));
  const docCat = dialog === "REJECTED" ? "INSURER_DECISION" : "COMPENSATION_PROOF";
  const haveDoc = c.attachments.some((a) => a.category === docCat && !a.supersededAt);
  const submitDialog = async () => {
    if (!dialog) return;
    if (picked) {
      const problem = fileProblem(picked);
      if (problem) return void toast.error(problem);
    }
    const ok = await runner.run(`claim-${dialog}`, async () => {
      if (picked) await uploadToCase(c.id, docCat, picked);
      await api(`/accident-cases/${c.id}/claim/status`, { method: "POST", body: { status: dialog, ...(dialog === "REJECTED" ? { reason: dlg.reason.trim() } : {}), ...(dialog === "APPROVED" && dlg.amount.trim() ? { approvedAmount: dlg.amount.trim() } : {}), ...(dialog === "COMPENSATION_RECEIVED" ? { receivedAmount: dlg.amount.trim() } : {}) } });
    }, t("accidentFlow.claim.updated"));
    if (ok) { setDialog(null); setPicked(null); setDlg({ reason: "", amount: "" }); }
  };
  const detailsForm = (
    <div className="space-y-4">
      <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
        <Field label={t("accidentFlow.claim.insurer")} required htmlFor="cl-insurer"><Input id="cl-insurer" value={form.insurerName} onChange={(e) => setForm({ ...form, insurerName: e.target.value })} /></Field>
        <Field label={t("accidentFlow.claim.number")} required htmlFor="cl-number"><Input id="cl-number" dir="ltr" value={form.claimNumber} onChange={(e) => setForm({ ...form, claimNumber: e.target.value })} /></Field>
        <Field label={t("accidentFlow.claim.date")} required htmlFor="cl-date"><Input id="cl-date" type="date" value={form.filedAt} onChange={(e) => setForm({ ...form, filedAt: e.target.value })} /></Field>
        <Field label={t("accidentFlow.claim.claimedAmount")} htmlFor="cl-amount"><Input id="cl-amount" dir="ltr" inputMode="decimal" value={form.claimedAmount} onChange={(e) => setForm({ ...form, claimedAmount: e.target.value })} /></Field>
      </div>
      <div className="flex gap-2">
        <Button loading={runner.busy === "claim"} disabled={form.insurerName.trim().length < 2 || !form.claimNumber.trim() || !form.filedAt} onClick={() => void saveClaim()}>{registering ? t("accidentFlow.claim.register") : t("common.save")}</Button>
        {editing && <Button variant="secondary" onClick={() => setEditing(false)}>{t("common.cancel")}</Button>}
      </div>
    </div>
  );
  return (
    <Card>
      <CardHeader title={t("accidentFlow.section.claim")} action={claim && <Badge tone={CLAIM_TONE[claim.status]} dot>{claimStatusLabel(claim.status)}</Badge>} />
      <div className="space-y-4 p-5">
        {!claim && !registering && <p className="text-sm text-slate-500">{t("accidentFlow.claim.notYet")}</p>}
        {registering && !claim && detailsForm}
        {claim && (
          <DescList items={[
            { label: t("accidentFlow.claim.insurer"), value: claim.insurerName },
            { label: t("accidentFlow.claim.number"), value: <span className="ltr">{claim.claimNumber}</span> },
            { label: t("accidentFlow.claim.date"), value: formatDate(claim.filedAt) },
            { label: t("accidentFlow.claim.claimedAmount"), value: <Money value={claim.claimedAmount} /> },
            { label: t("accidentFlow.claim.approvedAmount"), value: <Money value={claim.approvedAmount} /> },
            { label: t("accidentFlow.claim.receivedAmount"), value: <Money value={claim.receivedAmount} /> },
          ]} />
        )}
        {claim?.rejectionReason && <Alert tone="amber">{t("accidentFlow.claim.rejectionReason", { reason: claim.rejectionReason })}</Alert>}
        {claim && can && (stage === "CLAIM_IN_PROGRESS" || stage === "AWAITING_INSURANCE") && (editing ? detailsForm : <Button variant="ghost" icon="edit" onClick={() => setEditing(true)}>{t("accidentFlow.claim.editDetails")}</Button>)}
        {claim && can && stage === "CLAIM_IN_PROGRESS" && (
          <div className="flex flex-wrap gap-2">
            {claim.status === "FILED" && <Button variant="secondary" loading={runner.busy === "claim-PROCESSING"} onClick={() => void status("PROCESSING")}>{t("accidentFlow.claim.markProcessing")}</Button>}
            <Button onClick={() => setDialog("APPROVED")}>{t("accidentFlow.claim.approve")}</Button>
            <Button variant="danger" onClick={() => setDialog("REJECTED")}>{t("accidentFlow.claim.reject")}</Button>
          </div>
        )}
        {claim && can && stage === "AWAITING_COMPENSATION_PROOF" && <Button onClick={() => setDialog("COMPENSATION_RECEIVED")}>{t("accidentFlow.claim.compensation")}</Button>}
      </div>
      <Modal
        open={dialog !== null}
        onClose={() => setDialog(null)}
        title={dialog === "APPROVED" ? t("accidentFlow.claim.approveTitle") : dialog === "REJECTED" ? t("accidentFlow.claim.rejectTitle") : t("accidentFlow.claim.compensationTitle")}
        footer={<><Button variant="secondary" onClick={() => setDialog(null)}>{t("common.cancel")}</Button><Button variant={dialog === "REJECTED" ? "danger" : "primary"} loading={runner.busy === `claim-${dialog}`} disabled={(dialog === "REJECTED" && (dlg.reason.trim().length < 3 || (!picked && !haveDoc))) || (dialog === "COMPENSATION_RECEIVED" && (!/^\d{1,12}(\.\d{1,2})?$/.test(dlg.amount.trim()) || (!picked && !haveDoc))) || (dialog === "APPROVED" && dlg.amount.trim() !== "" && !/^\d{1,12}(\.\d{1,2})?$/.test(dlg.amount.trim()))} onClick={() => void submitDialog()}>{t("common.confirm")}</Button></>}
      >
        <div className="space-y-4">
          {runner.missing && <MissingList items={runner.missing} />}
          {dialog === "REJECTED" && <Field label={t("accidentFlow.claim.reasonRejectNotCovered")} required htmlFor="cd-reason"><Textarea id="cd-reason" rows={3} value={dlg.reason} onChange={(e) => setDlg({ ...dlg, reason: e.target.value })} /></Field>}
          {dialog === "APPROVED" && <Field label={t("accidentFlow.claim.approvedAmount")} htmlFor="cd-amount"><Input id="cd-amount" dir="ltr" inputMode="decimal" value={dlg.amount} onChange={(e) => setDlg({ ...dlg, amount: e.target.value })} /></Field>}
          {dialog === "COMPENSATION_RECEIVED" && <Field label={t("accidentFlow.claim.receivedAmount")} required htmlFor="cd-amount"><Input id="cd-amount" dir="ltr" inputMode="decimal" value={dlg.amount} onChange={(e) => setDlg({ ...dlg, amount: e.target.value })} /></Field>}
          {(dialog === "REJECTED" || dialog === "COMPENSATION_RECEIVED") && (
            <div>
              <p className="mb-1.5 text-sm font-medium text-slate-700">{dialog === "REJECTED" ? t("accidentFlow.claim.decisionDoc") : t("accidentFlow.claim.proofDoc")} {!haveDoc && <span className="text-red-600">*</span>}</p>
              <input ref={file} type="file" accept={ACCEPT} className="hidden" data-testid="claim-file" onChange={(e) => setPicked(e.target.files?.[0] ?? null)} />
              <div className="flex flex-wrap items-center gap-2">
                <Button variant="secondary" icon="file" onClick={() => file.current?.click()}>{picked ? t("accidentFlow.doc.replace") : t("accidents.attach")}</Button>
                {picked ? <span className="truncate text-xs ltr">{picked.name}</span> : haveDoc ? <span className="text-xs text-emerald-700">{t("accidentFlow.claim.docAlready")}</span> : null}
              </div>
            </div>
          )}
        </div>
      </Modal>
    </Card>
  );
}

/** Stage changes and assignments in one list, newest last (the server keeps both logs; nothing is ever rewritten). */
export function HistorySection({ c }: { c: CaseDetail }) {
  type Row = { id: string; at: string; title: string; detail?: string | null; by?: string | null };
  const rows: Row[] = [
    ...c.transitions.map((x: CaseTransition) => ({ id: `t-${x.id}`, at: x.createdAt, title: x.fromStage ? t("accidentFlow.history.moved", { from: stageLabel(x.fromStage), to: stageLabel(x.toStage) }) : t("accidentFlow.history.created"), detail: x.reason, by: x.actorName })),
    ...c.assignments.map((x) => ({ id: `a-${x.id}`, at: x.createdAt, title: x.mode === "QUEUE" ? t("accidentFlow.history.queued", { stage: stageLabel(x.stage) }) : x.mode === "AUTO" ? t("accidentFlow.history.autoAssigned", { name: x.assignedToName ?? "—" }) : t("accidentFlow.history.assigned", { name: x.assignedToName ?? "—" }), detail: x.reason && x.mode !== "AUTO" ? x.reason : null, by: x.mode === "MANUAL" ? x.assignedByName : null })),
  ].sort((a, b) => a.at.localeCompare(b.at));
  return (
    <Card>
      <CardHeader title={t("accidentFlow.section.history")} />
      <div className="p-5">
        {rows.length === 0 ? <EmptyState icon="clock" title={t("shared.noHistory")} /> : (
          <ol className="relative ms-3 border-s border-slate-200">
            {rows.map((r) => (
              <li key={r.id} className="ms-6 pb-5">
                <span className="absolute -start-1.5 mt-1.5 size-3 rounded-full border-2 border-white bg-brand-600" />
                <p className="text-sm font-medium text-slate-800">{r.title}</p>
                {r.detail && <p className="mt-0.5 text-xs text-slate-600">{t("common.reason2", { reason: r.detail })}</p>}
                <p className="mt-0.5 text-xs text-slate-400">{r.by ? `${r.by} · ` : ""}{formatDateTime(r.at)}</p>
              </li>
            ))}
          </ol>
        )}
      </div>
    </Card>
  );
}

