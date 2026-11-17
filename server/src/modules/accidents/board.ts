import { and, desc, eq, ilike, inArray, or, sql, type SQL } from "drizzle-orm";
import type { Router } from "express";
import { z } from "zod";
import type { Access } from "../../auth/access.js";
import { db } from "../../db/client.js";
import { accidents, projects, vehicles } from "../../db/schema/index.js";
import { ctx } from "../../http/context.js";
import { badRequest } from "../../http/errors.js";
import { paged, pagination, uuid } from "../../http/validate.js";
import { loadSla } from "./sla.js";
import { now } from "../../lib/clock.js";
import { returnedMarker } from "./filters.js";
import { caseVisibility, holdsScopedSql } from "./visibility.js";
import { isOverdue, WORKFLOW_STAGES, type WorkflowStage } from "./workflow.js";

/** Who works on a case in each stage: the role shown as "responsible" on every board. */
export type Responsible = "PROJECT_MANAGER" | "TECHNICAL" | "INSURANCE" | "FINANCE" | "ADMIN" | "NONE";
export function responsibleFor(stage: WorkflowStage): Responsible {
  switch (stage) {
    case "DRAFT":
    case "AWAITING_ESTIMATES":
      return "PROJECT_MANAGER";
    case "AWAITING_TECHNICAL":
    case "AWAITING_TECHNICAL_DECISION":
    case "REPAIR_IN_PROGRESS":
    case "AWAITING_TECHNICAL_FINAL":
      return "TECHNICAL";
    case "AWAITING_INSURANCE":
    case "CLAIM_IN_PROGRESS":
    case "AWAITING_COMPENSATION_PROOF":
      return "INSURANCE";
    case "AWAITING_FINANCE_REVIEW":
      return "FINANCE";
    case "AWAITING_FINAL_CLOSURE":
      return "ADMIN";
    default:
      return "NONE";
  }
}

export type BoardRole = "PROJECT_MANAGER" | "TECHNICAL" | "INSURANCE" | "FINANCE" | "ADMIN";

const TECH_STAGES = ["AWAITING_TECHNICAL", "AWAITING_ESTIMATES", "AWAITING_TECHNICAL_DECISION", "REPAIR_IN_PROGRESS", "AWAITING_TECHNICAL_FINAL"];
const INSURANCE_STAGES = ["AWAITING_INSURANCE", "CLAIM_IN_PROGRESS", "AWAITING_COMPENSATION_PROOF"];

const stageIn = (...stages: WorkflowStage[]): SQL => inArray(accidents.workflowStage, stages);
const inList = (items: string[]) => sql.join(items.map((x) => sql`${x}`), sql`, `);
/** The user had the case in this family of stages (now or before): the officer's own history. */
const handled = (a: Access, stages: string[]): SQL =>
  sql`exists (select 1 from accident_assignments aa where aa.accident_id = ${accidents.id} and aa.assigned_to = ${a.userId} and aa.stage in (${inList(stages)}))`;
const claimIs = (...statuses: string[]): SQL => sql`exists (select 1 from accident_claims c where c.accident_id = ${accidents.id} and c.status in (${inList(statuses)}))`;
const insurancePath = claimIs("APPROVED", "COMPENSATION_RECEIVED");
const financeReview = (a: Access, status: "CONFIRMED" | "RETURNED"): SQL =>
  sql`exists (select 1 from accident_finance_reviews fr where fr.accident_id = ${accidents.id} and fr.reviewed_by = ${a.userId} and fr.status = ${status})`;

type Lane = { key: string; where: (a: Access) => SQL };
type Board = { role: BoardRole; lanes: Lane[] };

