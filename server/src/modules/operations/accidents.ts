import { and, desc, eq, ilike, isNull, ne, or, sql, type SQL } from "drizzle-orm";
import { Router, type Request } from "express";
import { z } from "zod";
import { permissionHolders, type Access } from "../../auth/access.js";
import { db, type DbOrTx } from "../../db/client.js";
import { accidentAttachments, accidentResponsibility, accidents, accidentSeverity, accidentStatus, files, maintenanceRequests, projects, users, vehicles } from "../../db/schema/index.js";
import { ctx } from "../../http/context.js";
import { badRequest, forbidden, HttpError, notFound } from "../../http/errors.js";
import { requirePermission } from "../../http/middleware.js";
import { idParam, isoDate, money, optionalText, paged, pagination, sortOrder, trimmed, uuid } from "../../http/validate.js";
import { config } from "../../config.js";
import { uploadRateLimit } from "../../lib/pg-rate-limit.js";
import { audit, diff } from "../../services/audit.js";
import { notifyUsers } from "../../services/notifications.js";
import { sendStoredFile, storeUpload } from "../../services/storage.js";
import { assertCanAct, assertNotFuture, driverNameSql, isVehicleRecordAssigned, rawUpload, recordTimeline, resolveDriver, vehicleForCreate, vehicleRecordScope } from "./common.js";
import { tr } from "../../i18n/index.js";
import { sensitiveInputFor, visibleAttachments } from "../accidents/attachment-access.js";
import { canViewAttachment } from "../accidents/attachments-policy.js";
import { notDraft } from "../accidents/filters.js";
import { returnedMarker } from "../accidents/filters.js";
import { loadSla } from "../accidents/sla.js";
import { caseVisibility, draftVisibility } from "../accidents/visibility.js";
import { isOverdue, type WorkflowStage } from "../accidents/workflow.js";
import { now } from "../../lib/clock.js";
import { legacySensitiveEnforcementEnabled } from "../../lib/feature-flags.js";

export const accidentsRouter = Router();

type AccidentStatus = (typeof accidentStatus.enumValues)[number];
type Accident = typeof accidents.$inferSelect;

/** Cases in the new workflow (workflow_stage set) move only through the workflow; the legacy routes cannot bypass it. */
export function assertLegacyCase(acc: { workflowStage: string | null }) {
  if (acc.workflowStage !== null) throw new HttpError(409, "WORKFLOW_CASE", tr("هذا الحادث يُدار عبر مراحل سير العمل ولا يمكن تعديله بهذا المسار"));
}

/** A legacy UPDATE matched no row: say whether the case moved into the workflow meanwhile (409 WORKFLOW_CASE) or changed under the user. */
async function legacyUpdateConflict(tx: DbOrTx, id: string, message: string): Promise<never> {
  const [row] = await tx.select({ stage: accidents.workflowStage }).from(accidents).where(eq(accidents.id, id));
  if (row && row.stage !== null) assertLegacyCase({ workflowStage: row.stage });
  throw new HttpError(409, "INVALID_TRANSITION", message);
}

/** Server-side state machine. CLOSED is terminal (a reopen goes back to UNDER_REVIEW). */
export const ACCIDENT_TRANSITIONS: Record<AccidentStatus, AccidentStatus[]> = {
  OPEN: ["UNDER_REVIEW", "CLOSED"],
  UNDER_REVIEW: ["INSURANCE", "REPAIR", "CLOSED"],
  INSURANCE: ["REPAIR", "CLOSED"],
  REPAIR: ["INSURANCE", "CLOSED"],
  CLOSED: ["UNDER_REVIEW"],
};

export const accLabel = (n: number) => `ACC-${n}`;

export function accidentScope(a: Access, perm: "accidents.read" | "accidents.update" = "accidents.read"): SQL {
  return vehicleRecordScope(a, perm, accidents, "ACCIDENT");
}

