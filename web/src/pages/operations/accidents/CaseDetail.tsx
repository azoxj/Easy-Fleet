import { useState } from "react";
import { Link, useParams } from "react-router";
import { BackLink } from "../../../components/shared";
import { Alert, Badge, Button, Card, CardHeader, Loading, PageHeader } from "../../../components/ui";
import { useApi } from "../../../hooks/useApi";
import { t } from "../../../i18n";
import { api } from "../../../lib/api";
import { nextActionLabel, pendingMissing, requiredActorText, stageLabel, type CaseDetail } from "../../../lib/accidentWorkflow";
import { formatDate, formatDateTime } from "../../../lib/format";
import { ACCIDENT_SEVERITY } from "../../../lib/labels";
import { CaseFlags, StageBadge } from "./AccidentBadges";
import { AssignDialog, EditDraftDialog, MissingList, MoveDialog } from "./CaseDialogs";
import { ClaimSection, DocumentsSection, EstimatesSection, HistorySection, InfoSection, TechnicalSection } from "./CaseSections";
import { useCaseRunner } from "./caseRunner";

/** The marker of a case that was sent back: why, when, by whom, who has to act, what to do and what is missing. */
function ReturnedBanner({ c }: { c: CaseDetail }) {
  const r = c.returnedForCompletion;
  if (!r) return null;
  const missing = pendingMissing(c);
  return (
    <div className="mb-6 rounded-xl border border-red-200 bg-red-50 p-4" role="status" data-testid="returned-banner">
      <div className="flex flex-wrap items-center gap-2"><Badge tone="red" dot>{t("accidentFlow.badge.returned")}</Badge><span className="text-sm font-semibold text-red-900">{t("accidentFlow.returned.title", { stage: stageLabel(r.stage) })}</span></div>
      <dl className="mt-3 grid grid-cols-1 gap-x-6 gap-y-2 text-sm sm:grid-cols-2">
        <div><dt className="text-xs text-red-700">{t("accidentFlow.returned.reason")}</dt><dd className="text-slate-900">{r.reason ?? "—"}</dd></div>
        <div><dt className="text-xs text-red-700">{t("accidentFlow.returned.date")}</dt><dd className="text-slate-900">{formatDateTime(r.returnedAt)}{r.returnedBy ? ` · ${r.returnedBy.name}` : ""}</dd></div>
        <div><dt className="text-xs text-red-700">{t("accidentFlow.returned.actor")}</dt><dd className="text-slate-900">{requiredActorText(r.requiredAction)}</dd></div>
        <div><dt className="text-xs text-red-700">{t("accidentFlow.returned.action")}</dt><dd className="text-slate-900">{nextActionLabel(r.stage)}</dd></div>
      </dl>
      {missing.length > 0 && <div className="mt-3"><MissingList items={missing} /></div>}
    </div>
  );
}

/** Who holds the case now: the assignee, the queue, or the role the stage belongs to. */
function assigneeText(c: CaseDetail) {
  if (c.workflowStage === "CLOSED") return "—";
  if (c.assignedToName) return c.assignedToName;
  if (c.assignmentMode === "QUEUE") return <Badge tone="violet" dot>{t("accidentFlow.badge.awaitingAssignment")}</Badge>;
  if (c.workflowStage === "AWAITING_ESTIMATES") return t("accidentFlow.who.PROJECT_MANAGER");
  if (c.workflowStage === "AWAITING_FINAL_CLOSURE") return t("accidentFlow.who.ROLE");
  return "—";
}

