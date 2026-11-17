import { useState } from "react";
import { Link } from "react-router";
import { Badge, Card, EmptyState, Input, Loading, Pagination, Select, Tabs } from "../../../components/ui";
import { useApi } from "../../../hooks/useApi";
import { t } from "../../../i18n";
import type { Paged } from "../../../lib/api";
import { boardLaneLabel, claimStatusLabel, boardRoleLabel, responsibleLabel, STAGES, stageLabel, type BoardCounts, type BoardRole, type BoardRow } from "../../../lib/accidentWorkflow";
import { formatDateTime } from "../../../lib/format";
import { CaseFlags, StageBadge } from "./AccidentBadges";

type BoardResponse = Paged<BoardRow> & { boards: BoardCounts; role: BoardRole | null; lane: string | null };

/**
 * The work board of the person's duty: one list per lane with its count, search and stage filter, the stage, the responsible
 * party and the last action. The server returns only the cases this user may read; lanes never widen access.
 */
export function CaseBoard() {
  const [role, setRole] = useState<BoardRole | "">("");
  const [lane, setLane] = useState("");
  const [q, setQ] = useState("");
  const [stage, setStage] = useState("");
  const [page, setPage] = useState(1);
  const { data, loading, error } = useApi<BoardResponse>("/accident-cases/board", { role: role || undefined, lane: lane || undefined, q: q.trim() || undefined, stage: stage || undefined, page });
  if (!data && loading) return <Loading />;
  // Users with no duty on the cases (readers) have no board: the plain list below is their screen.
  if (error || !data || data.boards.length === 0 || !data.role) return null;
  const active = data.role;
  const board = data.boards.find((b) => b.role === active)!;
  const laneKey = data.lane ?? board.lanes[0]!.key;
  const reset = () => setPage(1);
  return (
    <Card>
      <div className="space-y-3 border-b border-slate-100 px-4 py-3" data-testid="case-board">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <p className="text-sm font-semibold text-slate-800">{t("accidentFlow.board.title")}</p>
          {data.boards.length > 1 && (
            <Select value={active} aria-label={t("accidentFlow.board.title")} onChange={(e) => { setRole(e.target.value as BoardRole); setLane(""); reset(); }}>
              {data.boards.map((b) => <option key={b.role} value={b.role}>{boardRoleLabel(b.role)}</option>)}
            </Select>
          )}
        </div>
        <Tabs
          tabs={board.lanes.map((l) => ({ key: l.key, label: `${boardLaneLabel(active, l.key)} (${l.count})` }))}
          active={laneKey}
          onChange={(k) => { setLane(k); reset(); }}
        />
        <div className="flex flex-wrap gap-2">
          <Input className="max-w-xs" aria-label={t("accidentFlow.board.search")} placeholder={t("accidentFlow.board.search")} value={q} onChange={(e) => { setQ(e.target.value); reset(); }} />
          <Select value={stage} aria-label={t("common.status")} onChange={(e) => { setStage(e.target.value); reset(); }}>
            <option value="">{t("accidentFlow.board.allStages")}</option>
            {STAGES.map((s) => <option key={s} value={s}>{stageLabel(s)}</option>)}
          </Select>
        </div>
      </div>
      {data.data.length === 0 ? <EmptyState icon="alert" title={t("accidentFlow.board.empty")} /> : (
        <>
          <ul className="divide-y divide-slate-100" data-testid="board-rows">
            {data.data.map((r) => (
              <li key={r.id} className="flex flex-wrap items-center justify-between gap-x-6 gap-y-2 px-4 py-3 text-sm">
                <div className="min-w-0 space-y-1">
                  <p className="flex flex-wrap items-center gap-2">
                    <Link to={`/accidents/${r.id}`} className="font-semibold ltr hover:text-brand-700">{r.label}</Link>
                    <span className="ltr text-slate-700">{r.plateNumber}</span>
                    <CaseFlags row={{ workflowStage: r.stage, returnedForCompletion: r.returnedForCompletion, overdue: r.overdue }} />
                  </p>
                  <p className="text-xs text-slate-500">{r.projectName ?? "—"}</p>
                </div>
                <div className="flex flex-wrap items-center gap-x-6 gap-y-1.5 text-xs text-slate-600">
                  <StageBadge stage={r.stage} />
                  <span><span className="text-slate-400">{t("accidentFlow.board.responsible")}: </span>{r.assignedToName ?? responsibleLabel(r.responsible)}</span>
                  <span><span className="text-slate-400">{t("accidentFlow.board.lastAction")}: </span>{formatDateTime(r.lastActionAt)}</span>
                  {r.claimStatus && <Badge tone="blue">{claimStatusLabel(r.claimStatus)}</Badge>}
                </div>
              </li>
            ))}
          </ul>
          <Pagination {...data.meta} onPage={setPage} />
        </>
      )}
    </Card>
  );
}