export async function loadAccident(a: Access, id: string, perm: "accidents.read" | "accidents.update" = "accidents.read") {
  // Another user's draft does not exist for the caller.
  // Reading also reaches cases assigned to the caller; acting keeps the plain scope. Another user's draft never exists for the caller.
  const visible = perm === "accidents.read" ? caseVisibility(a) : and(accidentScope(a, perm), draftVisibility(a))!;
  const [row] = await db.select().from(accidents).where(and(eq(accidents.id, id), visible)).limit(1);
  if (!row) throw notFound(tr("الحادث غير موجود"));
  return row;
}

const listColumns = {
  id: accidents.id,
  number: accidents.number,
  vehicleId: accidents.vehicleId,
  plateNumber: vehicles.plateNumber,
  projectId: accidents.projectId,
  projectName: projects.name,
  driverId: accidents.driverId,
  driverName: driverNameSql(accidents.driverId),
  occurredAt: accidents.occurredAt,
  location: accidents.location,
  severity: accidents.severity,
  responsibility: accidents.responsibility,
  status: accidents.status,
  repairCost: accidents.repairCost,
  insuranceClaimNumber: accidents.insuranceClaimNumber,
  createdAt: accidents.createdAt,
  // Workflow information (null / false for legacy accidents).
  workflowStage: accidents.workflowStage,
  stageEnteredAt: accidents.stageEnteredAt,
  assignedToName: sql<string | null>`(select name from users where id = ${accidents.assignedTo})`,
  returnedForCompletion: sql<boolean>`${returnedMarker}`,
  preliminary: sql<boolean>`${accidents.reportedBy} is not null`,
};

const ACCIDENT_SORT = { number: accidents.number, occurredAt: accidents.occurredAt, severity: accidents.severity, status: accidents.status, driverName: driverNameSql(accidents.driverId), projectName: projects.name, repairCost: accidents.repairCost, plateNumber: vehicles.plateNumber };

const ListQuery = pagination.extend({
  q: z.string().trim().max(100).optional(),
  status: z.enum(accidentStatus.enumValues).optional(),
  severity: z.enum(accidentSeverity.enumValues).optional(),
  projectId: uuid.optional(),
  vehicleId: uuid.optional(),
  driverId: uuid.optional(),
  open: z.enum(["true", "false"]).optional(),
  /** Tab of the accidents screen: my reports, my assigned tasks, the assignment queue, returned, drafts, insurance claims. */
  view: z.enum(["all", "reported", "assigned", "queue", "returned", "drafts", "claims"]).optional(),
  from: isoDate.optional(),
  to: isoDate.optional(),
});

