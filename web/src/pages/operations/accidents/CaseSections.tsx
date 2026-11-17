import { useEffect, useRef, useState } from "react";
import { Link } from "react-router";
import { useToast } from "../../../components/feedback";
import { Money } from "../../../components/shared";
import { Alert, Badge, Button, Card, CardHeader, DescList, EmptyState, Field, Input, Modal, Textarea } from "../../../components/ui";
import { t } from "../../../i18n";
import { api, fileUrl } from "../../../lib/api";
import {
  CLAIM_TONE,
  claimStatusLabel,
  docLabel,
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
import { DocumentsPanel } from "./DocumentsPanel";
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
  const allowed = c.uploadCategories;
  const upload = async (category: string, file: File) => {
    const ok = await runner.run(`upload-${category}`, () => uploadToCase(c.id, category, file), t("common.attachmentUploaded"));
    if (ok) onChanged();
    return ok;
  };
  return (
    <DocumentsPanel
      slots={c.documentSlots ?? []}
      files={c.attachments}
      closed={c.workflowStage === "CLOSED"}
      requiredMark={c.workflowStage === "DRAFT"}
      canUpload={(category) => allowed.includes(category)}
      otherCategories={allowed.filter((k) => !REQUIRED_DOCS.includes(k as (typeof REQUIRED_DOCS)[number])).map((k) => ({ value: k, label: docLabel(k) }))}
      upload={upload}
      fileHref={(id, inline) => fileUrl(`/accident-cases/${c.id}/attachments/${id}/file${inline ? "?view=inline" : ""}`)}
    />
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
  // The moves out of the review belong to the review stage; at the decision stage the decision card carries them.
  const toEstimates = c.workflowStage === "AWAITING_TECHNICAL" && c.actions.includes("to:AWAITING_ESTIMATES");
  const toInsurance = c.workflowStage === "AWAITING_TECHNICAL" && c.actions.includes("to:AWAITING_INSURANCE");
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
  const missing = missingFor(c, "AWAITING_TECHNICAL_DECISION");
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
  const toTechnicalDecision = () => runner.run("to-technical-decision", () => api(`/accident-cases/${c.id}/transition`, { method: "POST", body: { to: "AWAITING_TECHNICAL_DECISION" } }), t("accidentFlow.estimates.moved"));
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
      {c.actions.includes("to:AWAITING_TECHNICAL_DECISION") && c.workflowStage === "AWAITING_ESTIMATES" && (
        <div className="space-y-3 border-t border-slate-100 p-5">
          {missing.length > 0 && <MissingList items={missing} />}
          <Button disabled={missing.length > 0} loading={runner.busy === "to-technical-decision"} onClick={() => void toTechnicalDecision()}>{t("accidentFlow.estimates.toTechnicalDecision")}</Button>
        </div>
      )}
    </Card>
  );
}


export function TechnicalDecisionSection({ c, runner }: { c: CaseDetail; runner: Runner }) {
  if (c.workflowStage !== "AWAITING_TECHNICAL_DECISION") return null;
  const go = (to: string, key: string) => runner.run(key, () => api(`/accident-cases/${c.id}/transition`, { method: "POST", body: { to } }), t("accidentFlow.estimates.moved"));
  const toRepair = c.actions.includes("to:REPAIR_IN_PROGRESS");
  const toInsurance = c.actions.includes("to:AWAITING_INSURANCE");
  const repairMissing = missingFor(c, "REPAIR_IN_PROGRESS");
  const insuranceMissing = missingFor(c, "AWAITING_INSURANCE");
  const rejected = c.claim?.status === "REJECTED";
  return (
    <Card>
      <CardHeader title={t("accidentFlow.stage.AWAITING_TECHNICAL_DECISION")} />
      <div className="space-y-3 p-5">
        <p className="text-sm text-slate-600">{t("accidentFlow.technical.decisionHint")}</p>
        {rejected && c.claim?.rejectionReason && <Alert tone="amber">{t("accidentFlow.claim.rejectionReason", { reason: c.claim.rejectionReason })}</Alert>}
        {(toRepair ? repairMissing : []).length > 0 && <MissingList items={repairMissing} />}
        {(toInsurance ? insuranceMissing : []).length > 0 && <MissingList items={insuranceMissing} />}
        <div className="flex flex-wrap gap-2">
          {toRepair && <Button disabled={repairMissing.length > 0} loading={runner.busy === "decision-repair"} onClick={() => void go("REPAIR_IN_PROGRESS", "decision-repair")}>{t("accidentFlow.technical.toRepair")}</Button>}
          {toInsurance && <Button variant="secondary" disabled={insuranceMissing.length > 0} loading={runner.busy === "decision-insurance"} onClick={() => void go("AWAITING_INSURANCE", "decision-insurance")}>{t("accidentFlow.technical.toInsurance")}</Button>}
        </div>
      </div>
    </Card>
  );
}


