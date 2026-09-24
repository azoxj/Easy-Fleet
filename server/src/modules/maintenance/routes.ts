import { and, asc, desc, eq, ilike, inArray, or, sql, type SQL } from "drizzle-orm";
import { alias } from "drizzle-orm/pg-core";
import express, { Router } from "express";
import { z } from "zod";
import {
  assertCanUseProject,
  canOnMaintenance,
  getVehicleInScope,

  maintenanceScope,
  permissionHolders,
} from "../../auth/access.js";
import { config } from "../../config.js";
import { db } from "../../db/client.js";
import {
  files,
  maintenanceAttachmentCategory,
  maintenanceAttachments,
  maintenanceEvents,
  maintenanceLabor,
  maintenanceParts,
  maintenancePriority,
  maintenanceQuotes,
  maintenanceRequests,
  maintenanceStatus,
  projects,
  users,
  vehicles,
  vendors,
} from "../../db/schema/index.js";
import { ctx } from "../../http/context.js";
import { badRequest, forbidden, notFound } from "../../http/errors.js";
import { requirePermission } from "../../http/middleware.js";
import { idParam, isoDate, optionalText, paged, pagination, trimmed, uuid } from "../../http/validate.js";
import { audit, diff } from "../../services/audit.js";
import { MAX_UPLOAD_BYTES, sendStoredFile, storeUpload } from "../../services/storage.js";
import {
  changeStatus,
  exceptionRecipients,
  finishTechnicianAssignment,
  invalidTransition,
  loadRequest,
  mrLabel,
  notifyMaintenance,
  projectManagersOf,
  recordEvent,
  stateOf,
  syncTechnicianAssignment,
  vehicleIntoMaintenance,
  vehicleOutOfMaintenance,
  type MR,
} from "./service.js";
import { ACTIONS, ASSIGNABLE, availableActions, EDITABLE_FIELDS, OPEN_STATUSES, preconditionError, TERMINAL, type ActionKey, type MaintenanceStatus } from "./workflow.js";

export const maintenanceRouter = Router();

const technician = alias(users, "technician");
const requester = alias(users, "requester");

/** Sum of parts + labor for a request, computed in SQL (numeric, never float). */
const costExpr = sql<string>`(
  coalesce((select sum(p.total) from maintenance_parts p where p.maintenance_request_id = "maintenance_requests"."id"), 0)
  + coalesce((select sum(l.total) from maintenance_labor l where l.maintenance_request_id = "maintenance_requests"."id"), 0)
)::numeric(16,2)::text`;

const listColumns = {
  id: maintenanceRequests.id,
  number: maintenanceRequests.number,
  issue: maintenanceRequests.issue,
  priority: maintenanceRequests.priority,
  status: maintenanceRequests.status,
  odometer: maintenanceRequests.odometer,
  vehicleId: maintenanceRequests.vehicleId,
  plateNumber: vehicles.plateNumber,
  projectId: maintenanceRequests.projectId,
  projectName: projects.name,
  assignedTo: maintenanceRequests.assignedTo,
  technicianName: technician.name,
  requestedBy: maintenanceRequests.requestedBy,
  requestedByName: requester.name,
  createdAt: maintenanceRequests.createdAt,
  updatedAt: maintenanceRequests.updatedAt,
  completedAt: maintenanceRequests.completedAt,
  cost: costExpr,
};

function baseList() {
  return db
    .select(listColumns)
    .from(maintenanceRequests)
    .innerJoin(vehicles, eq(vehicles.id, maintenanceRequests.vehicleId))
    .leftJoin(projects, eq(projects.id, maintenanceRequests.projectId))
    .leftJoin(technician, eq(technician.id, maintenanceRequests.assignedTo))
    .innerJoin(requester, eq(requester.id, maintenanceRequests.requestedBy));
}

/** Cost is financial data: only exposed to callers who can read both parts and labor. */
const canSeeCost = (a: ReturnType<typeof ctx>["access"]) => a.has("maintenance.parts.read") && a.has("maintenance.labor.read");

const ListQuery = pagination.extend({
  q: z.string().trim().max(100).optional(),
  projectId: uuid.optional(),
  vehicleId: uuid.optional(),
  status: z.enum(maintenanceStatus.enumValues).optional(),
  open: z.enum(["true", "false"]).optional(),
  priority: z.enum(maintenancePriority.enumValues).optional(),
  technicianId: uuid.optional(),
  from: isoDate.optional(),
  to: isoDate.optional(),
});