accidentsRouter.get("/accidents", requirePermission("accidents.read"), async (req, res) => {
  const { access } = ctx(req);
  const q = ListQuery.parse(req.query);
  const tz = config.APP_TIMEZONE;
  const where: SQL[] = [caseVisibility(access)];
  if (q.status) where.push(eq(accidents.status, q.status));
  if (q.severity) where.push(eq(accidents.severity, q.severity));
  if (q.projectId) where.push(eq(accidents.projectId, q.projectId));
  if (q.vehicleId) where.push(eq(accidents.vehicleId, q.vehicleId));
  if (q.driverId) where.push(eq(accidents.driverId, q.driverId));
  if (q.open === "true") where.push(ne(accidents.status, "CLOSED"), notDraft);
  switch (q.view) {
    case "reported":
      where.push(sql`(${accidents.createdBy} = ${access.userId} or ${accidents.reportedBy} = ${access.userId})`);
      break;
    case "assigned":
      where.push(sql`${accidents.assignedTo} = ${access.userId} and ${accidents.status} <> 'CLOSED'`);
      break;
    case "queue":
      // The queue belongs to the people who assign.
      if (!access.has("accidents.assign")) throw forbidden();
      where.push(sql`${accidents.workflowStage} is not null and ${accidents.assignedTo} is null and ${accidents.assignmentMode} = 'QUEUE' and ${accidents.status} <> 'CLOSED'`);
      break;
    case "returned":
      where.push(returnedMarker);
      break;
    case "drafts":
      where.push(sql`${accidents.workflowStage} = 'DRAFT'`);
      break;
    case "claims":
      where.push(sql`${accidents.status} = 'INSURANCE'`);
      break;
    default:
      break;
  }
  if (q.from) where.push(sql`(${accidents.occurredAt} at time zone ${tz})::date >= ${q.from}::date`);
  if (q.to) where.push(sql`(${accidents.occurredAt} at time zone ${tz})::date <= ${q.to}::date`);
  if (q.q) {
    const m = /^acc-?(\d+)$/i.exec(q.q);
    const like = `%${q.q.replace(/[%_\\]/g, "\\$&")}%`;
    where.push(m ? eq(accidents.number, Number(m[1])) : or(ilike(vehicles.plateNumber, like), ilike(accidents.location, like), ilike(accidents.description, like), ilike(accidents.policeReportNumber, like))!);
  }
  const cond = and(...where);
  const [rows, [count], sla] = await Promise.all([
    db
      .select(listColumns)
      .from(accidents)
      .innerJoin(vehicles, eq(vehicles.id, accidents.vehicleId))
      .leftJoin(projects, eq(projects.id, accidents.projectId))
      .where(cond)
      .orderBy(...sortOrder(q, ACCIDENT_SORT, desc(accidents.occurredAt)))
      .limit(q.pageSize)
      .offset((q.page - 1) * q.pageSize),
    db.select({ n: sql<number>`count(*)::int` }).from(accidents).innerJoin(vehicles, eq(vehicles.id, accidents.vehicleId)).where(cond),
    loadSla(db, access.orgId),
  ]);
  const at = now();
  res.json(paged(rows.map((r) => ({ ...r, label: accLabel(r.number), overdue: r.workflowStage && r.stageEnteredAt ? isOverdue(r.workflowStage as WorkflowStage, r.stageEnteredAt, at, sla) : false })), count?.n ?? 0, q.page, q.pageSize));
});

/**
 * Timeline rows must not reveal files the caller may not see: file events of a hidden attachment are dropped
 * (an event would give away its category and id), and file names are removed from the remaining ones.
 */
function filterTimeline<T extends { action: string; metadata: unknown }>(rows: T[], visibleIds: Set<string>, input: Parameters<typeof canViewAttachment>[1]): T[] {
  return rows.flatMap((row) => {
    if ((row.action !== "FILE_UPLOADED" && row.action !== "FILE_DOWNLOADED") || !row.metadata || typeof row.metadata !== "object") return [row];
    const { fileName: _f, ...rest } = row.metadata as Record<string, unknown>;
    const attId = typeof rest.attachmentId === "string" ? rest.attachmentId : null;
    const category = typeof rest.category === "string" ? rest.category : null;
    if (attId && !visibleIds.has(attId)) return [];
    if (!attId && category && !canViewAttachment(category, input)) return [];
    return [{ ...row, metadata: rest }];
  });
}

const isAssigned = (a: Access, id: string) => isVehicleRecordAssigned(a, accidents, id, "ACCIDENT");

function availableActions(a: Access, acc: Accident, assigned: boolean): string[] {
  const out: string[] = [];
  const s = a.scopeOf("accidents.update");
  const can = s === "ALL" || (s === "PROJECT" && a.isMemberOf(acc.projectId)) || (s === "ASSIGNED" && assigned);
  if (!can || acc.workflowStage !== null) return out;
  if (acc.status !== "CLOSED") out.push("edit", "attach");
  for (const to of ACCIDENT_TRANSITIONS[acc.status]) out.push(`status:${to}`);
  return out;
}

