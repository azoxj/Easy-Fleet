import { t } from "../../../i18n";
import { Badge } from "../../../components/ui";
import { STAGE_TONE, stageLabel, type WorkflowStage } from "../../../lib/accidentWorkflow";

type FlowRow = { workflowStage?: string | null; returnedForCompletion?: boolean; overdue?: boolean; preliminary?: boolean };

/** The stage of a workflow case as a badge. */
export function StageBadge({ stage }: { stage: string }) {
  return <Badge tone={STAGE_TONE[stage as WorkflowStage] ?? "gray"}>{stageLabel(stage)}</Badge>;
}

/** Flags of a workflow case: returned for completion, overdue, preliminary report. Nothing for legacy accidents. */
export function CaseFlags({ row }: { row: FlowRow }) {
  if (!row.workflowStage) return null;
  return (
    <span className="flex flex-wrap items-center gap-1">
      {row.returnedForCompletion && <Badge tone="red" dot>{t("accidentFlow.badge.returned")}</Badge>}
      {row.overdue && <Badge tone="amber" dot>{t("accidentFlow.badge.overdue")}</Badge>}
      {row.workflowStage === "DRAFT" && row.preliminary && <Badge tone="violet">{t("accidentFlow.badge.preliminary")}</Badge>}
    </span>
  );
}
