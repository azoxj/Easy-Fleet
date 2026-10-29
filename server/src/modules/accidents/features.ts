import { and, eq, sql } from "drizzle-orm";
import { Router } from "express";
import { db } from "../../db/client.js";
import { accidents } from "../../db/schema/index.js";
import { ctx } from "../../http/context.js";
import { requirePermission } from "../../http/middleware.js";
import { now } from "../../lib/clock.js";
import { accidentWorkflowEnabled } from "../../lib/feature-flags.js";
import { notDraft, returnedMarker } from "./filters.js";
import { loadSla } from "./sla.js";
import { caseVisibility, draftVisibility } from "./visibility.js";
import { accidentScope } from "../operations/accidents.js";
import { isOverdue, type WorkflowStage } from "./workflow.js";

/** Always available (whatever the workflow switch says): what the accidents screen may show, and its summary figures. */
export const accidentFeaturesRouter = Router();

accidentFeaturesRouter.get("/accidents/features", requirePermission("accidents.read"), (_req, res) => {
  res.json({ data: { workflow: accidentWorkflowEnabled() } });
});

/**
 * Summary figures for the accidents screen. Drafts are not accidents: open, closed and overdue never count them,
 * they are reported on their own line.
 */
accidentFeaturesRouter.get("/accidents/stats", requirePermission("accidents.read"), async (req, res) => {
  const { access } = ctx(req);
  const visible = and(eq(accidents.organizationId, access.orgId), caseVisibility(access))!;
  const actual = and(visible, notDraft)!;
  const [[row], openCases, sla] = await Promise.all([
    db
      .select({
        open: sql<number>`count(*) filter (where ${accidents.status} <> 'CLOSED')::int`,
        closed: sql<number>`count(*) filter (where ${accidents.status} = 'CLOSED')::int`,
        awaitingAssignment: sql<number>`count(*) filter (where ${accidents.workflowStage} is not null and ${accidents.assignedTo} is null and ${accidents.assignmentMode} = 'QUEUE' and ${accidents.status} <> 'CLOSED')::int`,
        returned: sql<number>`count(*) filter (where ${returnedMarker})::int`,
        assignedToMe: sql<number>`count(*) filter (where ${accidents.assignedTo} = ${access.userId} and ${accidents.status} <> 'CLOSED')::int`,
        claims: sql<number>`count(*) filter (where ${accidents.status} = 'INSURANCE')::int`,
      })
      .from(accidents)
      .where(actual),
    db.select({ stage: accidents.workflowStage, enteredAt: accidents.stageEnteredAt }).from(accidents).where(and(actual, sql`${accidents.workflowStage} is not null and ${accidents.status} <> 'CLOSED'`)),
    loadSla(db, access.orgId),
  ]);
  const at = now();
  const overdue = openCases.filter((c) => c.stage && c.enteredAt && isOverdue(c.stage as WorkflowStage, c.enteredAt, at, sla)).length;
  const [drafts] = await db
    .select({ n: sql<number>`count(*)::int` })
    .from(accidents)
    .where(and(eq(accidents.organizationId, access.orgId), accidentScope(access), draftVisibility(access), sql`${accidents.workflowStage} = 'DRAFT'`));
  res.json({
    data: {
      open: row?.open ?? 0,
      closed: row?.closed ?? 0,
      overdue,
      // Only the people who assign see the queue figure.
      awaitingAssignment: access.has("accidents.assign") ? (row?.awaitingAssignment ?? 0) : null,
      returned: row?.returned ?? 0,
      assignedToMe: row?.assignedToMe ?? 0,
      claims: row?.claims ?? 0,
      drafts: drafts?.n ?? 0,
    },
  });
});