maintenanceRouter.get("/maintenance", requirePermission("maintenance.read"), async (req, res) => {
  const { access } = ctx(req);
  const q = ListQuery.parse(req.query);
  const where: SQL[] = [maintenanceScope(access, "maintenance.read")];
  if (q.q) {
    const like = `%${q.q}%`;
    const parts: SQL[] = [ilike(vehicles.plateNumber, like), ilike(maintenanceRequests.issue, like), ilike(technician.name, like)];
    const num = /^(?:MR-?)?(\d{1,12})$/i.exec(q.q);
    if (num) parts.push(eq(maintenanceRequests.number, Number(num[1])));
    if (z.uuid().safeParse(q.q).success) parts.push(eq(maintenanceRequests.vehicleId, q.q), eq(maintenanceRequests.id, q.q));
    where.push(or(...parts)!);
  }
  if (q.projectId) where.push(eq(maintenanceRequests.projectId, q.projectId));
  if (q.vehicleId) where.push(eq(maintenanceRequests.vehicleId, q.vehicleId));
  if (q.status) where.push(eq(maintenanceRequests.status, q.status));
  if (q.open === "true") where.push(inArray(maintenanceRequests.status, OPEN_STATUSES));
  if (q.priority) where.push(eq(maintenanceRequests.priority, q.priority));
  if (q.technicianId) where.push(eq(maintenanceRequests.assignedTo, q.technicianId));
  const tz = config.APP_TIMEZONE;
  if (q.from) where.push(sql`(${maintenanceRequests.createdAt} at time zone ${tz})::date >= ${q.from}::date`);
  if (q.to) where.push(sql`(${maintenanceRequests.createdAt} at time zone ${tz})::date <= ${q.to}::date`);
  const cond = and(...where);
  const [rows, [count]] = await Promise.all([
    baseList().where(cond).orderBy(desc(maintenanceRequests.createdAt)).limit(q.pageSize).offset((q.page - 1) * q.pageSize),
    db
      .select({ n: sql<number>`count(*)::int` })
      .from(maintenanceRequests)
      .innerJoin(vehicles, eq(vehicles.id, maintenanceRequests.vehicleId))
      .leftJoin(technician, eq(technician.id, maintenanceRequests.assignedTo))
      .where(cond),
  ]);
  const showCost = canSeeCost(access);
  res.json(paged(rows.map((r) => ({ ...r, cost: showCost ? r.cost : null })), count?.n ?? 0, q.page, q.pageSize));
});

// ---------------------------------------------------------------- create

const CreateBody = z
  .object({
    vehicleId: uuid,
    issue: trimmed(3, 200),
    description: optionalText(4000),
    priority: z.enum(maintenancePriority.enumValues),
    odometer: z.coerce.number().int().min(0).max(5_000_000).nullable().optional(),
  })
  .strict(); // projectId/status/requestedBy are server-derived: sending them is a 400.

maintenanceRouter.post("/maintenance", requirePermission("maintenance.create"), async (req, res) => {
  const { access } = ctx(req);
  const body = CreateBody.parse(req.body);
  // The vehicle must be visible to the caller; its project becomes the request's project.
  const vehicle = await getVehicleInScope(db, access, body.vehicleId, "vehicles.read");
  if (vehicle.status === "ARCHIVED" || vehicle.status === "SOLD") throw badRequest("لا يمكن طلب صيانة لمركبة مؤرشفة أو مباعة");
  if (vehicle.projectId) await assertCanUseProject(db, access, vehicle.projectId, "maintenance.create");
  else if (access.require("maintenance.create") !== "ALL") throw forbidden("المركبة غير مخصصة لمشروع من مشاريعك");

  const created = await db.transaction(async (tx) => {
    const [mr] = await tx
      .insert(maintenanceRequests)
      .values({
        organizationId: access.orgId,
        vehicleId: vehicle.id,
        projectId: vehicle.projectId,
        requestedBy: access.userId,
        issue: body.issue,
        description: body.description ?? null,
        priority: body.priority,
        odometer: body.odometer ?? vehicle.currentOdometer,
      })
      .returning();
    await recordEvent(tx, req, mr!, { type: "CREATED", audit: "MAINTENANCE_CREATED", to: "REQUESTED", metadata: { issue: mr!.issue, priority: mr!.priority, plateNumber: vehicle.plateNumber } });
    const pms = await projectManagersOf(tx, mr!);
    await notifyMaintenance(tx, access.userId, mr!, pms, "MAINTENANCE_REQUESTED", `طلب صيانة جديد ${mrLabel(mr!)} للمركبة ${vehicle.plateNumber}`);
    if (mr!.priority === "CRITICAL") {
      await notifyMaintenance(tx, access.userId, mr!, await exceptionRecipients(tx, mr!), "MAINTENANCE_CRITICAL", `طلب صيانة حرج ${mrLabel(mr!)} للمركبة ${vehicle.plateNumber}`);
    }
    return mr!;
  });
  res.status(201).json({ data: created });
});