/** The accident case screen (workflow cases). Inside the Accidents section: /accidents/:id. */
export function CaseDetailPage() {
  const { id } = useParams();
  const { data, loading, error, reload } = useApi<{ data: CaseDetail }>(`/accident-cases/${id}`);
  const runner = useCaseRunner(reload);
  const [move, setMove] = useState<"close" | "return" | "reopen" | null>(null);
  const [assign, setAssign] = useState(false);
  const [edit, setEdit] = useState(false);
  if (loading && !data) return <Loading />;
  if (error || !data) return <Alert>{error?.message ?? t("common.couldNotLoad")}</Alert>;
  const c = data.data;
  const has = (a: string) => c.actions.includes(a);
  const stage = c.workflowStage;
  const showTechnical = stage !== "DRAFT" || !!c.damageDescription;
  const showEstimates = c.estimates.length > 0 || stage === "AWAITING_ESTIMATES" || ["AWAITING_INSURANCE", "CLAIM_IN_PROGRESS", "AWAITING_COMPENSATION_PROOF", "AWAITING_FINAL_CLOSURE", "CLOSED"].includes(stage);
  const showClaim = !!c.claim || ["AWAITING_INSURANCE", "CLAIM_IN_PROGRESS", "AWAITING_COMPENSATION_PROOF"].includes(stage);
  const submit = () => runner.run("submit", () => api(`/accident-cases/${c.id}/submit`, { method: "POST" }), t("accidentFlow.form.submitted"));
  return (
    <>
      <PageHeader
        back={<BackLink to="/accidents" label={t("common.accidents")} />}
        title={<span className="flex flex-wrap items-center gap-3"><span className="ltr">{c.label}</span><StageBadge stage={stage} /><Badge tone={ACCIDENT_SEVERITY[c.severity]?.tone ?? "gray"}>{ACCIDENT_SEVERITY[c.severity]?.label ?? c.severity}</Badge><CaseFlags row={{ workflowStage: stage, returnedForCompletion: !!c.returnedForCompletion, overdue: c.overdue, preliminary: !!c.reportedBy }} /></span>}
        subtitle={<>{t("common.vehicle")} <Link className="text-brand-700 ltr" to={`/vehicles/${c.vehicleId}`}>{c.plateNumber}</Link> — {formatDateTime(c.occurredAt)}</>}
        actions={
          <>
            {has("edit") && <Button variant="secondary" icon="edit" onClick={() => setEdit(true)}>{t("accidents.updateDetails")}</Button>}
            {has("submit") && <Button variant="danger" loading={runner.busy === "submit"} onClick={() => void submit()}>{t("accidentFlow.form.submit")}</Button>}
            {has("assign") && <Button variant="secondary" icon="user" onClick={() => setAssign(true)}>{c.assignedToName ? t("accidentFlow.dialog.reassignTitle") : t("accidentFlow.dialog.assignTitle")}</Button>}
            {has("return") && <Button variant="secondary" onClick={() => setMove("return")}>{t("accidentFlow.dialog.returnTitle")}</Button>}
            {has("close") && <Button onClick={() => setMove("close")}>{t("accidentFlow.dialog.closeTitle")}</Button>}
            {has("reopen") && <Button variant="secondary" onClick={() => setMove("reopen")}>{t("common.reopen")}</Button>}
          </>
        }
      />
      {runner.missing && <div className="mb-6"><MissingList items={runner.missing} /></div>}
      <ReturnedBanner c={c} />
      {stage === "DRAFT" && c.reportedBy && <Alert tone="blue">{t("accidentFlow.detail.preliminaryNote")}</Alert>}
      <div className="mt-6 grid grid-cols-1 gap-6 lg:grid-cols-3">
        <div className="space-y-6 lg:col-span-2">
          <InfoSection c={c} />
          <DocumentsSection c={c} runner={runner} onChanged={reload} />
          {showTechnical && <TechnicalSection c={c} runner={runner} />}
          {showEstimates && <EstimatesSection c={c} runner={runner} />}
          {showClaim && <ClaimSection c={c} runner={runner} />}
        </div>
        <div className="space-y-6">
          <Card>
            <CardHeader title={t("accidentFlow.section.status")} />
            <dl className="space-y-3 p-5 text-sm">
              <div><dt className="text-xs text-slate-500">{t("accidentFlow.status.stage")}</dt><dd className="mt-0.5"><StageBadge stage={stage} /></dd></div>
              <div><dt className="text-xs text-slate-500">{t("accidentFlow.status.assignee")}</dt><dd className="mt-0.5 text-slate-800">{assigneeText(c)}</dd></div>
              <div><dt className="text-xs text-slate-500">{t("accidentFlow.status.nextAction")}</dt><dd className="mt-0.5 text-slate-800">{nextActionLabel(stage)}</dd></div>
              <div><dt className="text-xs text-slate-500">{t("accidentFlow.status.sla")}</dt><dd className="mt-0.5 text-slate-800">{c.slaDueAt ? <span className={c.overdue ? "font-semibold text-amber-700" : ""}>{formatDate(c.slaDueAt)}{c.overdue ? ` — ${t("accidentFlow.badge.overdue")}` : ""}</span> : "—"}</dd></div>
            </dl>
          </Card>
          <HistorySection c={c} />
        </div>
      </div>
      <MoveDialog mode={move} c={c} onClose={() => setMove(null)} onDone={reload} />
      <AssignDialog open={assign} c={c} onClose={() => setAssign(false)} onDone={reload} />
      <EditDraftDialog open={edit} c={c} onClose={() => setEdit(false)} onDone={reload} />
    </>
  );
}