export function RepairSection({ c, runner }: { c: CaseDetail; runner: Runner }) {
  if (c.workflowStage !== "REPAIR_IN_PROGRESS") return null;
  const allowed = c.actions.includes("to:AWAITING_FINANCE_REVIEW");
  const missing = missingFor(c, "AWAITING_FINANCE_REVIEW");
  const proceed = () => runner.run("repair-to-finance", () => api(`/accident-cases/${c.id}/transition`, { method: "POST", body: { to: "AWAITING_FINANCE_REVIEW" } }), t("accidentFlow.repair.sentToFinance"));
  return (
    <Card>
      <CardHeader title={t("accidentFlow.stage.REPAIR_IN_PROGRESS")} />
      <div className="space-y-3 p-5">
        <p className="text-sm text-slate-600">{t("accidentFlow.repair.invoiceHint")}</p>
        {missing.length > 0 && <MissingList items={missing} />}
        {allowed && <Button disabled={missing.length > 0} loading={runner.busy === "repair-to-finance"} onClick={() => void proceed()}>{t("accidentFlow.repair.toFinance")}</Button>}
      </div>
    </Card>
  );
}

/** The technician's last look at the file after finance, then «ready to close» for the system administrator. */
export function FinalSection({ c, runner }: { c: CaseDetail; runner: Runner }) {
  const [resolution, setResolution] = useState(c.resolution ?? "");
  if (c.workflowStage !== "AWAITING_TECHNICAL_FINAL") return null;
  const allowed = c.actions.includes("to:AWAITING_FINAL_CLOSURE");
  const missing = missingFor(c, "AWAITING_FINAL_CLOSURE").filter((m) => m !== "resolution");
  const proceed = () => runner.run("final-ready", () => api(`/accident-cases/${c.id}/transition`, { method: "POST", body: { to: "AWAITING_FINAL_CLOSURE", resolution: resolution.trim() } }), t("accidentFlow.final.sent"));
  return (
    <Card>
      <CardHeader title={t("accidentFlow.final.title")} />
      <div className="space-y-4 p-5">
        <FinanceHistory c={c} />
        <Field label={t("accidentFlow.final.resolution")} required htmlFor="final-resolution"><Textarea id="final-resolution" rows={3} value={resolution} onChange={(e) => setResolution(e.target.value)} disabled={!allowed} /></Field>
        {missing.length > 0 && <MissingList items={missing} />}
        {allowed && <Button disabled={missing.length > 0 || resolution.trim().length < 3} loading={runner.busy === "final-ready"} onClick={() => void proceed()}>{t("accidentFlow.final.ready")}</Button>}
      </div>
    </Card>
  );
}

/** What finance recorded: the invoice amount or the transfer (amount, date), who, when, and any return with its reason. */
export function FinanceHistory({ c }: { c: CaseDetail }) {
  const rows = c.financeReviews ?? [];
  if (rows.length === 0) return null;
  return (
    <ul className="divide-y divide-slate-100 rounded-lg border border-slate-100 text-sm" data-testid="finance-history">
      {rows.map((r) => (
        <li key={r.id} className="flex flex-wrap items-center justify-between gap-2 px-4 py-2.5">
          <span className="flex flex-wrap items-center gap-2">
            <Badge tone={r.status === "CONFIRMED" ? "green" : "amber"} dot>{r.kind === "REPAIR_INVOICE" ? t("accidentFlow.finance.invoiceTitle") : t("accidentFlow.finance.transferTitle")}</Badge>
            {r.amount && <Money value={r.amount} />}
            {r.referenceDate && <span className="text-xs text-slate-500">{formatDate(r.referenceDate)}</span>}
            {r.note && <span className="text-xs text-slate-600">{r.note}</span>}
          </span>
          <span className="text-xs text-slate-400">{r.reviewerName ? `${r.reviewerName} · ` : ""}{formatDateTime(r.createdAt)}</span>
        </li>
      ))}
    </ul>
  );
}

