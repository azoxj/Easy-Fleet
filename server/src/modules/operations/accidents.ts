import { and, desc, eq, ilike, ne, or, sql, type SQL } from "drizzle-orm";
import { Router, type Request } from "express";
import { z } from "zod";
import { permissionHolders, type Access } from "../../auth/access.js";
import { db, type DbOrTx } from "../../db/client.js";
import { accidentAttachments, accidentResponsibility, accidents, accidentSeverity, accidentStatus, files, maintenanceRequests, projects, users, vehicles } from "../../db/schema/index.js";
import { ctx } from "../../http/context.js";
import { badRequest, HttpError, notFound } from "../../http/errors.js";
import { requirePermission } from "../../http/middleware.js";
import { idParam, isoDate, money, optionalText, paged, pagination, trimmed, uuid } from "../../http/validate.js";
import { config } from "../../config.js";
import { uploadRateLimit } from "../../lib/pg-rate-limit.js";
import { audit, diff } from "../../services/audit.js";
import { notifyUsers } from "../../services/notifications.js";
import { sendStoredFile, storeUpload } from "../../services/storage.js";
import { assertCanAct, assertNotFuture, driverNameSql, isVehicleRecordAssigned, rawUpload, recordTimeline, resolveDriver, vehicleForCreate, vehicleRecordScope } from "./common.js";

export const accidentsRouter = Router();

type AccidentStatus = (typeof accidentStatus.enumValues)[number];
type Accident = typeof accidents.$inferSelect;

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

async function loadAccident(a: Access, id: string, perm: "accidents.read" | "accidents.update" = "accidents.read") {
  const [row] = await db.select().from(accidents).where(and(eq(accidents.id, id), accidentScope(a, perm))).limit(1);
  if (!row) throw notFound("الحادث غير موجود");
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
};

const ListQuery = pagination.extend({
  q: z.string().trim().max(100).optional(),
  status: z.enum(accidentStatus.enumValues).optional(),
  severity: z.enum(accidentSeverity.enumValues).optional(),
  projectId: uuid.optional(),
  vehicleId: uuid.optional(),
  driverId: uuid.optional(),
  open: z.enum(["true", "false"]).optional(),
  from: isoDate.optional(),
  to: isoDate.optional(),
});

accidentsRouter.get("/accidents", requirePermission("accidents.read"), async (req, res) => {
  const { access } = ctx(req);
  const q = ListQuery.parse(req.query);
  const tz = config.APP_TIMEZONE;
  const where: SQL[] = [accidentScope(access)];
  if (q.status) where.push(eq(accidents.status, q.status));
  if (q.severity) where.push(eq(accidents.severity, q.severity));
  if (q.projectId) where.push(eq(accidents.projectId, q.projectId));
  if (q.vehicleId) where.push(eq(accidents.vehicleId, q.vehicleId));
  if (q.driverId) where.push(eq(accidents.driverId, q.driverId));
  if (q.open === "true") where.push(ne(accidents.status, "CLOSED"));
  if (q.from) where.push(sql`(${accidents.occurredAt} at time zone ${tz})::date >= ${q.from}::date`);
  if (q.to) where.push(sql`(${accidents.occurredAt} at time zone ${tz})::date <= ${q.to}::date`);
  if (q.q) {
    const m = /^acc-?(\d+)$/i.exec(q.q);
    const like = `%${q.q.replace(/[%_\\]/g, "\\$&")}%`;
    where.push(m ? eq(accidents.number, Number(m[1])) : or(ilike(vehicles.plateNumber, like), ilike(accidents.location, like), ilike(accidents.description, like), ilike(accidents.policeReportNumber, like))!);
  }
  const cond = and(...where);
  const [rows, [count]] = await Promise.all([
    db
      .select(listColumns)
      .from(accidents)
      .innerJoin(vehicles, eq(vehicles.id, accidents.vehicleId))
      .leftJoin(projects, eq(projects.id, accidents.projectId))
      .where(cond)
      .orderBy(desc(accidents.occurredAt))
      .limit(q.pageSize)
      .offset((q.page - 1) * q.pageSize),
    db.select({ n: sql<number>`count(*)::int` }).from(accidents).innerJoin(vehicles, eq(vehicles.id, accidents.vehicleId)).where(cond),
  ]);
  res.json(paged(rows.map((r) => ({ ...r, label: accLabel(r.number) })), count?.n ?? 0, q.page, q.pageSize));
});

const isAssigned = (a: Access, id: string) => isVehicleRecordAssigned(a, accidents, id, "ACCIDENT");

function availableActions(a: Access, acc: Accident, assigned: boolean): string[] {
  const out: string[] = [];
  const s = a.scopeOf("accidents.update");
  const can = s === "ALL" || (s === "PROJECT" && a.isMemberOf(acc.projectId)) || (s === "ASSIGNED" && assigned);
  if (!can) return out;
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
      .select({ id: accidentAttachments.id, category: accidentAttachments.category, fileName: files.originalName, mimeType: files.mimeType, sizeBytes: files.sizeBytes, createdAt: accidentAttachments.createdAt })
      .from(accidentAttachments)
      .innerJoin(files, eq(files.id, accidentAttachments.fileId))
      .where(eq(accidentAttachments.accidentId, id))
      .orderBy(accidentAttachments.createdAt),
    recordTimeline(access.orgId, "accident", id),
    isAssigned(access, id),
  ]);
  res.json({ data: { ...acc, ...extra, label: accLabel(acc.number), attachments, timeline, actions: availableActions(access, acc, assigned) } });
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
const FLAGGABLE = new Set(["AVAILABLE", "ASSIGNED", "OUT_OF_SERVICE"]);