accidentsRouter.get("/accidents/:id", requirePermission("accidents.read"), async (req, res) => {
  const { access } = ctx(req);
  const { id } = idParam.parse(req.params);
  const acc = await loadAccident(access, id);
  const [[extra], attachments, timeline, assigned] = await Promise.all([
    db
      .select({ plateNumber: vehicles.plateNumber, vehicleStatus: vehicles.status, projectName: projects.name, driverName: driverNameSql(accidents.driverId), createdByName: users.name, maintenanceNumber: maintenanceRequests.number, maintenanceStatus: maintenanceRequests.status })
      .from(accidents)
      .innerJoin(vehicles, eq(vehicles.id, accidents.vehicleId))
      .leftJoin(projects, eq(projects.id, accidents.projectId))
      .innerJoin(users, eq(users.id, accidents.createdBy))
      .leftJoin(maintenanceRequests, eq(maintenanceRequests.id, accidents.maintenanceRequestId))
      .where(eq(accidents.id, id)),
    db
      .select({ id: accidentAttachments.id, category: accidentAttachments.category, uploadedBy: accidentAttachments.uploadedBy, fileName: files.originalName, mimeType: files.mimeType, sizeBytes: files.sizeBytes, createdAt: accidentAttachments.createdAt })
      .from(accidentAttachments)
      .innerJoin(files, eq(files.id, accidentAttachments.fileId))
      .where(eq(accidentAttachments.accidentId, id))
      .orderBy(accidentAttachments.createdAt),
    recordTimeline(access.orgId, "accident", id),
    isAssigned(access, id),
  ]);
  // Sensitive files are filtered for workflow cases always, and for legacy cases only under their own switch.
  const enforce = acc.workflowStage !== null || legacySensitiveEnforcementEnabled();
  const input = enforce ? await sensitiveInputFor(db, access, acc) : null;
  const shown = input ? visibleAttachments(attachments, input) : attachments;
  res.json({ data: { ...acc, ...extra, label: accLabel(acc.number), attachments: shown.map(({ uploadedBy: _u, ...rest }) => rest), timeline: input ? filterTimeline(timeline, new Set(shown.map((x) => x.id)), input) : timeline, actions: availableActions(access, acc, assigned) } });
});

const Geo = {
  latitude: z.coerce.number().min(-90).max(90).nullable().optional(),
  longitude: z.coerce.number().min(-180).max(180).nullable().optional(),
};

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

/** Vehicles in these statuses are flagged ACCIDENT when an accident is reported. */
export const FLAGGABLE = new Set(["AVAILABLE", "ASSIGNED", "OUT_OF_SERVICE"]);

export async function accidentRecipients(tx: DbOrTx, orgId: string, projectId: string | null) {
  const ids = new Set(await permissionHolders(tx, orgId, "accidents.update", projectId, { includeAllScope: true }));
  if (projectId) {
    const [p] = await tx.select({ managerId: projects.managerId }).from(projects).where(eq(projects.id, projectId));
    if (p?.managerId) ids.add(p.managerId);
  }
  return [...ids];
}

accidentsRouter.post("/accidents", requirePermission("accidents.create"), async (req, res) => {
  const { access } = ctx(req);
  const b = CreateBody.parse(req.body);
  const occurredAt = new Date(b.occurredAt);
  assertNotFuture(occurredAt, tr("وقت الحادث"));
  if ((b.latitude == null) !== (b.longitude == null)) throw badRequest(tr("يجب إرسال خط العرض وخط الطول معًا"));
  const created = await db.transaction(async (tx) => {
    const v = await vehicleForCreate(tx, access, b.vehicleId, "accidents.create");
    const driverId = await resolveDriver(tx, access, "accidents.create", v, b.driverId);
    const flag = FLAGGABLE.has(v.status);
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
        vehicleStatusBefore: flag ? v.status : null,
        createdBy: access.userId,
      })
      .returning();
    await audit(tx, req, { action: "ACCIDENT_CREATED", entity: "accident", entityId: acc!.id, projectId: v.projectId, vehicleId: v.id, metadata: { label: accLabel(acc!.number), severity: acc!.severity }, newValue: { status: "OPEN", severity: acc!.severity } });
    if (flag) {
      await tx.update(vehicles).set({ status: "ACCIDENT", updatedAt: new Date() }).where(eq(vehicles.id, v.id));
      await audit(tx, req, { action: "VEHICLE_UPDATED", entity: "vehicle", entityId: v.id, projectId: v.projectId, vehicleId: v.id, metadata: { changes: { status: { from: v.status, to: "ACCIDENT" } }, source: accLabel(acc!.number) } });
    }
    const recipients = (await accidentRecipients(tx, access.orgId, v.projectId)).filter((u) => u !== access.userId);
    await notifyUsers(tx, { orgId: access.orgId, userIds: recipients, type: "ACCIDENT_REPORTED", title: `تم تسجيل حادث ${accLabel(acc!.number)} للمركبة ${v.plateNumber}`, link: `/accidents/${acc!.id}`, entityType: "accident", entityId: acc!.id, projectId: v.projectId });
    return acc!;
  });
  res.status(201).json({ data: { ...created, label: accLabel(created.number) } });
});