/** Finance: confirm the maintenance invoice, or confirm that the insurer's transfer reached the account (with its proof). */
export function FinanceSection({ c, runner, onReturn }: { c: CaseDetail; runner: Runner; onReturn: () => void }) {
  const toast = useToast();
  const insurance = c.financePath === "INSURANCE";
  const canInvoice = c.actions.includes("financeConfirm") && !insurance;
  const canTransfer = c.actions.includes("compensationConfirm") && insurance;
  const file = useRef<HTMLInputElement>(null);
  const [picked, setPicked] = useState<File | null>(null);
  const [v, setV] = useState({ amount: "", date: new Date().toISOString().slice(0, 10), method: "BANK_TRANSFER", note: "" });
  if (c.workflowStage !== "AWAITING_FINANCE_REVIEW") return null;
  const haveProof = c.attachments.some((a) => a.category === "COMPENSATION_PROOF" && !a.supersededAt);
  const haveInvoice = c.attachments.some((a) => a.category === "REPAIR_INVOICE" && !a.supersededAt);
  const money = /^\d{1,12}(\.\d{1,2})?$/.test(v.amount.trim());
  const confirmInvoice = () => runner.run("finance-invoice", () => api(`/accident-cases/${c.id}/finance/invoice/confirm`, { method: "POST", body: { invoiceAmount: v.amount.trim(), ...(v.note.trim() ? { note: v.note.trim() } : {}) } }), t("accidentFlow.finance.confirmed"));
  const confirmTransfer = () => {
    if (picked) {
      const problem = fileProblem(picked);
      if (problem) return void toast.error(problem);
    }
    return runner.run("finance-transfer", async () => {
      if (picked) await uploadToCase(c.id, "COMPENSATION_PROOF", picked);
      await api(`/accident-cases/${c.id}/compensation/confirm`, { method: "POST", body: { receivedAmount: v.amount.trim(), receiptDate: v.date, receiptMethod: v.method, ...(v.note.trim() ? { note: v.note.trim() } : {}) } });
    }, t("accidentFlow.finance.confirmed"));
  };
  return (
    <Card>
      <CardHeader title={insurance ? t("accidentFlow.finance.transferTitle") : t("accidentFlow.finance.invoiceTitle")} action={<Badge tone="violet" dot>{t("accidentFlow.finance.title")}</Badge>} />
      <div className="space-y-4 p-5">
        <FinanceHistory c={c} />
        {insurance && c.claim && <DescList items={[{ label: t("accidentFlow.claim.approvedAmount"), value: <Money value={c.claim.approvedAmount} /> }, { label: t("accidentFlow.claim.number"), value: <span className="ltr">{c.claim.claimNumber}</span> }]} />}
        {runner.missing && <MissingList items={runner.missing} />}
        {(canInvoice || canTransfer) && (
          <div className="space-y-4">
            <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
              <Field label={insurance ? t("accidentFlow.finance.receivedAmount") : t("accidentFlow.finance.invoiceAmount")} required htmlFor="fn-amount"><Input id="fn-amount" dir="ltr" inputMode="decimal" value={v.amount} onChange={(e) => setV({ ...v, amount: e.target.value })} /></Field>
              {insurance && <Field label={t("accidentFlow.finance.receiptDate")} required htmlFor="fn-date"><Input id="fn-date" type="date" value={v.date} max={new Date().toISOString().slice(0, 10)} onChange={(e) => setV({ ...v, date: e.target.value })} /></Field>}
            </div>
            <Field label={t("accidentFlow.estimates.notes")} htmlFor="fn-note"><Input id="fn-note" value={v.note} onChange={(e) => setV({ ...v, note: e.target.value })} /></Field>
            {insurance ? (
              <div>
                <p className="mb-1.5 text-sm font-medium text-slate-700">{t("accidentFlow.claim.proofDoc")} {!haveProof && !picked && <span className="text-red-600">*</span>}</p>
                <input ref={file} type="file" accept={ACCEPT} className="hidden" data-testid="finance-proof-file" onChange={(e) => setPicked(e.target.files?.[0] ?? null)} />
                <div className="flex flex-wrap items-center gap-2">
                  <Button variant="secondary" icon="file" onClick={() => file.current?.click()}>{picked ? t("accidentFlow.doc.replace") : t("accidentFlow.finance.pickProof")}</Button>
                  {picked ? <span className="truncate text-xs ltr">{picked.name}</span> : haveProof ? <span className="text-xs text-emerald-700">{t("accidentFlow.finance.proofUploaded")}</span> : <span className="text-xs text-slate-500">{t("accidentFlow.finance.proofRequired")}</span>}
                </div>
              </div>
            ) : !haveInvoice ? <Alert tone="amber">{t("accidentFlow.req.attachment", { doc: docLabel("REPAIR_INVOICE") })}</Alert> : null}
            <div className="flex flex-wrap gap-2">
              {canInvoice && <Button disabled={!money || !haveInvoice} loading={runner.busy === "finance-invoice"} onClick={() => void confirmInvoice()}>{t("accidentFlow.finance.confirmInvoice")}</Button>}
              {canTransfer && <Button disabled={!money || !v.date || (!haveProof && !picked)} loading={runner.busy === "finance-transfer"} onClick={() => void confirmTransfer()}>{t("accidentFlow.finance.confirmTransfer")}</Button>}
              {c.actions.includes("sendBack") && <Button variant="danger" onClick={onReturn}>{t("accidentFlow.sendBack.financeButton")}</Button>}
            </div>
          </div>
        )}
      </div>
    </Card>
  );
}