// ---------------------------------------------------------------- detail

maintenanceRouter.get("/maintenance/:id", requirePermission("maintenance.read"), async (req, res) => {
  const { access } = ctx(req);
  const { id } = idParam.parse(req.params);
  const { mr, assigned } = await loadRequest(access, id, "maintenance.read", "read");
  const [row] = await baseList().where(eq(maintenanceRequests.id, id));
  const can = (perm: Parameters<typeof canOnMaintenance>[1]) => canOnMaintenance(access, perm, mr, assigned, "read");

  const parts = can("maintenance.parts.read")
    ? await db
        .select({ id: maintenanceParts.id, partName: maintenanceParts.partName, partNumber: maintenanceParts.partNumber, quantity: maintenanceParts.quantity, unitPrice: maintenanceParts.unitPrice, total: maintenanceParts.total, vendorId: maintenanceParts.vendorId, vendorName: vendors.name, notes: maintenanceParts.notes, createdAt: maintenanceParts.createdAt })
        .from(maintenanceParts)
        .leftJoin(vendors, eq(vendors.id, maintenanceParts.vendorId))
        .where(eq(maintenanceParts.maintenanceRequestId, id))
        .orderBy(asc(maintenanceParts.createdAt))
    : null;
  const labor = can("maintenance.labor.read")
    ? await db.select().from(maintenanceLabor).where(eq(maintenanceLabor.maintenanceRequestId, id)).orderBy(asc(maintenanceLabor.createdAt))
    : null;
  const quoteCreator = alias(users, "quote_creator");
  const quotes = can("maintenance.quote.read")
    ? await db
        .select({
          id: maintenanceQuotes.id,
          vendorId: maintenanceQuotes.vendorId,
          vendorName: vendors.name,
          quoteNumber: maintenanceQuotes.quoteNumber,
          amount: maintenanceQuotes.amount,
          validUntil: maintenanceQuotes.validUntil,
          notes: maintenanceQuotes.notes,
          status: maintenanceQuotes.status,
          reviewReason: maintenanceQuotes.reviewReason,
          submittedAt: maintenanceQuotes.submittedAt,
          reviewedAt: maintenanceQuotes.reviewedAt,
          createdByName: quoteCreator.name,
          fileName: files.originalName,
          createdAt: maintenanceQuotes.createdAt,
        })
        .from(maintenanceQuotes)
        .leftJoin(vendors, eq(vendors.id, maintenanceQuotes.vendorId))
        .leftJoin(files, eq(files.id, maintenanceQuotes.attachmentFileId))
        .innerJoin(quoteCreator, eq(quoteCreator.id, maintenanceQuotes.createdBy))
        .where(eq(maintenanceQuotes.maintenanceRequestId, id))
        .orderBy(desc(maintenanceQuotes.createdAt))
    : null;
  const uploader = alias(users, "uploader");
  const attachments = await db
    .select({ id: maintenanceAttachments.id, category: maintenanceAttachments.category, notes: maintenanceAttachments.notes, fileName: files.originalName, fileSize: files.sizeBytes, fileMime: files.mimeType, uploadedByName: uploader.name, createdAt: maintenanceAttachments.createdAt })
    .from(maintenanceAttachments)
    .innerJoin(files, eq(files.id, maintenanceAttachments.fileId))
    .leftJoin(uploader, eq(uploader.id, maintenanceAttachments.uploadedBy))
    .where(eq(maintenanceAttachments.maintenanceRequestId, id))
    .orderBy(desc(maintenanceAttachments.createdAt));
  const actor = alias(users, "actor");
  const timeline = await db
    .select({ id: maintenanceEvents.id, type: maintenanceEvents.type, fromStatus: maintenanceEvents.fromStatus, toStatus: maintenanceEvents.toStatus, reason: maintenanceEvents.reason, metadata: maintenanceEvents.metadata, actor: actor.name, createdAt: maintenanceEvents.createdAt })
    .from(maintenanceEvents)
    .leftJoin(actor, eq(actor.id, maintenanceEvents.actorId))
    .where(eq(maintenanceEvents.maintenanceRequestId, id))
    .orderBy(desc(maintenanceEvents.id));

  const state = await stateOf(db, mr);
  const costAllowed = can("maintenance.parts.read") && can("maintenance.labor.read");
  const editable = (field: string) => EDITABLE_FIELDS[field]!.includes(mr.status) && canOnMaintenance(access, "maintenance.update", mr, assigned, "act");
  const actRole = (perm: Parameters<typeof canOnMaintenance>[1]) => canOnMaintenance(access, perm, mr, assigned, "act");
  const costEditable = ["INSPECTION", "QUOTE_PENDING", "PENDING_APPROVAL", "APPROVED", "IN_REPAIR"].includes(mr.status);

  res.json({
    data: {
      ...row,
      cost: costAllowed ? row!.cost : null,
      description: mr.description,
      diagnosis: mr.diagnosis,
      workPerformed: mr.workPerformed,
      notes: mr.notes,
      rejectionReason: mr.rejectionReason,
      handoverRejections: mr.handoverRejections,
      assignedAt: mr.assignedAt,
      inspectionStartedAt: mr.inspectionStartedAt,
      approvedAt: mr.approvedAt,
      startedAt: mr.startedAt,
      readyAt: mr.readyAt,
      closedAt: mr.closedAt,
      parts,
      labor,
      quotes,
      attachments,
      timeline,
      actions: availableActions(access, state, assigned),
      capabilities: {
        edit: Object.fromEntries(Object.keys(EDITABLE_FIELDS).map((f) => [f, editable(f)])),
        manageParts: costEditable && actRole("maintenance.parts.manage"),
        manageLabor: costEditable && actRole("maintenance.labor.manage"),
        createQuote: ["QUOTE_PENDING", "PENDING_APPROVAL"].includes(mr.status) && actRole("maintenance.quote.create"),
        approveQuote: mr.status === "PENDING_APPROVAL" && actRole("maintenance.quote.approve"),
        rejectQuote: mr.status === "PENDING_APPROVAL" && actRole("maintenance.quote.reject"),
        upload: !TERMINAL.includes(mr.status as MaintenanceStatus) && actRole("maintenance.update"),
      },
    },
  });
});