const BOARDS: Record<BoardRole, Board> = {
  PROJECT_MANAGER: {
    role: "PROJECT_MANAGER",
    lanes: [
      { key: "mine", where: (a) => or(eq(accidents.createdBy, a.userId), eq(accidents.reportedBy, a.userId))! },
      { key: "returned", where: (a) => and(sql`${accidents.workflowStage} = 'DRAFT'`, returnedMarker, holdsScopedSql(a, "accidents.update"))! },
      { key: "estimates", where: (a) => and(stageIn("AWAITING_ESTIMATES"), holdsScopedSql(a, "accidents.update"))! },
      { key: "completed", where: (a) => and(stageIn("CLOSED"), holdsScopedSql(a, "accidents.update"))! },
    ],
  },
  TECHNICAL: {
    role: "TECHNICAL",
    lanes: [
      { key: "new", where: (a) => and(stageIn("AWAITING_TECHNICAL"), eq(accidents.assignedTo, a.userId))! },
      { key: "waitingEstimates", where: (a) => and(stageIn("AWAITING_ESTIMATES"), handled(a, TECH_STAGES))! },
      { key: "decision", where: (a) => and(stageIn("AWAITING_TECHNICAL_DECISION"), eq(accidents.assignedTo, a.userId))! },
      { key: "external", where: (a) => and(stageIn("REPAIR_IN_PROGRESS", "AWAITING_INSURANCE", "CLAIM_IN_PROGRESS", "AWAITING_COMPENSATION_PROOF", "AWAITING_FINANCE_REVIEW"), handled(a, TECH_STAGES))! },
      { key: "fromFinance", where: (a) => and(stageIn("AWAITING_TECHNICAL_FINAL"), eq(accidents.assignedTo, a.userId))! },
      { key: "readyToClose", where: (a) => and(stageIn("AWAITING_FINAL_CLOSURE"), handled(a, TECH_STAGES))! },
    ],
  },
  INSURANCE: {
    role: "INSURANCE",
    lanes: [
      { key: "new", where: (a) => and(stageIn("AWAITING_INSURANCE"), eq(accidents.assignedTo, a.userId))! },
      { key: "inProgress", where: (a) => and(stageIn("CLAIM_IN_PROGRESS"), eq(accidents.assignedTo, a.userId))! },
      { key: "rejected", where: (a) => and(claimIs("REJECTED"), handled(a, INSURANCE_STAGES))! },
      { key: "awaitingTransfer", where: (a) => and(stageIn("AWAITING_COMPENSATION_PROOF"), eq(accidents.assignedTo, a.userId))! },
      { key: "atFinance", where: (a) => and(stageIn("AWAITING_FINANCE_REVIEW"), insurancePath, handled(a, INSURANCE_STAGES))! },
      { key: "completed", where: (a) => and(claimIs("COMPENSATION_RECEIVED"), handled(a, INSURANCE_STAGES))! },
    ],
  },
  FINANCE: {
    role: "FINANCE",
    lanes: [
      { key: "invoices", where: () => and(stageIn("AWAITING_FINANCE_REVIEW"), sql`not ${insurancePath}`)! },
      { key: "transfers", where: () => and(stageIn("AWAITING_FINANCE_REVIEW"), insurancePath)! },
      { key: "returned", where: (a) => and(stageIn("REPAIR_IN_PROGRESS", "AWAITING_COMPENSATION_PROOF"), financeReview(a, "RETURNED"))! },
      { key: "approved", where: (a) => financeReview(a, "CONFIRMED") },
    ],
  },
  ADMIN: {
    role: "ADMIN",
    lanes: [
      { key: "ready", where: () => stageIn("AWAITING_FINAL_CLOSURE") },
      { key: "open", where: () => sql`${accidents.workflowStage} not in ('CLOSED', 'DRAFT')` },
      { key: "closed", where: () => stageIn("CLOSED") },
      { key: "all", where: () => sql`true` },
    ],
  },
};

/** The boards a user has: one per duty his permissions give him (an administrator has all of them). */
export function boardsFor(a: Access): Board[] {
  const out: Board[] = [];
  if (a.has("accidents.update") || a.has("accidents.create")) out.push(BOARDS.PROJECT_MANAGER);
  if (a.has("accidents.review.technical")) out.push(BOARDS.TECHNICAL);
  if (a.has("accidents.claims.manage")) out.push(BOARDS.INSURANCE);
  if (a.has("accidents.finance.review")) out.push(BOARDS.FINANCE);
  if (a.has("accidents.close")) out.push(BOARDS.ADMIN);
  return out;
}

const Query = pagination.extend({
  role: z.enum(["PROJECT_MANAGER", "TECHNICAL", "INSURANCE", "FINANCE", "ADMIN"]).optional(),
  lane: z.string().trim().max(40).optional(),
  q: z.string().trim().max(100).optional(),
  projectId: uuid.optional(),
  stage: z.enum(WORKFLOW_STAGES as [WorkflowStage, ...WorkflowStage[]]).optional(),
});