async function accidentRecipients(tx: DbOrTx, orgId: string, projectId: string | null) {
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
  assertNotFuture(occurredAt, "وقت الحادث");
  if ((b.latitude == null) !== (b.longitude == null)) throw badRequest("يجب إرسال خط العرض وخط الطول معًا");
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
  if (acc.status === "CLOSED") throw new HttpError(409, "INVALID_TRANSITION", "لا يمكن تعديل حادث مغلق");
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
      if (!mr || mr.vehicleId !== acc.vehicleId) throw badRequest("طلب الصيانة لا يخص مركبة الحادث");
    }
    patch.maintenanceRequestId = b.maintenanceRequestId;
  }
  const changes = diff(acc as unknown as Record<string, unknown>, patch as Record<string, unknown>);
  if (Object.keys(changes).length === 0) throw badRequest("لا يوجد تغيير");
  const updated = await db.transaction(async (tx) => {
    const [u] = await tx.update(accidents).set({ ...patch, updatedAt: new Date() }).where(and(eq(accidents.id, id), ne(accidents.status, "CLOSED"))).returning();
    if (!u) throw new HttpError(409, "INVALID_TRANSITION", "تم تعديل الحادث من مستخدم آخر");
    await audit(tx, req, { action: "ACCIDENT_UPDATED", entity: "accident", entityId: id, projectId: acc.projectId, vehicleId: acc.vehicleId, metadata: { label: accLabel(acc.number), changes } });
    return u;
  });
  res.json({ data: updated });
});

const StatusBody = z.object({ to: z.enum(accidentStatus.enumValues), resolution: optionalText(2000) }).strict();

/** Restores a vehicle flagged ACCIDENT once no other open accident remains. */
async function restoreVehicle(tx: DbOrTx, req: Request, acc: Accident) {
  const [v] = await tx.select().from(vehicles).where(eq(vehicles.id, acc.vehicleId));
  if (!v || v.status !== "ACCIDENT") return;
  const [other] = await tx.select({ id: accidents.id }).from(accidents).where(and(eq(accidents.vehicleId, v.id), ne(accidents.id, acc.id), ne(accidents.status, "CLOSED"))).limit(1);
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
  const b = StatusBody.parse(req.body);
  if (!ACCIDENT_TRANSITIONS[acc.status].includes(b.to)) throw new HttpError(409, "INVALID_TRANSITION", "هذا الانتقال غير مسموح في حالة الحادث الحالية");
  if (b.to === "CLOSED" && !b.resolution && !acc.resolution) throw badRequest("يجب كتابة نتيجة/قرار الإغلاق");
  const updated = await db.transaction(async (tx) => {
    const [u] = await tx
      .update(accidents)
      .set({
        status: b.to,
        ...(b.resolution ? { resolution: b.resolution } : {}),
        closedAt: b.to === "CLOSED" ? new Date() : null,
        updatedAt: new Date(),
      })
      .where(and(eq(accidents.id, id), eq(accidents.status, acc.status)))
      .returning();
    if (!u) throw new HttpError(409, "INVALID_TRANSITION", "تم تعديل الحادث من مستخدم آخر، أعد تحميل الصفحة");
    await audit(tx, req, { action: "ACCIDENT_STATUS_CHANGED", entity: "accident", entityId: id, projectId: acc.projectId, vehicleId: acc.vehicleId, metadata: { label: accLabel(acc.number), fromStatus: acc.status, toStatus: b.to, resolution: b.resolution ?? undefined } });
    if (b.to === "CLOSED") await restoreVehicle(tx, req, acc);
    if (acc.status === "CLOSED" && b.to === "UNDER_REVIEW") {
      const [v] = await tx.select().from(vehicles).where(eq(vehicles.id, acc.vehicleId));
      if (v && FLAGGABLE.has(v.status)) {
        await tx.update(accidents).set({ vehicleStatusBefore: v.status }).where(eq(accidents.id, id));
        await tx.update(vehicles).set({ status: "ACCIDENT", updatedAt: new Date() }).where(eq(vehicles.id, v.id));
        await audit(tx, req, { action: "VEHICLE_UPDATED", entity: "vehicle", entityId: v.id, projectId: v.projectId, vehicleId: v.id, metadata: { changes: { status: { from: v.status, to: "ACCIDENT" } }, source: accLabel(acc.number) } });
      }
    }
    const recipients = new Set(await accidentRecipients(tx, access.orgId, acc.projectId));
    recipients.add(acc.createdBy);
    recipients.delete(access.userId);
    await notifyUsers(tx, { orgId: access.orgId, userIds: [...recipients], type: "ACCIDENT_STATUS_CHANGED", title: `تغيرت حالة الحادث ${accLabel(acc.number)}`, link: `/accidents/${id}`, entityType: "accident", entityId: id, projectId: acc.projectId });
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
  if (acc.status === "CLOSED") throw new HttpError(409, "INVALID_TRANSITION", "لا يمكن إرفاق ملفات لحادث مغلق");
  const row = await db.transaction(async (tx) => {
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
  if (!att) throw notFound("المرفق غير موجود");
  const acc = await loadAccident(access, att.accidentId);
  await audit(db, req, { action: "FILE_DOWNLOADED", entity: "accident", entityId: acc.id, projectId: acc.projectId, vehicleId: acc.vehicleId, metadata: { attachmentId: id } });
  await sendStoredFile(db, res, att.fileId);
});