const PatchBody = z
  .object({
    location: optionalText(300),
    ...Geo,
    description: trimmed(3, 4000).optional(),
    severity: z.enum(accidentSeverity.enumValues).optional(),
    responsibility: z.enum(accidentResponsibility.enumValues).optional(),
    policeReportNumber: optionalText(100),
    insuranceClaimNumber: optionalText(100),
    repairCost: money.nullable().optional(),
    driverId: uuid.nullable().optional(),
    maintenanceRequestId: uuid.nullable().optional(),
  })
  .strict();

accidentsRouter.patch("/accidents/:id", requirePermission("accidents.update"), async (req, res) => {
  const { access } = ctx(req);
  const { id } = idParam.parse(req.params);
  const acc = await loadAccident(access, id, "accidents.update");
  assertCanAct(access, "accidents.update", acc, await isAssigned(access, id));
  assertLegacyCase(acc);
  if (acc.status === "CLOSED") throw new HttpError(409, "INVALID_TRANSITION", tr("لا يمكن تعديل حادث مغلق"));
  const b = PatchBody.parse(req.body);
  const patch: Partial<Accident> = {};
  for (const k of ["location", "description", "severity", "responsibility", "policeReportNumber", "insuranceClaimNumber"] as const) {
    if (b[k] !== undefined) (patch as Record<string, unknown>)[k] = b[k];
  }
  if (b.latitude !== undefined) patch.latitude = b.latitude == null ? null : b.latitude.toFixed(6);
  if (b.longitude !== undefined) patch.longitude = b.longitude == null ? null : b.longitude.toFixed(6);
  if (b.repairCost !== undefined) patch.repairCost = b.repairCost;
  if (b.driverId !== undefined) {
    const [v] = await db.select().from(vehicles).where(eq(vehicles.id, acc.vehicleId));
    patch.driverId = await resolveDriver(db, access, "accidents.update", v!, b.driverId);
  }
  if (b.maintenanceRequestId !== undefined) {
    if (b.maintenanceRequestId) {
      const [mr] = await db.select({ vehicleId: maintenanceRequests.vehicleId }).from(maintenanceRequests).where(and(eq(maintenanceRequests.id, b.maintenanceRequestId), eq(maintenanceRequests.organizationId, access.orgId)));
      if (!mr || mr.vehicleId !== acc.vehicleId) throw badRequest(tr("طلب الصيانة لا يخص مركبة الحادث"));
    }
    patch.maintenanceRequestId = b.maintenanceRequestId;
  }
  const changes = diff(acc as unknown as Record<string, unknown>, patch as Record<string, unknown>);
  if (Object.keys(changes).length === 0) throw badRequest(tr("لا يوجد تغيير"));
  const updated = await db.transaction(async (tx) => {
    const [u] = await tx.update(accidents).set({ ...patch, updatedAt: new Date() }).where(and(eq(accidents.id, id), ne(accidents.status, "CLOSED"), isNull(accidents.workflowStage))).returning();
    if (!u) return legacyUpdateConflict(tx, id, tr("تم تعديل الحادث من مستخدم آخر"));
    await audit(tx, req, { action: "ACCIDENT_UPDATED", entity: "accident", entityId: id, projectId: acc.projectId, vehicleId: acc.vehicleId, metadata: { label: accLabel(acc.number), changes } });
    return u;
  });
  res.json({ data: updated });
});