/**
 * The work lists of the roles. A user sees the lanes of the duties his permissions give him; a lane only ever holds cases the
 * visibility rule already lets him read (project scope, assignment, the finance window), so a lane never widens access.
 */
export function registerBoard(router: Router, perm: (p: "accidents.read") => ReturnType<typeof import("../../http/middleware.js").requirePermission>) {
  router.get("/accident-cases/board", perm("accidents.read"), async (req, res) => {
    const { access } = ctx(req);
    const q = Query.parse(req.query);
    const boards = boardsFor(access);
    const shared: SQL[] = [eq(accidents.organizationId, access.orgId), sql`${accidents.workflowStage} is not null`, caseVisibility(access)];
    const board = boards.find((b) => b.role === q.role) ?? boards[0];
    // A user with no duty on the cases (a reader) has no board: the screen then shows the plain list.
    const counts = await Promise.all(
      boards.map(async (b) => ({
        role: b.role,
        lanes: await Promise.all(
          b.lanes.map(async (l) => {
            const [c] = await db.select({ n: sql<number>`count(*)::int` }).from(accidents).where(and(...shared, l.where(access)));
            return { key: l.key, count: c?.n ?? 0 };
          }),
        ),
      })),
    );
    if (!board) return void res.json({ ...paged([], 0, q.page, q.pageSize), boards: [], role: null, lane: null });
    const lane = board.lanes.find((l) => l.key === q.lane) ?? board.lanes[0]!;
    if (q.lane && lane.key !== q.lane) throw badRequest("unknown lane");
    const where: SQL[] = [...shared, lane.where(access)];
    if (q.projectId) where.push(eq(accidents.projectId, q.projectId));
    if (q.stage) where.push(eq(accidents.workflowStage, q.stage));
    if (q.q) {
      const m = /^acc-?(\d+)$/i.exec(q.q);
      const like = `%${q.q.replace(/[%_\\]/g, "\\$&")}%`;
      where.push(m ? eq(accidents.number, Number(m[1])) : ilike(vehicles.plateNumber, like));
    }
    const cond = and(...where);
    const [rows, [total], sla] = await Promise.all([
      db
        .select({
          id: accidents.id,
          number: accidents.number,
          plateNumber: vehicles.plateNumber,
          projectId: accidents.projectId,
          projectName: projects.name,
          stage: accidents.workflowStage,
          status: accidents.status,
          assignedTo: accidents.assignedTo,
          assignedToName: sql<string | null>`(select name from users where id = ${accidents.assignedTo})`,
          stageEnteredAt: accidents.stageEnteredAt,
          updatedAt: accidents.updatedAt,
          lastActionAt: sql<Date>`coalesce((select max(t.created_at) from accident_transitions t where t.accident_id = ${accidents.id}), ${accidents.updatedAt})`,
          returnedForCompletion: sql<boolean>`${returnedMarker}`,
          claimStatus: sql<string | null>`(select c.status from accident_claims c where c.accident_id = ${accidents.id})`,
        })
        .from(accidents)
        .innerJoin(vehicles, eq(vehicles.id, accidents.vehicleId))
        .leftJoin(projects, eq(projects.id, accidents.projectId))
        .where(cond)
        .orderBy(desc(accidents.stageEnteredAt), desc(accidents.number))
        .limit(q.pageSize)
        .offset((q.page - 1) * q.pageSize),
      db.select({ n: sql<number>`count(*)::int` }).from(accidents).innerJoin(vehicles, eq(vehicles.id, accidents.vehicleId)).where(cond),
      loadSla(db, access.orgId),
    ]);
    const at = now();
    const data = rows.map((r) => {
      const stage = r.stage as WorkflowStage;
      return {
        ...r,
        label: `ACC-${r.number}`,
        responsible: responsibleFor(stage),
        overdue: r.stageEnteredAt ? isOverdue(stage, r.stageEnteredAt, at, sla) : false,
      };
    });
    res.json({ ...paged(data, total?.n ?? 0, q.page, q.pageSize), boards: counts, role: board.role, lane: lane.key });
  });
}
