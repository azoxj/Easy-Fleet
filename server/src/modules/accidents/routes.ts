import { and, desc, eq, ilike, isNull, or, sql, type SQL } from "drizzle-orm";
import { Router } from "express";
import { z } from "zod";
import { loadAccess, permissionHolders, type Access } from "../../auth/access.js";
import { db } from "../../db/client.js";
import {
  accidentAssignments,
  accidentAttachments,
  accidentClaims,
  accidentEstimates,
  accidentResponsibility,
  accidentSeverity,
  accidentSettings,
  accidentStageOfficers,
  accidentTransitions,
  accidents,
  files,
  projects,
  users,
  vehicles,
} from "../../db/schema/index.js";
import { ctx } from "../../http/context.js";
import { badRequest, forbidden, HttpError, notFound } from "../../http/errors.js";
import { requirePermission } from "../../http/middleware.js";
import { idParam, isoDate, money, optionalText, paged, pagination, trimmed, uuid } from "../../http/validate.js";
import { tr } from "../../i18n/index.js";
import { now } from "../../lib/clock.js";
import { accidentWorkflowEnabled } from "../../lib/feature-flags.js";
import { uploadRateLimit } from "../../lib/pg-rate-limit.js";
import { audit, diff } from "../../services/audit.js";
import { notifyUsers } from "../../services/notifications.js";
import { sendStoredFile, storeUpload } from "../../services/storage.js";
import { accLabel, accidentRecipients } from "../operations/accidents.js";
import { assertNotFuture, driverNameSql, rawUpload, resolveDriver, vehicleForCreate } from "../operations/common.js";
import { sensitiveInputFor, visibleAttachments } from "./attachment-access.js";
import { ATTACHMENT_CATEGORIES, canUploadAttachment, canViewAttachment, SINGLE_DOCUMENT_CATEGORIES } from "./attachments-policy.js";
import { loadSla } from "./sla.js";
import { FAMILY_PERMISSION, loadFacts, lockCase, moveStage, requiredActionFor, stageFamily, stageOf, type Case } from "./case-service.js";
import { CLAIM_FLOW, missingForClaimStatus, missingForTransition, STAGE_AFTER_CLAIM, type ClaimStatus } from "./requirements.js";
import { returnedMarker } from "./filters.js";
import { caseVisibility, handlesProject, holdsScoped, isAssigneeOrAssigner } from "./visibility.js";
import { evaluateTransition, isOverdue, slaDueAt, WORKFLOW_STAGES, type WorkflowStage } from "./workflow.js";

export const accidentCasesRouter = Router();

// The whole workflow API is dark unless ACCIDENT_WORKFLOW_ENABLED is on: it answers like a route that does not exist.
accidentCasesRouter.use("/accident-cases", (_req, _res, next) => (accidentWorkflowEnabled() ? next() : next(notFound(tr("المسار غير موجود")))));

const Geo = {
  latitude: z.coerce.number().min(-90).max(90).nullable().optional(),
  longitude: z.coerce.number().min(-180).max(180).nullable().optional(),
};
const stageEnum = z.enum(WORKFLOW_STAGES as [WorkflowStage, ...WorkflowStage[]]);
const requirementsNotMet = (missing: string[]) => new HttpError(409, "REQUIREMENTS_NOT_MET", tr("متطلبات الانتقال غير مستكملة"), { missing });
const noSuchCase = () => notFound(tr("الحادث غير موجود"));

/** Permission held for the case: ALL, PROJECT as a member, or the case is theirs. Throws 403 otherwise. */
function requireHeld(a: Access, perm: Parameters<Access["scopeOf"]>[0], ok: boolean): void {
  if (!a.has(perm) || !ok) throw forbidden();
}

// ───────────────────────────── list ─────────────────────────────

const ListQuery = pagination.extend({
  q: z.string().trim().max(100).optional(),
  stage: stageEnum.optional(),
  projectId: uuid.optional(),
  vehicleId: uuid.optional(),
  mine: z.enum(["true", "false"]).optional(),
  returned: z.enum(["true", "false"]).optional(),
  queue: z.enum(["true", "false"]).optional(),
});