const StatusBody = z.object({ to: z.enum(accidentStatus.enumValues), resolution: optionalText(2000) }).strict();

/** Restores a vehicle flagged ACCIDENT once no other open accident remains. */
export async function restoreVehicle(tx: DbOrTx, req: Request, acc: Accident) {
  const [v] = await tx.select().from(vehicles).where(eq(vehicles.id, acc.vehicleId));
  if (!v || v.status !== "ACCIDENT") return;
  const [other] = await tx.select({ id: accidents.id }).from(accidents).where(and(eq(accidents.vehicleId, v.id), ne(accidents.id, acc.id), ne(accidents.status, "CLOSED"), notDraft)).limit(1);
  if (other) return;
  const to = acc.vehicleStatusBefore === "OUT_OF_SERVICE" ? "OUT_OF_SERVICE" : v.assignedDriverId ? "ASSIGNED" : "AVAILABLE";
  await tx.update(vehicles).set({ status: to, updatedAt: new Date() }).where(eq(vehicles.id, v.id));
  await audit(tx, req, { action: "VEHICLE_UPDATED", entity: "vehicle", entityId: v.id, projectId: v.projectId, vehicleId: v.id, metadata: { changes: { status: { from: "ACCIDENT", to } }, source: accLabel(acc.number) } });
}

accidentsRouter.post("/accidents/:id/status", requirePermission("accidents.update"), async (req, res) => {
  const { access } = ctx(req);
  const { id } = idParam.parse(req.params);
  const acc = await loadAccident(access, id, "accidents.update");
  assertCanAct(access, "accidents.update", acc, await isAssigned(access, id));
  assertLegacyCase(acc);
  const b = StatusBody.parse(req.body);
  if (!ACCIDENT_TRANSITIONS[acc.status].includes(b.to)) throw new HttpError(409, "INVALID_TRANSITION", tr("هذا الانتقال غير مسموح في حالة الحادث الحالية"));
  if (b.to === "CLOSED" && !b.resolution && !acc.resolution) throw badRequest(tr("يجب كتابة نتيجة/قرار الإغلاق"));
  const updated = await db.transaction(async (tx) => {
    const [u] = await tx
      .update(accidents)
      .set({
        status: b.to,
        ...(b.resolution ? { resolution: b.resolution } : {}),
        closedAt: b.to === "CLOSED" ? new Date() : null,
        updatedAt: new Date(),
      })
      .where(and(eq(accidents.id, id), eq(accidents.status, acc.status), isNull(accidents.workflowStage)))
      .returning();
    if (!u) return legacyUpdateConflict(tx, id, tr("تم تعديل الحادث من مستخدم آخر، أعد تحميل الصفحة"));
    await audit(tx, req, { action: "ACCIDENT_STATUS_CHANGED", entity: "accident", entityId: id, projectId: acc.projectId, vehicleId: acc.vehicleId, metadata: { label: accLabel(acc.number), fromStatus: acc.status, toStatus: b.to, resolution: b.resolution ?? undefined } });
    if (b.to === "CLOSED") await restoreVehicle(tx, req, acc);
    if (acc.status === "CLOSED" && b.to === "UNDER_REVIEW") {
      const [v] = await tx.select().from(vehicles).where(eq(vehicles.id, acc.vehicleId));
      if (v && FLAGGABLE.has(v.status)) {
        await tx.update(accidents).set({ vehicleStatusBefore: v.status }).where(and(eq(accidents.id, id), isNull(accidents.workflowStage)));
        await tx.update(vehicles).set({ status: "ACCIDENT", updatedAt: new Date() }).where(eq(vehicles.id, v.id));
        await audit(tx, req, { action: "VEHICLE_UPDATED", entity: "vehicle", entityId: v.id, projectId: v.projectId, vehicleId: v.id, metadata: { changes: { status: { from: v.status, to: "ACCIDENT" } }, source: accLabel(acc.number) } });
      }
    }
    const title = `تغيرت حالة الحادث ${accLabel(acc.number)}`;
    const recipients = (await accidentRecipients(tx, access.orgId, acc.projectId)).filter((u) => u !== access.userId && u !== acc.createdBy);
    await notifyUsers(tx, { orgId: access.orgId, userIds: recipients, type: "ACCIDENT_STATUS_CHANGED", title, link: `/accidents/${id}`, entityType: "accident", entityId: id, projectId: acc.projectId });
    // The reporter (often the driver) always sees their own report, so no project filter for them.
    if (acc.createdBy !== access.userId) await notifyUsers(tx, { orgId: access.orgId, userIds: [acc.createdBy], type: "ACCIDENT_STATUS_CHANGED", title, link: `/accidents/${id}`, entityType: "accident", entityId: id });
    return u;
  });
  res.json({ data: updated });
});