// ---------------------------------------------------------------- update (no status!)

const UpdateBody = z
  .object({
    issue: trimmed(3, 200).optional(),
    description: optionalText(4000),
    priority: z.enum(maintenancePriority.enumValues).optional(),
    odometer: z.coerce.number().int().min(0).max(5_000_000).nullable().optional(),
    diagnosis: optionalText(4000),
    workPerformed: optionalText(4000),
    notes: optionalText(2000),
  })
  .strict(); // status, projectId, vehicleId, assignedTo, totals… are rejected with 400.

maintenanceRouter.patch("/maintenance/:id", requirePermission("maintenance.update"), async (req, res) => {
  const { access } = ctx(req);
  const { id } = idParam.parse(req.params);
  const { mr } = await loadRequest(access, id, "maintenance.update");
  const patch = UpdateBody.parse(req.body);
  const fields = Object.keys(patch).filter((k) => patch[k as keyof typeof patch] !== undefined);
  if (!fields.length) throw badRequest("لا توجد تغييرات");
  for (const f of fields) {
    if (!EDITABLE_FIELDS[f]!.includes(mr.status)) throw invalidTransition(`لا يمكن تعديل هذا الحقل في الحالة الحالية (${f})`);
  }
  const updated = await db.transaction(async (tx) => {
    const [u] = await tx
      .update(maintenanceRequests)
      .set({ ...patch, updatedAt: new Date() })
      .where(and(eq(maintenanceRequests.id, id), eq(maintenanceRequests.status, mr.status)))
      .returning();
    if (!u) throw invalidTransition("تم تعديل الطلب من مستخدم آخر، أعد تحميل الصفحة");
    const changes = diff(mr, patch);
    if (Object.keys(changes).length) {
      await recordEvent(tx, req, mr, { type: changes.diagnosis ? "DIAGNOSIS_UPDATED" : changes.workPerformed ? "WORK_UPDATED" : "UPDATED", audit: "MAINTENANCE_UPDATED", metadata: { changes } });
    }
    return u;
  });
  res.json({ data: updated });
});

