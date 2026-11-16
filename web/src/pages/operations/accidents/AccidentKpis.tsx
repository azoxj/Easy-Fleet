import { StatCard } from "../../../components/ui";
import { useApi } from "../../../hooks/useApi";
import { t } from "../../../i18n";

export type AccidentStats = { open: number; closed: number; overdue: number; awaitingAssignment: number | null; returned: number; assignedToMe: number; claims: number; drafts: number };

/**
 * Short figures above the list. Drafts are not accidents: they are never in open/closed/overdue and are mentioned on their own line.
 * Overdue and awaiting-assignment only exist for workflow cases; the queue figure is shown to the people who assign.
 */
export function AccidentKpis({ workflow, showDrafts }: { workflow: boolean; showDrafts: boolean }) {
  const { data } = useApi<{ data: AccidentStats }>("/accidents/stats");
  const s = data?.data;
  if (!s) return null;
  return (
    <div className="mb-4 space-y-2">
      <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
        <StatCard label={t("accidentFlow.kpi.open")} value={s.open} icon="alert" tone="red" to="/accidents?open=true" />
        <StatCard label={t("accidentFlow.kpi.closed")} value={s.closed} icon="check" tone="gray" to="/accidents?status=CLOSED" />
        {workflow && <StatCard label={t("accidentFlow.kpi.overdue")} value={s.overdue} icon="clock" tone={s.overdue > 0 ? "amber" : "gray"} />}
        {workflow && s.awaitingAssignment !== null && <StatCard label={t("accidentFlow.kpi.awaitingAssignment")} value={s.awaitingAssignment} icon="inbox" tone={s.awaitingAssignment > 0 ? "violet" : "gray"} to="/accidents?view=queue" />}
      </div>
      {workflow && showDrafts && s.drafts > 0 && <p className="text-xs text-slate-500">{t("accidentFlow.kpi.draftsNote", { count: s.drafts })}</p>}
    </div>
  );
}