const ATTACH_CATEGORIES = ["PHOTO", "POLICE_REPORT", "INSURANCE", "REPAIR_INVOICE", "OTHER"] as const;

accidentsRouter.post("/accidents/:id/attachments", requirePermission("accidents.read"), uploadRateLimit, rawUpload, async (req, res) => {
  const { access } = ctx(req);
  const { id } = idParam.parse(req.params);
  const { category } = z.object({ category: z.enum(ATTACH_CATEGORIES).default("PHOTO") }).parse(req.query);
  const acc = await loadAccident(access, id);
  const assigned = await isAssigned(access, id);
  // The reporter/assignee (accidents.create) or an updater may attach evidence.
  if (!(access.has("accidents.update") && (access.scopeOf("accidents.update") === "ALL" || access.isMemberOf(acc.projectId))) && !(access.has("accidents.create") && assigned)) {
    assertCanAct(access, "accidents.update", acc, assigned);
  }
  assertLegacyCase(acc);
  if (acc.status === "CLOSED") throw new HttpError(409, "INVALID_TRANSITION", tr("لا يمكن إرفاق ملفات لحادث مغلق"));
  const row = await db.transaction(async (tx) => {
    // Lock the case and re-check inside the transaction: it may have entered the workflow after it was loaded.
    const [locked] = await tx.select({ stage: accidents.workflowStage }).from(accidents).where(eq(accidents.id, id)).for("share");
    if (!locked) throw notFound(tr("الحادث غير موجود"));
    assertLegacyCase({ workflowStage: locked.stage });
    const f = await storeUpload(tx, req, access.orgId, access.userId);
    const [att] = await tx.insert(accidentAttachments).values({ organizationId: access.orgId, accidentId: id, fileId: f.id, category, uploadedBy: access.userId }).returning();
    await audit(tx, req, { action: "FILE_UPLOADED", entity: "accident", entityId: id, projectId: acc.projectId, vehicleId: acc.vehicleId, metadata: { fileName: f.originalName, category } });
    return { id: att!.id, category, fileName: f.originalName };
  });
  res.status(201).json({ data: row });
});

accidentsRouter.get("/accident-attachments/:id/file", requirePermission("accidents.read"), async (req, res) => {
  const { access } = ctx(req);
  const { id } = idParam.parse(req.params);
  const [att] = await db.select().from(accidentAttachments).where(and(eq(accidentAttachments.id, id), eq(accidentAttachments.organizationId, access.orgId)));
  if (!att) throw notFound(tr("المرفق غير موجود"));
  const acc = await loadAccident(access, att.accidentId);
  // A file the caller may not see answers exactly like a file that does not exist.
  if ((acc.workflowStage !== null || legacySensitiveEnforcementEnabled()) && !visibleAttachments([att], await sensitiveInputFor(db, access, acc)).length) throw notFound(tr("المرفق غير موجود"));
  await audit(db, req, { action: "FILE_DOWNLOADED", entity: "accident", entityId: acc.id, projectId: acc.projectId, vehicleId: acc.vehicleId, metadata: { attachmentId: id } });
  await sendStoredFile(db, res, att.fileId, access.orgId);
});