// ---------------------------------------------------------------- assign technician

async function technicianCandidates(mr: MR) {
  // Must hold maintenance.update (any scope) AND belong to the request's project, or hold it org-wide.
  return permissionHolders(db, mr.organizationId, "maintenance.update", mr.projectId, { includeAllScope: true, includeAssignedScope: true });
}

maintenanceRouter.get("/maintenance/:id/technicians", requirePermission("maintenance.assign"), async (req, res) => {
  const { access } = ctx(req);
  const { id } = idParam.parse(req.params);
  const { mr } = await loadRequest(access, id, "maintenance.assign");
  const ids = await technicianCandidates(mr);
  const rows = ids.length ? await db.select({ id: users.id, name: users.name, email: users.email }).from(users).where(inArray(users.id, ids)).orderBy(asc(users.name)) : [];
  res.json({ data: rows });
});

const AssignBody = z.object({ technicianId: uuid }).strict();

maintenanceRouter.post("/maintenance/:id/assign", requirePermission("maintenance.assign"), async (req, res) => {
  const { access } = ctx(req);
  const { id } = idParam.parse(req.params);
  const { mr } = await loadRequest(access, id, "maintenance.assign");
  if (!ASSIGNABLE.includes(mr.status as MaintenanceStatus)) throw invalidTransition("لا يمكن إسناد فني في حالة الطلب الحالية");
  const { technicianId } = AssignBody.parse(req.body);
  if (technicianId === mr.assignedTo) throw badRequest("الفني مسند مسبقًا");
  // Assignment never grants permission: the technician must already hold maintenance.update for this project.
  if (!(await technicianCandidates(mr)).includes(technicianId)) throw badRequest("المستخدم لا يملك صلاحية تنفيذ الصيانة في هذا المشروع");
  const [tech] = await db.select({ name: users.name }).from(users).where(eq(users.id, technicianId));
  const updated = await db.transaction(async (tx) => {
    const [u] = await tx
      .update(maintenanceRequests)
      .set({ assignedTo: technicianId, assignedAt: new Date(), updatedAt: new Date() })
      .where(and(eq(maintenanceRequests.id, id), eq(maintenanceRequests.status, mr.status)))
      .returning();
    if (!u) throw invalidTransition("تم تعديل الطلب من مستخدم آخر، أعد تحميل الصفحة");
    await syncTechnicianAssignment(tx, u, technicianId, access.userId);
    await recordEvent(tx, req, mr, { type: "ASSIGNED", audit: "MAINTENANCE_ASSIGNED", metadata: { fromTechnicianId: mr.assignedTo, toTechnicianId: technicianId, technicianName: tech?.name } });
    await notifyMaintenance(tx, access.userId, u, [technicianId], "MAINTENANCE_ASSIGNED", `تم إسناد طلب الصيانة ${mrLabel(u)} إليك`);
    return u;
  });
  res.json({ data: updated });
});

// ---------------------------------------------------------------- workflow actions

const ReasonBody = z.object({ reason: z.string().trim().min(3, "السبب مطلوب (3 أحرف على الأقل)").max(1000) }).strict();
const EmptyBody = z.object({}).strict();