type ClaimDialog = "APPROVED" | "REJECTED" | null;

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
  const docCat = "INSURER_DECISION";
  const haveDoc = c.attachments.some((a) => a.category === docCat && !a.supersededAt);
  const submitDialog = async () => {
    if (!dialog) return;
    if (picked) {
      const problem = fileProblem(picked);
      if (problem) return void toast.error(problem);
    }
    const ok = await runner.run(`claim-${dialog}`, async () => {
      if (picked) await uploadToCase(c.id, docCat, picked);
      await api(`/accident-cases/${c.id}/claim/status`, { method: "POST", body: { status: dialog, ...(dialog === "REJECTED" ? { reason: dlg.reason.trim() } : {}), ...(dialog === "APPROVED" && dlg.amount.trim() ? { approvedAmount: dlg.amount.trim() } : {}) } });
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
        {claim && can && stage === "AWAITING_COMPENSATION_PROOF" && (
          <div className="space-y-3">
            <Alert tone="blue">{t("accidentFlow.insurance.waitingTransfer")}</Alert>
            {c.actions.includes("to:AWAITING_FINANCE_REVIEW") && <Button loading={runner.busy === "forward-finance"} onClick={() => void runner.run("forward-finance", () => api(`/accident-cases/${c.id}/transition`, { method: "POST", body: { to: "AWAITING_FINANCE_REVIEW" } }), t("accidentFlow.insurance.forwarded"))}>{t("accidentFlow.insurance.forwardToFinance")}</Button>}
          </div>
        )}
      </div>
      <Modal
        open={dialog !== null}
        onClose={() => setDialog(null)}
        title={dialog === "APPROVED" ? t("accidentFlow.claim.approveTitle") : t("accidentFlow.claim.rejectTitle")}
        footer={<><Button variant="secondary" onClick={() => setDialog(null)}>{t("common.cancel")}</Button><Button variant={dialog === "REJECTED" ? "danger" : "primary"} loading={runner.busy === `claim-${dialog}`} disabled={(dialog === "REJECTED" && (dlg.reason.trim().length < 3 || (!picked && !haveDoc))) || (dialog === "APPROVED" && dlg.amount.trim() !== "" && !/^\d{1,12}(\.\d{1,2})?$/.test(dlg.amount.trim()))} onClick={() => void submitDialog()}>{t("common.confirm")}</Button></>}
      >
        <div className="space-y-4">
          {runner.missing && <MissingList items={runner.missing} />}
          {dialog === "REJECTED" && <Field label={t("accidentFlow.claim.reasonRejectNotCovered")} required htmlFor="cd-reason"><Textarea id="cd-reason" rows={3} value={dlg.reason} onChange={(e) => setDlg({ ...dlg, reason: e.target.value })} /></Field>}
          {dialog === "APPROVED" && <Field label={t("accidentFlow.claim.approvedAmount")} htmlFor="cd-amount"><Input id="cd-amount" dir="ltr" inputMode="decimal" value={dlg.amount} onChange={(e) => setDlg({ ...dlg, amount: e.target.value })} /></Field>}
          {dialog === "REJECTED" && (
            <div>
              <p className="mb-1.5 text-sm font-medium text-slate-700">{t("accidentFlow.claim.decisionDoc")} {!haveDoc && <span className="text-red-600">*</span>}</p>
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