accidentCasesRouter.get("/accident-cases", requirePermission("accidents.read"), async (req, res) => {
  const { access } = ctx(req);
  const q = ListQuery.parse(req.query);
  const where: SQL[] = [eq(accidents.organizationId, access.orgId), sql`${accidents.workflowStage} is not null`, caseVisibility(access)];
  if (q.stage) where.push(eq(accidents.workflowStage, q.stage));
  if (q.projectId) where.push(eq(accidents.projectId, q.projectId));
  if (q.vehicleId) where.push(eq(accidents.vehicleId, q.vehicleId));
  if (q.mine === "true") where.push(eq(accidents.assignedTo, access.userId));
  if (q.returned === "true") where.push(returnedMarker);
  if (q.queue === "true") {
    // The queue is for the people who assign: they see unassigned cases of the stages that have an officer.
    if (!(access.has("accidents.assign"))) throw forbidden();
    where.push(sql`${accidents.assignedTo} is null and ${accidents.assignmentMode} = 'QUEUE'`);
  }
  if (q.q) {
    const m = /^acc-?(\d+)$/i.exec(q.q);
    const like = `%${q.q.replace(/[%_\\]/g, "\\$&")}%`;
    where.push(m ? eq(accidents.number, Number(m[1])) : or(ilike(vehicles.plateNumber, like), ilike(accidents.description, like))!);
  }
  const cond = and(...where);
  const [rows, [count], sla] = await Promise.all([
    db
      .select({
        id: accidents.id,
        number: accidents.number,
        occurredAt: accidents.occurredAt,
        plateNumber: vehicles.plateNumber,
        projectName: projects.name,
        severity: accidents.severity,
        stage: accidents.workflowStage,
        status: accidents.status,
        assignedTo: accidents.assignedTo,
        assignedToName: sql<string | null>`(select name from users where id = ${accidents.assignedTo})`,
        assignmentMode: accidents.assignmentMode,
        stageEnteredAt: accidents.stageEnteredAt,
        createdAt: accidents.createdAt,
        preliminary: sql<boolean>`${accidents.reportedBy} is not null`,
        returnedForCompletion: sql<boolean>`${returnedMarker}`,
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
  res.json(
    paged(
      rows.map((r) => ({ ...r, label: accLabel(r.number), slaDueAt: r.stageEnteredAt ? slaDueAt(r.stage as WorkflowStage, r.stageEnteredAt, sla) : null, overdue: r.stageEnteredAt ? isOverdue(r.stage as WorkflowStage, r.stageEnteredAt, at, sla) : false })),
      count?.n ?? 0,
      q.page,
      q.pageSize,
    ),
  );
});

// ───────────────────────── SLA settings (static path before /:id) ─────────────────────────
const SLA_KEYS = ["slaTechnicalDays", "slaEstimatesDays", "slaInsuranceDays", "slaClosureDays"] as const;
const SlaBody = z.object(Object.fromEntries(SLA_KEYS.map((k) => [k, z.number().int().min(1).max(90)])) as Record<(typeof SLA_KEYS)[number], z.ZodNumber>).strict();

/**
 * Editing the delay limits is organisation-wide and has its own permission: accidents.settings.manage (ALL), or the general
 * administrator's settings.manage (ALL). accidents.assign, whatever its scope, does not allow it.
 */
const canEditSla = (a: Access) => a.scopeOf("accidents.settings.manage") === "ALL" || a.scopeOf("settings.manage") === "ALL";

accidentCasesRouter.get("/accident-cases/settings", requirePermission("accidents.read"), async (req, res) => {
  const { access } = ctx(req);
  // Seeing the limits is for the people who assign or manage them; everyone else sees only their own deadlines on the cases.
  if (!access.has("accidents.assign") && !access.has("accidents.settings.manage") && !canEditSla(access)) throw forbidden();
  res.json({ data: { ...(await loadSla(db, access.orgId)), canEdit: canEditSla(access) } });
});

accidentCasesRouter.put("/accident-cases/settings", requirePermission("accidents.read"), async (req, res) => {
  const { access } = ctx(req);
  if (!canEditSla(access)) throw forbidden();
  const b = SlaBody.parse(req.body);
  const saved = await db.transaction(async (tx) => {
    // The row is created on first use; locking it serialises concurrent edits so the audit trail matches what was stored.
    await tx.insert(accidentSettings).values({ organizationId: access.orgId }).onConflictDoNothing();
    const [before] = await tx.select().from(accidentSettings).where(eq(accidentSettings.organizationId, access.orgId)).for("update");
    const changes = diff(before as unknown as Record<string, unknown>, b as Record<string, unknown>);
    if (Object.keys(changes).length === 0) return { changed: false, values: b };
    await tx.update(accidentSettings).set({ ...b, updatedBy: access.userId, updatedAt: now() }).where(eq(accidentSettings.organizationId, access.orgId));
    await audit(tx, req, { action: "ACCIDENT_CASE_SETTINGS", entity: "accident_settings", entityId: access.orgId, metadata: { changes } });
    return { changed: true, values: b };
  });
  res.json({ data: { ...saved.values, canEdit: true, changed: saved.changed } });
});

// ───────────────────────── officers (static paths before /:id) ─────────────────────────
const OfficerBody = z.object({ stage: z.enum(["TECHNICAL", "INSURANCE"]), userId: uuid, projectId: uuid.nullable().optional() }).strict();

/** Designating officers needs accidents.assign: ALL scope for organisation-wide, PROJECT scope for that project only. */
function assertCanDesignate(a: Access, projectId: string | null) {
  const s = a.scopeOf("accidents.assign");
  if (!s) throw forbidden();
  if (s === "ALL") return;
  if (s === "PROJECT" && projectId && a.isMemberOf(projectId)) return;
  throw forbidden();
}

accidentCasesRouter.get("/accident-cases/officers", requirePermission("accidents.assign"), async (req, res) => {
  const { access } = ctx(req);
  const rows = await db
    .select({ id: accidentStageOfficers.id, stage: accidentStageOfficers.stage, userId: accidentStageOfficers.userId, userName: users.name, userStatus: users.status, projectId: accidentStageOfficers.projectId, projectName: projects.name, createdAt: accidentStageOfficers.createdAt })
    .from(accidentStageOfficers)
    .innerJoin(users, eq(users.id, accidentStageOfficers.userId))
    .leftJoin(projects, eq(projects.id, accidentStageOfficers.projectId))
    .where(eq(accidentStageOfficers.organizationId, access.orgId))
    .orderBy(accidentStageOfficers.stage, users.name);
  res.json({ data: rows.filter((r) => holdsScoped(access, "accidents.assign", r.projectId) || (r.projectId === null && access.scopeOf("accidents.assign") === "ALL")) });
});

accidentCasesRouter.post("/accident-cases/officers", requirePermission("accidents.assign"), async (req, res) => {
  const { access } = ctx(req);
  const b = OfficerBody.parse(req.body);
  const projectId = b.projectId ?? null;
  assertCanDesignate(access, projectId);
  const row = await db.transaction(async (tx) => {
    if (projectId) {
      const [p] = await tx.select({ id: projects.id }).from(projects).where(and(eq(projects.id, projectId), eq(projects.organizationId, access.orgId)));
      if (!p) throw notFound(tr("المشروع غير موجود"));
    }
    const [u] = await tx.select({ id: users.id, status: users.status }).from(users).where(and(eq(users.id, b.userId), eq(users.organizationId, access.orgId)));
    if (!u || u.status !== "ACTIVE") throw notFound(tr("المستخدم غير موجود"));
    if (!(await loadAccess(tx, u.id, access.orgId)).has(FAMILY_PERMISSION[b.stage])) throw badRequest(tr("المستخدم لا يملك الصلاحية اللازمة لهذه المرحلة"));
    const [o] = await tx.insert(accidentStageOfficers).values({ organizationId: access.orgId, projectId, stage: b.stage, userId: u.id, createdBy: access.userId }).returning();
    await audit(tx, req, { action: "ACCIDENT_CASE_OFFICERS", entity: "accident_officer", entityId: o!.id, projectId, metadata: { op: "designated", stage: b.stage, userId: u.id } });
    return o!;
  });
  res.status(201).json({ data: row });
});

/** Who the screen may offer for a stage (and project): active people who hold the permission that stage needs. */
accidentCasesRouter.get("/accident-cases/officers/candidates", requirePermission("accidents.assign"), async (req, res) => {
  const { access } = ctx(req);
  const q = z.object({ stage: z.enum(["TECHNICAL", "INSURANCE"]), projectId: uuid.optional() }).parse(req.query);
  assertCanDesignate(access, q.projectId ?? null);
  const perm = FAMILY_PERMISSION[q.stage];
  // Any active holder of the permission may be designated (the server checks it again on save); for a project the members come first.
  const rows = await db.execute<{ id: string; name: string; member: boolean }>(sql`
    select distinct u.id, u.name,
           ${q.projectId ? sql`(exists (select 1 from project_users pu where pu.project_id = ${q.projectId} and pu.user_id = u.id) or exists (select 1 from projects p where p.id = ${q.projectId} and p.manager_id = u.id))` : sql`false`} as member
      from users u
      join user_roles ur on ur.user_id = u.id
      join roles r on r.id = ur.role_id and (r.organization_id is null or r.organization_id = ${access.orgId})
      join role_permissions rp on rp.role_id = r.id
      join permissions pm on pm.id = rp.permission_id
     where u.organization_id = ${access.orgId} and u.status = 'ACTIVE' and pm.key = ${perm}
     order by member desc, u.name`);
  res.json({ data: rows.rows });
});

/** Replaces the person of a designation (atomic: the designation keeps its stage and project). */
accidentCasesRouter.put("/accident-cases/officers/:id", requirePermission("accidents.assign"), async (req, res) => {
  const { access } = ctx(req);
  const { id } = idParam.parse(req.params);
  const b = z.object({ userId: uuid }).strict().parse(req.body);
  const row = await db.transaction(async (tx) => {
    const [o] = await tx.select().from(accidentStageOfficers).where(and(eq(accidentStageOfficers.id, id), eq(accidentStageOfficers.organizationId, access.orgId))).for("update");
    if (!o) throw notFound(tr("التعيين غير موجود"));
    assertCanDesignate(access, o.projectId);
    if (o.userId === b.userId) throw new HttpError(409, "ALREADY_DESIGNATED", tr("هذا الموظف معيّن بالفعل لهذه المرحلة"));
    const [u] = await tx.select({ id: users.id, status: users.status }).from(users).where(and(eq(users.id, b.userId), eq(users.organizationId, access.orgId)));
    if (!u || u.status !== "ACTIVE") throw notFound(tr("المستخدم غير موجود"));
    if (!(await loadAccess(tx, u.id, access.orgId)).has(FAMILY_PERMISSION[o.stage])) throw badRequest(tr("المستخدم لا يملك الصلاحية اللازمة لهذه المرحلة"));
    const [n] = await tx.update(accidentStageOfficers).set({ userId: u.id, createdBy: access.userId, createdAt: now() }).where(eq(accidentStageOfficers.id, id)).returning();
    await audit(tx, req, { action: "ACCIDENT_CASE_OFFICERS", entity: "accident_officer", entityId: id, projectId: o.projectId, metadata: { op: "replaced", stage: o.stage, from: o.userId, to: u.id } });
    return n!;
  });
  res.json({ data: row });
});

accidentCasesRouter.delete("/accident-cases/officers/:id", requirePermission("accidents.assign"), async (req, res) => {
  const { access } = ctx(req);
  const { id } = idParam.parse(req.params);
  const [o] = await db.select().from(accidentStageOfficers).where(and(eq(accidentStageOfficers.id, id), eq(accidentStageOfficers.organizationId, access.orgId)));
  if (!o) throw notFound(tr("التعيين غير موجود"));
  assertCanDesignate(access, o.projectId);
  await db.transaction(async (tx) => {
    await tx.delete(accidentStageOfficers).where(eq(accidentStageOfficers.id, id));
    await audit(tx, req, { action: "ACCIDENT_CASE_OFFICERS", entity: "accident_officer", entityId: id, projectId: o.projectId, metadata: { op: "removed", stage: o.stage, userId: o.userId } });
  });
  res.json({ data: { id } });
});

// ───────────────────────────── create draft ─────────────────────────────
const CreateBody = z
  .object({
    vehicleId: uuid,
    driverId: uuid.nullable().optional(),
    occurredAt: z.iso.datetime({ offset: true }),
    location: optionalText(300),
    ...Geo,
    description: trimmed(3, 4000),
    severity: z.enum(accidentSeverity.enumValues),
    responsibility: z.enum(accidentResponsibility.enumValues).default("UNKNOWN"),
    policeReportNumber: optionalText(100),
  })
  .strict();

accidentCasesRouter.post("/accident-cases", requirePermission("accidents.create"), async (req, res) => {
  const { access } = ctx(req);
  const b = CreateBody.parse(req.body);
  const occurredAt = new Date(b.occurredAt);
  assertNotFuture(occurredAt, tr("وقت الحادث"));
  if ((b.latitude == null) !== (b.longitude == null)) throw badRequest(tr("يجب إرسال خط العرض وخط الطول معًا"));
  const created = await db.transaction(async (tx) => {
    // A draft changes nothing on the vehicle: the status is only touched at submission.
    const v = await vehicleForCreate(tx, access, b.vehicleId, "accidents.create");
    const driverId = await resolveDriver(tx, access, "accidents.create", v, b.driverId);
    const at = now();
    const byDriver = access.scopeOf("accidents.create") === "ASSIGNED";
    const [acc] = await tx
      .insert(accidents)
      .values({
        organizationId: access.orgId,
        vehicleId: v.id,
        projectId: v.projectId,
        driverId,
        occurredAt,
        location: b.location ?? null,
        latitude: b.latitude != null ? b.latitude.toFixed(6) : null,
        longitude: b.longitude != null ? b.longitude.toFixed(6) : null,
        description: b.description,
        severity: b.severity,
        responsibility: b.responsibility,
        policeReportNumber: b.policeReportNumber ?? null,
        status: "OPEN",
        workflowStage: "DRAFT",
        stageEnteredAt: at,
        reportedBy: byDriver ? access.userId : null,
        createdBy: access.userId,
      })
      .returning();
    await tx.insert(accidentTransitions).values({ organizationId: access.orgId, accidentId: acc!.id, fromStage: null, toStage: "DRAFT", actorId: access.userId, reason: null });
    await audit(tx, req, { action: "ACCIDENT_CASE_CREATED", entity: "accident", entityId: acc!.id, projectId: v.projectId, vehicleId: v.id, metadata: { label: accLabel(acc!.number), severity: acc!.severity, byDriver } });
    if (byDriver) {
      const recipients = (await accidentRecipients(tx, access.orgId, v.projectId)).filter((u) => u !== access.userId);
      await notifyUsers(tx, { orgId: access.orgId, userIds: recipients, type: "ACCIDENT_CASE_DRAFT", title: tr("بلاغ أولي عن حادث {0} بانتظار الاستكمال", accLabel(acc!.number)), link: `/accidents/${acc!.id}`, entityType: "accident", entityId: acc!.id, projectId: v.projectId });
    }
    return acc!;
  });
  res.status(201).json({ data: { ...created, label: accLabel(created.number) } });
});

// ───────────────────────────── detail ─────────────────────────────
/** The caller's standing on this case for the attachment rules. */
function uploadFlags(a: Access, acc: Case) {
  const assigneeOrAssigner = isAssigneeOrAssigner(a, acc);
  return {
    isCreator: acc.createdBy === a.userId && a.has("accidents.create"),
    handlesProject: handlesProject(a, acc),
    isTechnicalActor: a.has("accidents.review.technical") && assigneeOrAssigner,
    isClaimsActor: a.has("accidents.claims.manage") && assigneeOrAssigner,
  };
}

/** The next stages a case can move to from each stage: what the screen shows as "missing" before the step. */
const NEXT_STAGES: Partial<Record<WorkflowStage, WorkflowStage[]>> = {
  DRAFT: ["AWAITING_TECHNICAL"],
  AWAITING_TECHNICAL: ["AWAITING_ESTIMATES", "AWAITING_INSURANCE"],
  AWAITING_ESTIMATES: ["AWAITING_INSURANCE"],
  AWAITING_INSURANCE: ["CLAIM_IN_PROGRESS"],
  CLAIM_IN_PROGRESS: ["AWAITING_COMPENSATION_PROOF", "AWAITING_FINAL_CLOSURE"],
  AWAITING_COMPENSATION_PROOF: ["AWAITING_FINAL_CLOSURE"],
  AWAITING_FINAL_CLOSURE: ["CLOSED"],
};

/** Who may do what with this case right now (names only: the client decides what to show). */
async function actionsFor(a: Access, acc: Case): Promise<string[]> {
  const stage = stageOf(acc);
  const out: string[] = [];
  const handler = handlesProject(a, acc);
  const creator = acc.createdBy === a.userId && a.has("accidents.create");
  const assigneeOrAssigner = isAssigneeOrAssigner(a, acc);
  if (stage === "DRAFT") {
    if (creator || handler) out.push("edit", "attach");
    if (handler) out.push("submit");
  }
  if (stage === "AWAITING_TECHNICAL" && a.has("accidents.review.technical") && assigneeOrAssigner) out.push("technical", "attach", "to:AWAITING_ESTIMATES", "to:AWAITING_INSURANCE");
  if (stage === "AWAITING_ESTIMATES" && handler) out.push("attach", "estimate", "to:AWAITING_INSURANCE");
  if (stageFamily(stage) === "INSURANCE" && a.has("accidents.claims.manage") && assigneeOrAssigner) out.push("attach", "claim");
  if (stage === "AWAITING_FINAL_CLOSURE" && holdsScoped(a, "accidents.close", acc.projectId)) out.push("close");
  if (stage !== "DRAFT" && stage !== "CLOSED" && stage !== "RETURNED" && holdsScoped(a, "accidents.reopen", acc.projectId)) out.push("return");
  if (stage === "CLOSED" && holdsScoped(a, "accidents.reopen", acc.projectId)) out.push("reopen");
  if (stageFamily(stage) && holdsScoped(a, "accidents.assign", acc.projectId)) out.push("assign");
  return out;
}

/** "Returned for completion": why, when, by whom, and who has to act now. Null once the case has moved on. */
async function returnedInfo(acc: Case) {
  if (!acc.returnedAt || acc.returnedToStage !== acc.workflowStage) return null;
  const [by] = acc.returnedBy ? await db.select({ id: users.id, name: users.name }).from(users).where(eq(users.id, acc.returnedBy)) : [];
  return { stage: acc.workflowStage, reason: acc.returnedReason, returnedAt: acc.returnedAt, returnedBy: by ?? null, requiredAction: await requiredActionFor(db, acc) };
}

accidentCasesRouter.get("/accident-cases/:id", requirePermission("accidents.read"), async (req, res) => {
  const { access } = ctx(req);
  const { id } = idParam.parse(req.params);
  const [acc] = await db
    .select()
    .from(accidents)
    .where(and(eq(accidents.id, id), eq(accidents.organizationId, access.orgId), sql`${accidents.workflowStage} is not null`, caseVisibility(access)));
  if (!acc) throw noSuchCase();
  const [[extra], attachments, estimates, [claim], transitions, assignments, sla] = await Promise.all([
    db
      .select({ plateNumber: vehicles.plateNumber, vehicleStatus: vehicles.status, projectName: projects.name, driverName: driverNameSql(accidents.driverId), createdByName: users.name, assignedToName: sql<string | null>`(select name from users where id = ${accidents.assignedTo})` })
      .from(accidents)
      .innerJoin(vehicles, eq(vehicles.id, accidents.vehicleId))
      .leftJoin(projects, eq(projects.id, accidents.projectId))
      .innerJoin(users, eq(users.id, accidents.createdBy))
      .where(eq(accidents.id, id)),
    db
      .select({ id: accidentAttachments.id, category: accidentAttachments.category, stage: accidentAttachments.stage, uploadedBy: accidentAttachments.uploadedBy, supersededAt: accidentAttachments.supersededAt, fileName: files.originalName, mimeType: files.mimeType, sizeBytes: files.sizeBytes, createdAt: accidentAttachments.createdAt })
      .from(accidentAttachments)
      .innerJoin(files, eq(files.id, accidentAttachments.fileId))
      .where(eq(accidentAttachments.accidentId, id))
      .orderBy(accidentAttachments.createdAt),
    db.select().from(accidentEstimates).where(eq(accidentEstimates.accidentId, id)).orderBy(accidentEstimates.createdAt),
    db.select().from(accidentClaims).where(eq(accidentClaims.accidentId, id)),
    db
      .select({ id: accidentTransitions.id, fromStage: accidentTransitions.fromStage, toStage: accidentTransitions.toStage, reason: accidentTransitions.reason, createdAt: accidentTransitions.createdAt, actorName: users.name })
      .from(accidentTransitions)
      .leftJoin(users, eq(users.id, accidentTransitions.actorId))
      .where(eq(accidentTransitions.accidentId, id))
      .orderBy(accidentTransitions.createdAt),
    db
      .select({ id: accidentAssignments.id, stage: accidentAssignments.stage, mode: accidentAssignments.mode, reason: accidentAssignments.reason, createdAt: accidentAssignments.createdAt, assignedToName: sql<string | null>`(select name from users where id = ${accidentAssignments.assignedTo})`, assignedByName: sql<string | null>`(select name from users where id = ${accidentAssignments.assignedBy})` })
      .from(accidentAssignments)
      .where(eq(accidentAssignments.accidentId, id))
      .orderBy(accidentAssignments.createdAt),
    loadSla(db, access.orgId),
  ]);
  const input = await sensitiveInputFor(db, access, acc);
  // Hidden files are simply absent: not listed, not counted, not named anywhere in the response.
  const shown = visibleAttachments(attachments, input).map(({ uploadedBy: _u, ...rest }) => rest);
  const stage = stageOf(acc);
  const actions = await actionsFor(access, acc);
  // Only people who can act on the case are told what is still missing (the answer is about required categories, never about files).
  const requirements = actions.length ? await Promise.all((NEXT_STAGES[stage] ?? []).map(async (to) => ({ to, missing: missingForTransition(stage, to, await loadFacts(db, acc)) }))) : [];
  const flags = uploadFlags(access, acc);
  const uploadCategories = ATTACHMENT_CATEGORIES.filter((category) => canUploadAttachment({ category, stage, ...flags }));
  res.json({
    data: {
      ...acc,
      ...extra,
      label: accLabel(acc.number),
      attachments: shown,
      estimates,
      claim: claim ?? null,
      transitions,
      assignments,
      returnedForCompletion: await returnedInfo(acc),
      slaDueAt: acc.stageEnteredAt ? slaDueAt(stage, acc.stageEnteredAt, sla) : null,
      overdue: acc.stageEnteredAt ? isOverdue(stage, acc.stageEnteredAt, now(), sla) : false,
      actions,
      requirements,
      uploadCategories,
    },
  });
});

// ───────────────────────────── edit draft ─────────────────────────────
const PatchBody = z
  .object({
    location: optionalText(300),
    ...Geo,
    description: trimmed(3, 4000).optional(),
    severity: z.enum(accidentSeverity.enumValues).optional(),
    responsibility: z.enum(accidentResponsibility.enumValues).optional(),
    policeReportNumber: optionalText(100),
    driverId: uuid.nullable().optional(),
  })
  .strict();

accidentCasesRouter.patch("/accident-cases/:id", requirePermission("accidents.read"), async (req, res) => {
  const { access } = ctx(req);
  const { id } = idParam.parse(req.params);
  const b = PatchBody.parse(req.body);
  const updated = await db.transaction(async (tx) => {
    const acc = await lockCase(tx, access, id);
    if (stageOf(acc) !== "DRAFT") throw new HttpError(409, "INVALID_TRANSITION", tr("لا يمكن تعديل البلاغ بعد إرساله"));
    const creator = acc.createdBy === access.userId && access.has("accidents.create");
    if (!creator && !handlesProject(access, acc)) throw forbidden();
    const patch: Partial<Case> = {};
    for (const k of ["location", "description", "severity", "responsibility", "policeReportNumber"] as const) if (b[k] !== undefined) (patch as Record<string, unknown>)[k] = b[k];
    if (b.latitude !== undefined || b.longitude !== undefined) {
      if ((b.latitude == null) !== (b.longitude == null)) throw badRequest(tr("يجب إرسال خط العرض وخط الطول معًا"));
      patch.latitude = b.latitude != null ? b.latitude.toFixed(6) : null;
      patch.longitude = b.longitude != null ? b.longitude.toFixed(6) : null;
    }
    if (b.driverId !== undefined) {
      if (!handlesProject(access, acc)) throw forbidden();
      const [v] = await tx.select().from(vehicles).where(eq(vehicles.id, acc.vehicleId));
      patch.driverId = await resolveDriver(tx, access, "accidents.update", v!, b.driverId);
    }
    const changes = diff(acc as unknown as Record<string, unknown>, patch as Record<string, unknown>);
    if (Object.keys(changes).length === 0) throw badRequest(tr("لا يوجد تغيير"));
    const [u] = await tx.update(accidents).set({ ...patch, updatedAt: now() }).where(and(eq(accidents.id, id), eq(accidents.workflowStage, "DRAFT"))).returning();
    if (!u) throw new HttpError(409, "INVALID_TRANSITION", tr("تم تعديل الحادث من مستخدم آخر"));
    await audit(tx, req, { action: "ACCIDENT_CASE_UPDATED", entity: "accident", entityId: id, projectId: acc.projectId, vehicleId: acc.vehicleId, metadata: { label: accLabel(acc.number), changes } });
    return u;
  });
  res.json({ data: { ...updated, label: accLabel(updated.number) } });
});

// ───────────────────────────── submit / technical / transition ─────────────────────────────
accidentCasesRouter.post("/accident-cases/:id/submit", requirePermission("accidents.read"), async (req, res) => {
  const { access } = ctx(req);
  const { id } = idParam.parse(req.params);
  const out = await db.transaction(async (tx) => {
    const acc = await lockCase(tx, access, id);
    requireHeld(access, "accidents.update", handlesProject(access, acc));
    const r = evaluateTransition({ from: stageOf(acc), to: "AWAITING_TECHNICAL" });
    if (!r.ok || stageOf(acc) !== "DRAFT") throw new HttpError(409, "INVALID_TRANSITION", tr("الحادث ليس مسودة"));
    const missing = missingForTransition("DRAFT", "AWAITING_TECHNICAL", await loadFacts(tx, acc));
    if (missing.length) throw requirementsNotMet(missing);
    await moveStage(tx, req, access, acc, "AWAITING_TECHNICAL");
    const [fresh] = await tx.select().from(accidents).where(eq(accidents.id, id));
    return fresh!;
  });
  res.json({ data: { ...out, label: accLabel(out.number) } });
});

const TechnicalBody = z.object({ damageDescription: trimmed(3, 4000), technicalNotes: optionalText(4000), repairDecision: z.enum(["REPAIR", "NOT_REPAIRABLE", "NOT_NEEDED"]) }).strict();

accidentCasesRouter.put("/accident-cases/:id/technical", requirePermission("accidents.read"), async (req, res) => {
  const { access } = ctx(req);
  const { id } = idParam.parse(req.params);
  const b = TechnicalBody.parse(req.body);
  const out = await db.transaction(async (tx) => {
    const acc = await lockCase(tx, access, id);
    requireHeld(access, "accidents.review.technical", isAssigneeOrAssigner(access, acc));
    if (stageOf(acc) !== "AWAITING_TECHNICAL") throw new HttpError(409, "INVALID_TRANSITION", tr("الحادث ليس في مرحلة التقييم الفني"));
    const [u] = await tx
      .update(accidents)
      .set({ damageDescription: b.damageDescription, technicalNotes: b.technicalNotes ?? null, repairDecision: b.repairDecision, repairable: b.repairDecision === "REPAIR", updatedAt: now() })
      .where(and(eq(accidents.id, id), eq(accidents.workflowStage, "AWAITING_TECHNICAL")))
      .returning();
    if (!u) throw new HttpError(409, "INVALID_TRANSITION", tr("تم تعديل الحادث من مستخدم آخر"));
    await audit(tx, req, { action: "ACCIDENT_CASE_UPDATED", entity: "accident", entityId: id, projectId: acc.projectId, vehicleId: acc.vehicleId, metadata: { label: accLabel(acc.number), technical: true, repairDecision: b.repairDecision } });
    return u;
  });
  res.json({ data: { ...out, label: accLabel(out.number) } });
});

const TransitionBody = z.object({ to: stageEnum, reason: optionalText(1000), resolution: optionalText(2000) }).strict();

/** Moves that have their own endpoint (claim register/status) or are not manual at all are refused here. */
const GENERIC_FORWARD = new Set(["AWAITING_TECHNICAL>AWAITING_ESTIMATES", "AWAITING_TECHNICAL>AWAITING_INSURANCE", "AWAITING_ESTIMATES>AWAITING_INSURANCE", "AWAITING_FINAL_CLOSURE>CLOSED"]);

accidentCasesRouter.post("/accident-cases/:id/transition", requirePermission("accidents.read"), async (req, res) => {
  const { access } = ctx(req);
  const { id } = idParam.parse(req.params);
  const b = TransitionBody.parse(req.body);
  const out = await db.transaction(async (tx) => {
    const acc = await lockCase(tx, access, id);
    const from = stageOf(acc);
    const check = evaluateTransition({ from, to: b.to, returnedTo: acc.returnedToStage as WorkflowStage | null, reason: b.reason });
    // Who: the stage owner moves forward; accidents.reopen returns and reopens.
    if (check.ok && check.kind === "FORWARD") {
      if (!GENERIC_FORWARD.has(`${from}>${b.to}`)) throw new HttpError(409, "INVALID_TRANSITION", tr("هذا الانتقال يتم عبر مساره المخصص"));
      if (from === "AWAITING_TECHNICAL") requireHeld(access, "accidents.review.technical", isAssigneeOrAssigner(access, acc));
      else if (from === "AWAITING_ESTIMATES") requireHeld(access, "accidents.update", handlesProject(access, acc));
      else requireHeld(access, "accidents.close", holdsScoped(access, "accidents.close", acc.projectId));
    } else if (check.ok && (check.kind === "RETURN" || check.kind === "REOPEN")) {
      requireHeld(access, "accidents.reopen", holdsScoped(access, "accidents.reopen", acc.projectId));
    } else if (check.ok) {
      throw new HttpError(409, "INVALID_TRANSITION", tr("انتقال غير مسموح بين مراحل الحادث"));
    }
    if (!check.ok) {
      // Not allowed for anyone: say why, but only to a caller who could have acted on the case at all.
      if (!(access.has("accidents.reopen") || access.has("accidents.close") || access.has("accidents.update") || access.has("accidents.review.technical") || access.has("accidents.claims.manage") || access.has("accidents.assign"))) throw forbidden();
      throw new HttpError(409, "INVALID_TRANSITION", check.error);
    }
    const resolution = b.resolution ?? acc.resolution;
    const facts = { ...(await loadFacts(tx, acc)), resolution };
    const missing = missingForTransition(from, b.to, facts);
    if (missing.length) throw requirementsNotMet(missing);
    await moveStage(tx, req, access, acc, b.to, { reason: b.reason, resolution: b.resolution ?? null });
    const [fresh] = await tx.select().from(accidents).where(eq(accidents.id, id));
    return fresh!;
  });
  res.json({ data: { ...out, label: accLabel(out.number) } });
});

// ───────────────────────────── assignment ─────────────────────────────
const AssignBody = z.object({ userId: uuid, reason: optionalText(500) }).strict();

accidentCasesRouter.post("/accident-cases/:id/assign", requirePermission("accidents.read"), async (req, res) => {
  const { access } = ctx(req);
  const { id } = idParam.parse(req.params);
  const b = AssignBody.parse(req.body);
  const out = await db.transaction(async (tx) => {
    const acc = await lockCase(tx, access, id);
    requireHeld(access, "accidents.assign", holdsScoped(access, "accidents.assign", acc.projectId));
    const stage = stageOf(acc);
    const family = stageFamily(stage);
    if (!family) throw new HttpError(409, "INVALID_TRANSITION", tr("هذه المرحلة لا تُسند إلى مسؤول"));
    if (acc.assignedTo === b.userId) throw new HttpError(409, "ALREADY_ASSIGNED", tr("الحادث مُسند لهذا المستخدم بالفعل"));
    const [target] = await tx.select({ id: users.id, status: users.status }).from(users).where(and(eq(users.id, b.userId), eq(users.organizationId, access.orgId)));
    if (!target || target.status !== "ACTIVE") throw notFound(tr("المستخدم غير موجود"));
    if (!(await loadAccess(tx, target.id, access.orgId)).has(FAMILY_PERMISSION[family])) throw badRequest(tr("المستخدم لا يملك الصلاحية اللازمة لهذه المرحلة"));
    const at = now();
    const [u] = await tx.update(accidents).set({ assignedTo: target.id, assignedAt: at, assignmentMode: "MANUAL", updatedAt: at }).where(and(eq(accidents.id, id), eq(accidents.workflowStage, stage))).returning();
    if (!u) throw new HttpError(409, "INVALID_TRANSITION", tr("تم تعديل الحادث من مستخدم آخر"));
    await tx.insert(accidentAssignments).values({ organizationId: access.orgId, accidentId: id, stage, assignedTo: target.id, assignedBy: access.userId, mode: "MANUAL", reason: b.reason ?? null });
    await audit(tx, req, { action: "ACCIDENT_CASE_ASSIGNED", entity: "accident", entityId: id, projectId: acc.projectId, vehicleId: acc.vehicleId, metadata: { label: accLabel(acc.number), stage, mode: "MANUAL", assignedTo: target.id, from: acc.assignedTo } });
    await notifyUsers(tx, { orgId: access.orgId, userIds: [target.id], type: "ACCIDENT_CASE_ASSIGNED", title: tr("أُسند إليك الحادث {0}", accLabel(acc.number)), link: `/accidents/${id}`, entityType: "accident", entityId: id });
    return u;
  });
  res.json({ data: { ...out, label: accLabel(out.number) } });
});

/** People the case can be assigned to in its current stage: holders of the stage permission (plus the designated officers). */
accidentCasesRouter.get("/accident-cases/:id/assignable", requirePermission("accidents.read"), async (req, res) => {
  const { access } = ctx(req);
  const { id } = idParam.parse(req.params);
  const acc = await db.transaction((tx) => lockCase(tx, access, id));
  requireHeld(access, "accidents.assign", holdsScoped(access, "accidents.assign", acc.projectId));
  const family = stageFamily(stageOf(acc));
  if (!family) return void res.json({ data: [] });
  const perm = FAMILY_PERMISSION[family];
  const holders = await permissionHolders(db, access.orgId, perm, acc.projectId, { includeAllScope: true, includeAssignedScope: true });
  const designated = await db
    .select({ userId: accidentStageOfficers.userId })
    .from(accidentStageOfficers)
    .where(and(eq(accidentStageOfficers.organizationId, access.orgId), eq(accidentStageOfficers.stage, family), or(isNull(accidentStageOfficers.projectId), acc.projectId ? eq(accidentStageOfficers.projectId, acc.projectId) : sql`false`)));
  const ids = [...new Set([...holders, ...designated.map((d) => d.userId)])].filter((u) => u !== acc.assignedTo);
  const people = ids.length ? await db.select({ id: users.id, name: users.name }).from(users).where(and(eq(users.organizationId, access.orgId), eq(users.status, "ACTIVE"), sql`${users.id} in (${sql.join(ids.map((x) => sql`${x}`), sql`, `)})`)).orderBy(users.name) : [];
  const designatedSet = new Set(designated.map((d) => d.userId));
  res.json({ data: people.map((p) => ({ ...p, designated: designatedSet.has(p.id) })).sort((a, b) => Number(b.designated) - Number(a.designated) || a.name.localeCompare(b.name)) });
});

// ───────────────────────────── attachments ─────────────────────────────
accidentCasesRouter.post("/accident-cases/:id/attachments", requirePermission("accidents.read"), uploadRateLimit, rawUpload, async (req, res) => {
  const { access } = ctx(req);
  const { id } = idParam.parse(req.params);
  const { category } = z.object({ category: z.enum(ATTACHMENT_CATEGORIES) }).parse(req.query);
  const row = await db.transaction(async (tx) => {
    const acc = await lockCase(tx, access, id);
    const allowed = canUploadAttachment({ category, stage: stageOf(acc), ...uploadFlags(access, acc) });
    if (!allowed) throw stageOf(acc) === "CLOSED" ? new HttpError(409, "INVALID_TRANSITION", tr("لا يمكن إرفاق ملفات لحادث مغلق")) : forbidden();
    const f = await storeUpload(tx, req, access.orgId, access.userId);
    const at = now();
    if (SINGLE_DOCUMENT_CATEGORIES.has(category)) {
      // The earlier file stays (history); it just stops counting.
      await tx.update(accidentAttachments).set({ supersededAt: at }).where(and(eq(accidentAttachments.accidentId, id), eq(accidentAttachments.category, category), isNull(accidentAttachments.supersededAt)));
    }
    const [att] = await tx.insert(accidentAttachments).values({ organizationId: access.orgId, accidentId: id, fileId: f.id, category, stage: stageOf(acc), uploadedBy: access.userId }).returning();
    // File names are never written to the audit trail: the timeline must not name files someone may not see.
    await audit(tx, req, { action: "FILE_UPLOADED", entity: "accident", entityId: id, projectId: acc.projectId, vehicleId: acc.vehicleId, metadata: { category, attachmentId: att!.id } });
    return { id: att!.id, category, fileName: f.originalName };
  });
  res.status(201).json({ data: row });
});

accidentCasesRouter.get("/accident-cases/:id/attachments/:attId/file", requirePermission("accidents.read"), async (req, res) => {
  const { access } = ctx(req);
  const { id, attId } = z.object({ id: uuid, attId: uuid }).parse(req.params);
  const [acc] = await db
    .select()
    .from(accidents)
    .where(and(eq(accidents.id, id), eq(accidents.organizationId, access.orgId), sql`${accidents.workflowStage} is not null`, caseVisibility(access)));
  const [att] = acc ? await db.select().from(accidentAttachments).where(and(eq(accidentAttachments.id, attId), eq(accidentAttachments.accidentId, id))) : [];
  // A missing case, a missing file and a file the caller may not see all answer the same way.
  if (!acc || !att || !canViewAttachment(att.category, await sensitiveInputFor(db, access, acc), att.uploadedBy)) throw notFound(tr("المرفق غير موجود"));
  await audit(db, req, { action: "FILE_DOWNLOADED", entity: "accident", entityId: id, projectId: acc.projectId, vehicleId: acc.vehicleId, metadata: { attachmentId: attId } });
  await sendStoredFile(db, res, att.fileId, access.orgId);
});

// ───────────────────────────── estimates ─────────────────────────────
const EstimateBody = z.object({ vendorName: trimmed(2, 200), amount: money, notes: optionalText(1000), attachmentId: uuid }).strict();

accidentCasesRouter.post("/accident-cases/:id/estimates", requirePermission("accidents.read"), async (req, res) => {
  const { access } = ctx(req);
  const { id } = idParam.parse(req.params);
  const b = EstimateBody.parse(req.body);
  const row = await db.transaction(async (tx) => {
    const acc = await lockCase(tx, access, id);
    requireHeld(access, "accidents.update", handlesProject(access, acc));
    if (stageOf(acc) !== "AWAITING_ESTIMATES") throw new HttpError(409, "INVALID_TRANSITION", tr("الحادث ليس في مرحلة التقديرات"));
    const [att] = await tx.select().from(accidentAttachments).where(and(eq(accidentAttachments.id, b.attachmentId), eq(accidentAttachments.accidentId, id), eq(accidentAttachments.category, "ESTIMATE"), isNull(accidentAttachments.supersededAt)));
    if (!att) throw badRequest(tr("يجب إرفاق تقرير التقدير أولًا"));
    const [e] = await tx.insert(accidentEstimates).values({ organizationId: access.orgId, accidentId: id, vendorName: b.vendorName, amount: b.amount, notes: b.notes ?? null, attachmentId: att.id, createdBy: access.userId }).returning();
    await audit(tx, req, { action: "ACCIDENT_CASE_ESTIMATE", entity: "accident", entityId: id, projectId: acc.projectId, vehicleId: acc.vehicleId, metadata: { label: accLabel(acc.number), op: "added", estimateId: e!.id, amount: b.amount } });
    return e!;
  });
  res.status(201).json({ data: row });
});

accidentCasesRouter.post("/accident-cases/:id/estimates/:eid/select", requirePermission("accidents.read"), async (req, res) => {
  const { access } = ctx(req);
  const { id, eid } = z.object({ id: uuid, eid: uuid }).parse(req.params);
  const row = await db.transaction(async (tx) => {
    const acc = await lockCase(tx, access, id);
    requireHeld(access, "accidents.update", handlesProject(access, acc));
    if (stageOf(acc) !== "AWAITING_ESTIMATES") throw new HttpError(409, "INVALID_TRANSITION", tr("الحادث ليس في مرحلة التقديرات"));
    const [e] = await tx.select().from(accidentEstimates).where(and(eq(accidentEstimates.id, eid), eq(accidentEstimates.accidentId, id)));
    if (!e) throw notFound(tr("التقدير غير موجود"));
    // One approved estimate: the previous choice is un-selected, never deleted.
    await tx.update(accidentEstimates).set({ selected: false }).where(and(eq(accidentEstimates.accidentId, id), eq(accidentEstimates.selected, true)));
    const [u] = await tx.update(accidentEstimates).set({ selected: true }).where(eq(accidentEstimates.id, eid)).returning();
    await tx.update(accidents).set({ repairCost: e.amount, updatedAt: now() }).where(eq(accidents.id, id));
    await audit(tx, req, { action: "ACCIDENT_CASE_ESTIMATE", entity: "accident", entityId: id, projectId: acc.projectId, vehicleId: acc.vehicleId, metadata: { label: accLabel(acc.number), op: "selected", estimateId: eid, amount: e.amount } });
    return u!;
  });
  res.json({ data: row });
});

// ───────────────────────────── claim ─────────────────────────────
const ClaimBody = z.object({ insurerName: trimmed(2, 200), claimNumber: trimmed(1, 100), filedAt: isoDate, claimedAmount: money.nullable().optional() }).strict();

/** The claims officer of the case (assigned, or an assigner acting for them) holding accidents.claims.manage. */
function requireClaimsActor(a: Access, acc: Case) {
  requireHeld(a, "accidents.claims.manage", isAssigneeOrAssigner(a, acc));
}

accidentCasesRouter.put("/accident-cases/:id/claim", requirePermission("accidents.read"), async (req, res) => {
  const { access } = ctx(req);
  const { id } = idParam.parse(req.params);
  const b = ClaimBody.parse(req.body);
  const out = await db.transaction(async (tx) => {
    const acc = await lockCase(tx, access, id);
    requireClaimsActor(access, acc);
    const stage = stageOf(acc);
    if (stage !== "AWAITING_INSURANCE" && stage !== "CLAIM_IN_PROGRESS") throw new HttpError(409, "INVALID_TRANSITION", tr("لا يمكن تسجيل المطالبة في هذه المرحلة"));
    const filedAt = new Date(`${b.filedAt}T00:00:00Z`);
    assertNotFuture(filedAt, tr("تاريخ المطالبة"));
    const values = { insurerName: b.insurerName, claimNumber: b.claimNumber, filedAt, claimedAmount: b.claimedAmount ?? null, updatedAt: now() };
    const [existing] = await tx.select().from(accidentClaims).where(eq(accidentClaims.accidentId, id));
    if (existing) await tx.update(accidentClaims).set(values).where(eq(accidentClaims.id, existing.id));
    else await tx.insert(accidentClaims).values({ organizationId: access.orgId, accidentId: id, status: "FILED", createdBy: access.userId, ...values });
    await tx.update(accidents).set({ insuranceClaimNumber: b.claimNumber, updatedAt: now() }).where(eq(accidents.id, id));
    await audit(tx, req, { action: "ACCIDENT_CASE_CLAIM", entity: "accident", entityId: id, projectId: acc.projectId, vehicleId: acc.vehicleId, metadata: { label: accLabel(acc.number), op: existing ? "updated" : "registered", claimNumber: b.claimNumber } });
    if (stage === "AWAITING_INSURANCE") {
      const missing = missingForTransition("AWAITING_INSURANCE", "CLAIM_IN_PROGRESS", await loadFacts(tx, acc));
      if (missing.length) throw requirementsNotMet(missing);
      await moveStage(tx, req, access, acc, "CLAIM_IN_PROGRESS");
    }
    const [claim] = await tx.select().from(accidentClaims).where(eq(accidentClaims.accidentId, id));
    return claim!;
  });
  res.json({ data: out });
});

const ClaimStatusBody = z
  .object({ status: z.enum(["PROCESSING", "APPROVED", "REJECTED", "COMPENSATION_RECEIVED"]), reason: optionalText(1000), approvedAmount: money.nullable().optional(), receivedAmount: money.nullable().optional() })
  .strict();

accidentCasesRouter.post("/accident-cases/:id/claim/status", requirePermission("accidents.read"), async (req, res) => {
  const { access } = ctx(req);
  const { id } = idParam.parse(req.params);
  const b = ClaimStatusBody.parse(req.body);
  const out = await db.transaction(async (tx) => {
    const acc = await lockCase(tx, access, id);
    requireClaimsActor(access, acc);
    const stage = stageOf(acc);
    const [claim] = await tx.select().from(accidentClaims).where(eq(accidentClaims.accidentId, id)).for("update");
    const inStage = b.status === "COMPENSATION_RECEIVED" ? stage === "AWAITING_COMPENSATION_PROOF" : stage === "CLAIM_IN_PROGRESS";
    if (!claim || !inStage) throw new HttpError(409, "INVALID_TRANSITION", tr("لا يمكن تغيير حالة المطالبة في هذه المرحلة"));
    if (!CLAIM_FLOW[claim.status as ClaimStatus].includes(b.status)) throw new HttpError(409, "INVALID_TRANSITION", tr("هذا التغيير غير مسموح في حالة المطالبة الحالية"));
    const facts = await loadFacts(tx, acc);
    const missing = missingForClaimStatus(b.status, { reason: b.reason, receivedAmount: b.receivedAmount, approvedAmount: b.approvedAmount }, facts);
    if (missing.length) throw requirementsNotMet(missing);
    const at = now();
    await tx
      .update(accidentClaims)
      .set({
        status: b.status,
        updatedAt: at,
        ...(b.status === "APPROVED" || b.status === "REJECTED" ? { decidedAt: at } : {}),
        ...(b.status === "APPROVED" && b.approvedAmount ? { approvedAmount: b.approvedAmount } : {}),
        ...(b.status === "REJECTED" ? { rejectionReason: b.reason ?? null } : {}),
        ...(b.status === "COMPENSATION_RECEIVED" ? { receivedAmount: b.receivedAmount ?? null, receivedAt: at } : {}),
      })
      .where(eq(accidentClaims.id, claim.id));
    await audit(tx, req, { action: "ACCIDENT_CASE_CLAIM", entity: "accident", entityId: id, projectId: acc.projectId, vehicleId: acc.vehicleId, metadata: { label: accLabel(acc.number), op: "status", from: claim.status, to: b.status } });
    const next = STAGE_AFTER_CLAIM[b.status];
    if (next) {
      const m = missingForTransition(stage, next, await loadFacts(tx, acc));
      if (m.length) throw requirementsNotMet(m);
      await moveStage(tx, req, access, acc, next, { reason: b.status === "REJECTED" ? b.reason : null });
    }
    const [fresh] = await tx.select().from(accidentClaims).where(eq(accidentClaims.id, claim.id));
    return fresh!;
  });
  res.json({ data: out });
});