async function runAction(req: express.Request, action: ActionKey) {
  const { access } = ctx(req);
  const { id } = idParam.parse(req.params);
  const def = ACTIONS[action];
  const { mr } = await loadRequest(access, id, def.perm);
  const reason = def.requiresReason ? ReasonBody.parse(req.body ?? {}).reason : (EmptyBody.parse(req.body ?? {}), null);
  if (!def.from.includes(mr.status as MaintenanceStatus)) throw invalidTransition();
  const pre = preconditionError(action, await stateOf(db, mr));
  if (pre) throw invalidTransition(pre);

  return db.transaction(async (tx) => {
    const now = new Date();
    const extra: Partial<typeof maintenanceRequests.$inferInsert> = {};
    if (action === "startInspection") extra.inspectionStartedAt = now;
    if (action === "approve") extra.approvedAt = now;
    if (action === "startRepair") extra.startedAt = now;
    if (action === "markReady") extra.readyAt = now;
    if (action === "reject" || action === "rejectHandover") extra.rejectionReason = reason;
    if (action === "rejectHandover") extra.handoverRejections = mr.handoverRejections + 1;
    if (action === "acceptHandover") extra.completedAt = now;
    if (action === "close") extra.closedAt = now;
    if (action === "startRepair") {
      const before = await vehicleIntoMaintenance(tx, req, mr);
      if (before) extra.vehicleStatusBefore = before;
    }
    let u = await changeStatus(tx, mr, def.to, extra);
    await recordEvent(tx, req, mr, { type: def.event, audit: def.audit, from: mr.status, to: def.to, reason });
    const pms = () => projectManagersOf(tx, u);

    switch (action) {
      case "approve":
        await notifyMaintenance(tx, access.userId, u, [u.assignedTo], "MAINTENANCE_APPROVED", `تم اعتماد تنفيذ الصيانة ${mrLabel(u)} — يمكن بدء الإصلاح`);
        break;
      case "reject":
        await finishTechnicianAssignment(tx, u, "CANCELLED");
        await notifyMaintenance(tx, access.userId, u, [u.requestedBy, u.assignedTo, ...(await pms())], "MAINTENANCE_REJECTED", `تم رفض طلب الصيانة ${mrLabel(u)}: ${reason}`);
        break;
      case "markReady":
        await notifyMaintenance(tx, access.userId, u, await pms(), "MAINTENANCE_READY_FOR_HANDOVER", `المركبة جاهزة للاستلام — ${mrLabel(u)}`);
        break;
      case "rejectHandover":
        await notifyMaintenance(tx, access.userId, u, [u.assignedTo], "MAINTENANCE_RETURNED_FOR_REPAIR", `أعيد طلب الصيانة ${mrLabel(u)} للإصلاح: ${reason}`);
        await notifyMaintenance(tx, access.userId, u, await exceptionRecipients(tx, u), "MAINTENANCE_HANDOVER_REJECTED", `رُفض استلام المركبة بعد الصيانة ${mrLabel(u)} (مرة ${u.handoverRejections})`);
        break;
      case "acceptHandover": {
        await vehicleOutOfMaintenance(tx, req, u);
        // Accepting closes the request when the same user also holds maintenance.close for it.
        if (canOnMaintenance(access, "maintenance.close", u, false, "act")) {
          const closed = await changeStatus(tx, u, "CLOSED", { closedAt: new Date() });
          await recordEvent(tx, req, u, { type: ACTIONS.close.event, audit: ACTIONS.close.audit, from: "ACCEPTED", to: "CLOSED" });
          u = closed;
          await finishTechnicianAssignment(tx, u, "COMPLETED");
        }
        const msg = u.status === "CLOSED" ? `تم قبول استلام المركبة وإغلاق ${mrLabel(u)}` : `تم قبول استلام المركبة — ${mrLabel(u)} بانتظار الإغلاق`;
        await notifyMaintenance(tx, access.userId, u, [u.assignedTo, u.requestedBy], "MAINTENANCE_ACCEPTED", msg);
        break;
      }
      case "close":
        await finishTechnicianAssignment(tx, u, "COMPLETED");
        await notifyMaintenance(tx, access.userId, u, [u.assignedTo, u.requestedBy], "MAINTENANCE_CLOSED", `تم إغلاق طلب الصيانة ${mrLabel(u)}`);
        break;
    }
    return u;
  });
}

const ACTION_ROUTES: [string, ActionKey][] = [
  ["start-inspection", "startInspection"],
  ["complete-inspection", "completeInspection"],
  ["approve", "approve"],
  ["reject", "reject"],
  ["start-repair", "startRepair"],
  ["mark-ready", "markReady"],
  ["accept-handover", "acceptHandover"],
  ["reject-handover", "rejectHandover"],
  ["close", "close"],
];
for (const [path, action] of ACTION_ROUTES) {
  maintenanceRouter.post(`/maintenance/:id/${path}`, requirePermission(ACTIONS[action].perm), async (req, res) => {
    const u = await runAction(req, action);
    res.json({ data: u });
  });
}

// ---------------------------------------------------------------- attachments

const rawUpload = express.raw({ type: () => true, limit: MAX_UPLOAD_BYTES });

maintenanceRouter.post("/maintenance/:id/attachments", requirePermission("maintenance.update"), rawUpload, async (req, res) => {
  const { access } = ctx(req);
  const { id } = idParam.parse(req.params);
  const { mr } = await loadRequest(access, id, "maintenance.update");
  if (TERMINAL.includes(mr.status as MaintenanceStatus)) throw invalidTransition("لا يمكن إضافة مرفقات لطلب منتهٍ");
  const { category } = z.object({ category: z.enum(maintenanceAttachmentCategory.enumValues).default("OTHER") }).parse(req.query);
  const created = await db.transaction(async (tx) => {
    const f = await storeUpload(tx, req, access.orgId, access.userId);
    const [a] = await tx.insert(maintenanceAttachments).values({ organizationId: access.orgId, maintenanceRequestId: mr.id, fileId: f.id, category, uploadedBy: access.userId }).returning();
    await recordEvent(tx, req, mr, { type: "ATTACHMENT_ADDED", audit: "FILE_UPLOADED", entity: "maintenance_attachment", entityId: a!.id, metadata: { category, fileName: f.originalName, sizeBytes: f.sizeBytes } });
    return { ...a!, fileName: f.originalName, fileSize: f.sizeBytes, fileMime: f.mimeType };
  });
  res.status(201).json({ data: created });
});

maintenanceRouter.get("/maintenance-attachments/:id/file", requirePermission("maintenance.read"), async (req, res) => {
  const { access } = ctx(req);
  const { id } = idParam.parse(req.params);
  const [att] = await db.select().from(maintenanceAttachments).where(and(eq(maintenanceAttachments.id, id), eq(maintenanceAttachments.organizationId, access.orgId))).limit(1);
  if (!att) throw notFound("المرفق غير موجود");
  // Re-authorize through the parent request (404 when outside the caller's scope).
  const { mr } = await loadRequest(access, att.maintenanceRequestId, "maintenance.read", "read");
  await audit(db, req, { action: "FILE_DOWNLOADED", entity: "maintenance_attachment", entityId: id, projectId: mr.projectId, metadata: { maintenanceId: mr.id } });
  await sendStoredFile(db, res, att.fileId);
});

// ---------------------------------------------------------------- vehicle summary (Vehicle Detail → Maintenance tab)

maintenanceRouter.get("/vehicles/:id/maintenance", requirePermission("maintenance.read"), async (req, res) => {
  const { access } = ctx(req);
  const { id } = idParam.parse(req.params);
  await getVehicleInScope(db, access, id, "vehicles.read");
  const scoped = and(eq(maintenanceRequests.vehicleId, id), maintenanceScope(access, "maintenance.read"));
  const history = await baseList().where(scoped).orderBy(desc(maintenanceRequests.createdAt)).limit(100);
  const showCost = canSeeCost(access);
  const open = history.filter((h) => OPEN_STATUSES.includes(h.status as MaintenanceStatus));
  const last = history.find((h) => h.status === "CLOSED") ?? null;
  const total = showCost ? history.filter((h) => h.status !== "REJECTED").reduce((a, h) => a + Number(h.cost), 0).toFixed(2) : null;
  res.json({
    data: {
      current: open[0] ? { id: open[0].id, number: open[0].number, status: open[0].status, issue: open[0].issue } : null,
      openCount: open.length,
      awaitingApproval: history.filter((h) => h.status === "PENDING_APPROVAL").length,
      awaitingHandover: history.filter((h) => h.status === "READY_FOR_HANDOVER").length,
      lastMaintenance: last ? { id: last.id, number: last.number, issue: last.issue, completedAt: last.completedAt } : null,
      totalCost: total,
      // Planned/periodic maintenance is not built yet — explicitly null, never invented.
      nextPlanned: null,
      history: history.map((h) => ({ ...h, cost: showCost ? h.cost : null })),
    },
  });
});

