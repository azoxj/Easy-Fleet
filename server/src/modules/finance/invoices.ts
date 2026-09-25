import { and, desc, eq, ilike, inArray, or, sql, type SQL } from "drizzle-orm";
import { alias } from "drizzle-orm/pg-core";
import express, { Router, type Request } from "express";
import { z } from "zod";
import {
  assertCanUseProject,
  canOnRecord,
  hasAssignment,
  isAssignedToMaintenance,
  maintenanceScope,
  permissionHolders,
  recordScope,
  type Access,
} from "../../auth/access.js";
import { db } from "../../db/client.js";
import { auditLogs, files, invoices, invoiceStatus, invoiceTransfers, maintenanceRequests, projects, users, vehicles, vendors } from "../../db/schema/index.js";
import { ctx } from "../../http/context.js";
import { badRequest, forbidden, HttpError, notFound } from "../../http/errors.js";
import { requirePermission } from "../../http/middleware.js";
import { idParam, isoDate, money, optionalText, paged, pagination, uuid } from "../../http/validate.js";
import { today } from "../../lib/clock.js";
import { uploadRateLimit } from "../../lib/pg-rate-limit.js";
import { audit, diff } from "../../services/audit.js";
import { notifyUsers } from "../../services/notifications.js";
import { MAX_UPLOAD_BYTES, sendStoredFile, storeUpload } from "../../services/storage.js";
import { EDITABLE, INVOICE_ACTIONS, type InvoiceAction, type InvoiceStatus } from "./invoice-workflow.js";

export const invoicesRouter = Router();
type Invoice = typeof invoices.$inferSelect;

export const invLabel = (n: number) => `INV-${n}`;
const invalid = (m = "هذا الإجراء غير مسموح في حالة الفاتورة الحالية") => new HttpError(409, "INVALID_TRANSITION", m);

/** Invoices visible to the caller: ALL / PROJECT (member) / ASSIGNED (own or assigned via Assignments). */
export function invoiceScope(a: Access, perm: Parameters<Access["require"]>[0] = "invoices.read"): SQL {
  return recordScope(a, perm, {
    orgCol: invoices.organizationId,
    projectCol: invoices.projectId,
    assigned: sql`(${invoices.createdBy} = ${a.userId} or ${hasAssignment(a, "INVOICE", invoices.id)})`,
  });
}

async function loadInvoice(a: Access, id: string) {
  const [inv] = await db.select().from(invoices).where(and(eq(invoices.id, id), invoiceScope(a))).limit(1);
  if (!inv) throw notFound("الفاتورة غير موجودة");
  const [asg] = await db.execute<{ ok: boolean }>(sql`select (${inv.createdBy} = ${a.userId} or ${hasAssignment(a, "INVOICE", sql`${id}::uuid`)}) as ok`).then((r) => r.rows);
  return { inv, assigned: !!asg?.ok };
}

function assertCan(a: Access, perm: Parameters<Access["require"]>[0], inv: Invoice, assigned: boolean) {
  if (!a.has(perm)) throw forbidden();
  if (!canOnRecord(a, perm, inv, assigned, "act")) throw forbidden();
}

const columns = (t: string) => ({
  id: invoices.id,
  number: invoices.number,
  projectId: invoices.projectId,
  projectName: projects.name,
  vendorId: invoices.vendorId,
  vendorName: vendors.name,
  invoiceNumber: invoices.invoiceNumber,
  description: invoices.description,
  amount: invoices.amount,
  tax: invoices.tax,
  total: invoices.total,
  invoiceDate: invoices.invoiceDate,
  dueDate: invoices.dueDate,
  status: invoices.status,
  maintenanceRequestId: invoices.maintenanceRequestId,
  vehicleId: invoices.vehicleId,
  plateNumber: vehicles.plateNumber,
  createdBy: invoices.createdBy,
  createdByName: users.name,
  hasFile: sql<boolean>`(${invoices.fileId} is not null)`,
  rejectionReason: invoices.rejectionReason,
  createdAt: invoices.createdAt,
  updatedAt: invoices.updatedAt,
  overdue: sql<boolean>`(${invoices.dueDate} is not null and ${invoices.dueDate} < ${t}::date and ${invoices.status} not in ('TRANSFERRED','PAID','CANCELLED','REJECTED'))`,
});

function base(t = today()) {
  return db
    .select(columns(t))
    .from(invoices)
    .innerJoin(projects, eq(projects.id, invoices.projectId))
    .leftJoin(vendors, eq(vendors.id, invoices.vendorId))
    .leftJoin(vehicles, eq(vehicles.id, invoices.vehicleId))
    .innerJoin(users, eq(users.id, invoices.createdBy));
}

const ListQuery = pagination.extend({
  q: z.string().trim().max(100).optional(),
  status: z.enum(invoiceStatus.enumValues).optional(),
  projectId: uuid.optional(),
  vendorId: uuid.optional(),
  overdue: z.enum(["true", "false"]).optional(),
  mine: z.enum(["true", "false"]).optional(),
  from: isoDate.optional(),
  to: isoDate.optional(),
});

invoicesRouter.get("/invoices", requirePermission("invoices.read"), async (req, res) => {
  const { access } = ctx(req);
  const q = ListQuery.parse(req.query);
  const t = today();
  const where: SQL[] = [invoiceScope(access)];
  if (q.q) {
    const like = `%${q.q}%`;
    const parts: SQL[] = [ilike(invoices.invoiceNumber, like), ilike(vendors.name, like), ilike(invoices.description, like)];
    const n = /^(?:INV-?)?(\d{1,12})$/i.exec(q.q);
    if (n) parts.push(eq(invoices.number, Number(n[1])));
    where.push(or(...parts)!);
  }
  if (q.status) where.push(eq(invoices.status, q.status));
  if (q.projectId) where.push(eq(invoices.projectId, q.projectId));
  if (q.vendorId) where.push(eq(invoices.vendorId, q.vendorId));
  if (q.mine === "true") where.push(eq(invoices.createdBy, access.userId));
  if (q.overdue === "true") where.push(sql`${invoices.dueDate} < ${t}::date and ${invoices.status} not in ('TRANSFERRED','PAID','CANCELLED','REJECTED')`);
  if (q.from) where.push(sql`${invoices.invoiceDate} >= ${q.from}::date`);
  if (q.to) where.push(sql`${invoices.invoiceDate} <= ${q.to}::date`);
  const cond = and(...where);
  const [rows, [count]] = await Promise.all([
    base(t).where(cond).orderBy(desc(invoices.createdAt)).limit(q.pageSize).offset((q.page - 1) * q.pageSize),
    db.select({ n: sql<number>`count(*)::int` }).from(invoices).leftJoin(vendors, eq(vendors.id, invoices.vendorId)).where(cond),
  ]);
  res.json(paged(rows, count?.n ?? 0, q.page, q.pageSize));
});

const Body = z
  .object({
    projectId: uuid.optional(),
    maintenanceRequestId: uuid.optional(),
    vehicleId: uuid.nullable().optional(),
    vendorId: uuid.nullable().optional(),
    invoiceNumber: optionalText(60),
    description: optionalText(2000),
    amount: money,
    tax: money.optional(),
    invoiceDate: isoDate,
    dueDate: isoDate.nullable().optional(),
  })
  .strict(); // status, total, createdBy, approvedBy… are server-controlled.

async function resolveLinks(a: Access, b: { projectId?: string; maintenanceRequestId?: string; vehicleId?: string | null; vendorId?: string | null }) {
  let projectId = b.projectId;
  if (b.maintenanceRequestId) {
    // Project comes from the maintenance request, which must be visible to the caller.
    if (!a.has("maintenance.read")) throw forbidden();
    const [mr] = await db.select().from(maintenanceRequests).where(and(eq(maintenanceRequests.id, b.maintenanceRequestId), maintenanceScope(a, "maintenance.read")));
    if (!mr) throw notFound("طلب الصيانة غير موجود");
    if (!mr.projectId) throw badRequest("طلب الصيانة غير مرتبط بمشروع");
    if (projectId && projectId !== mr.projectId) throw badRequest("المشروع لا يطابق مشروع طلب الصيانة");
    projectId = mr.projectId;
    if (!b.vehicleId) b.vehicleId = mr.vehicleId;
    void isAssignedToMaintenance;
  }
  if (!projectId) throw badRequest("يجب تحديد المشروع");
  await assertCanUseProject(db, a, projectId, "invoices.create");
  if (b.vehicleId) {
    const [v] = await db.select({ projectId: vehicles.projectId }).from(vehicles).where(and(eq(vehicles.id, b.vehicleId), eq(vehicles.organizationId, a.orgId)));
    if (!v || v.projectId !== projectId) throw badRequest("المركبة لا تتبع هذا المشروع");
  }
  if (b.vendorId) {
    const [v] = await db.select({ id: vendors.id }).from(vendors).where(and(eq(vendors.id, b.vendorId), eq(vendors.organizationId, a.orgId), eq(vendors.status, "ACTIVE")));
    if (!v) throw badRequest("المورد غير موجود أو غير نشط");
  }
  return projectId;
}

function checkDates(invoiceDate: string, dueDate?: string | null) {
  if (dueDate && dueDate < invoiceDate) throw badRequest("تاريخ الاستحقاق يجب أن يكون بعد تاريخ الفاتورة");
  if (invoiceDate > today()) throw badRequest("تاريخ الفاتورة لا يمكن أن يكون في المستقبل");
}

invoicesRouter.post("/invoices", requirePermission("invoices.create"), async (req, res) => {
  const { access } = ctx(req);
  const b = Body.parse(req.body);
  checkDates(b.invoiceDate, b.dueDate);
  const projectId = await resolveLinks(access, b);
  const tax = b.tax ?? "0";
  const created = await db.transaction(async (tx) => {
    const [inv] = await tx
      .insert(invoices)
      .values({
        organizationId: access.orgId,
        projectId,
        maintenanceRequestId: b.maintenanceRequestId ?? null,
        vehicleId: b.vehicleId ?? null,
        vendorId: b.vendorId ?? null,
        invoiceNumber: b.invoiceNumber ?? null,
        description: b.description ?? null,
        amount: b.amount,
        tax,
        total: sql`(${b.amount}::numeric + ${tax}::numeric)`,
        invoiceDate: b.invoiceDate,
        dueDate: b.dueDate ?? null,
        createdBy: access.userId,
      })
      .returning();
    await audit(tx, req, { action: "INVOICE_CREATED", entity: "invoice", entityId: inv!.id, projectId, vehicleId: inv!.vehicleId, newValue: { status: "DRAFT", total: inv!.total }, metadata: { number: invLabel(inv!.number), total: inv!.total } });
    return inv!;
  });
  res.status(201).json({ data: created });
});

invoicesRouter.get("/invoices/:id", requirePermission("invoices.read"), async (req, res) => {
  const { access } = ctx(req);
  const { id } = idParam.parse(req.params);
  const { inv, assigned } = await loadInvoice(access, id);
  const [row] = await base().where(eq(invoices.id, id));
  const creator = alias(users, "transfer_by");
  const [transfer] = await db
    .select({ transferDate: invoiceTransfers.transferDate, amount: invoiceTransfers.amount, bank: invoiceTransfers.bank, reference: invoiceTransfers.reference, notes: invoiceTransfers.notes, createdByName: creator.name, createdAt: invoiceTransfers.createdAt })
    .from(invoiceTransfers)
    .innerJoin(creator, eq(creator.id, invoiceTransfers.createdBy))
    .where(eq(invoiceTransfers.invoiceId, id));
  const actor = alias(users, "actor");
  const timeline = await db
    .select({ id: auditLogs.id, action: auditLogs.action, metadata: auditLogs.metadata, actor: actor.name, createdAt: auditLogs.createdAt })
    .from(auditLogs)
    .leftJoin(actor, eq(actor.id, auditLogs.userId))
    .where(and(eq(auditLogs.entity, "invoice"), eq(auditLogs.entityId, id), eq(auditLogs.organizationId, access.orgId)))
    .orderBy(desc(auditLogs.id));
  const [file] = inv.fileId ? await db.select({ name: files.originalName }).from(files).where(eq(files.id, inv.fileId)) : [];
  res.json({ data: { ...row, fileName: file?.name ?? null, transfer: transfer ?? null, timeline, actions: availableActions(access, inv, assigned) } });
});

export function availableActions(a: Access, inv: Invoice, assigned: boolean): string[] {
  const out: string[] = [];
  const isCreator = inv.createdBy === a.userId;
  if (EDITABLE.includes(inv.status as InvoiceStatus) && isCreator) out.push("edit", "upload");
  for (const [k, d] of Object.entries(INVOICE_ACTIONS) as [InvoiceAction, (typeof INVOICE_ACTIONS)[InvoiceAction]][]) {
    if (!d.from.includes(inv.status as InvoiceStatus)) continue;
    if (d.creatorOnly && !isCreator) continue;
    if (d.notCreator && isCreator) continue;
    if (!canOnRecord(a, d.perm, inv, assigned, "act")) continue;
    out.push(k);
  }
  return out;
}

invoicesRouter.patch("/invoices/:id", requirePermission("invoices.create"), async (req, res) => {
  const { access } = ctx(req);
  const { id } = idParam.parse(req.params);
  const { inv } = await loadInvoice(access, id);
  if (inv.createdBy !== access.userId) throw forbidden("يمكن لصاحب الفاتورة فقط تعديلها");
  if (!EDITABLE.includes(inv.status as InvoiceStatus)) throw invalid("لا يمكن تعديل الفاتورة في حالتها الحالية");
  const patch = Body.omit({ projectId: true, maintenanceRequestId: true }).partial().parse(req.body);
  checkDates(patch.invoiceDate ?? inv.invoiceDate, patch.dueDate === undefined ? inv.dueDate : patch.dueDate);
  if (patch.vendorId || patch.vehicleId) await resolveLinks(access, { projectId: inv.projectId, vendorId: patch.vendorId, vehicleId: patch.vehicleId });
  const amount = patch.amount ?? inv.amount;
  const tax = patch.tax ?? inv.tax;
  const updated = await db.transaction(async (tx) => {
    const [u] = await tx
      .update(invoices)
      .set({ ...patch, amount, tax, total: sql`(${amount}::numeric + ${tax}::numeric)`, updatedAt: new Date() })
      .where(and(eq(invoices.id, id), inArray(invoices.status, EDITABLE)))
      .returning();
    if (!u) throw invalid();
    const changes = diff(inv, patch);
    if (Object.keys(changes).length) await audit(tx, req, { action: "INVOICE_UPDATED", entity: "invoice", entityId: id, projectId: inv.projectId, metadata: { changes } });
    return u;
  });
  res.json({ data: updated });
});

const rawUpload = express.raw({ type: () => true, limit: MAX_UPLOAD_BYTES });

invoicesRouter.put("/invoices/:id/file", requirePermission("invoices.upload"), uploadRateLimit, rawUpload, async (req, res) => {
  const { access } = ctx(req);
  const { id } = idParam.parse(req.params);
  const { inv, assigned } = await loadInvoice(access, id);
  assertCan(access, "invoices.upload", inv, assigned);
  if (!EDITABLE.includes(inv.status as InvoiceStatus)) throw invalid("لا يمكن تغيير ملف الفاتورة بعد تقديمها");
  const f = await db.transaction(async (tx) => {
    const file = await storeUpload(tx, req, access.orgId, access.userId);
    await tx.update(invoices).set({ fileId: file.id, updatedAt: new Date() }).where(eq(invoices.id, id));
    await audit(tx, req, { action: "FILE_UPLOADED", entity: "invoice", entityId: id, projectId: inv.projectId, metadata: { kind: "invoice", fileName: file.originalName } });
    return file;
  });
  res.status(201).json({ data: { fileName: f.originalName, fileSize: f.sizeBytes } });
});

invoicesRouter.get("/invoices/:id/file", requirePermission("invoices.read"), async (req, res) => {
  const { access } = ctx(req);
  const { id } = idParam.parse(req.params);
  const { inv } = await loadInvoice(access, id);
  await audit(db, req, { action: "FILE_DOWNLOADED", entity: "invoice", entityId: id, projectId: inv.projectId, metadata: { kind: "invoice" } });
  await sendStoredFile(db, res, inv.fileId);
});

/** Receipt upload for a pending transfer (step 1). Returns a receipt id used by POST /transfer. */
invoicesRouter.post("/invoices/:id/receipt", requirePermission("finance.transfer"), uploadRateLimit, rawUpload, async (req, res) => {
  const { access } = ctx(req);
  const { id } = idParam.parse(req.params);
  const { inv, assigned } = await loadInvoice(access, id);
  assertCan(access, "finance.transfer", inv, assigned);
  if (inv.status !== "TRANSFER_PENDING") throw invalid("الفاتورة ليست بانتظار التحويل");
  const file = await db.transaction(async (tx) => {
    const f = await storeUpload(tx, req, access.orgId, access.userId);
    await audit(tx, req, { action: "FILE_UPLOADED", entity: "invoice", entityId: id, projectId: inv.projectId, metadata: { kind: "transfer_receipt", fileId: f.id, fileName: f.originalName } });
    return f;
  });
  res.status(201).json({ data: { receiptFileId: file.id, fileName: file.originalName } });
});

invoicesRouter.get("/invoices/:id/receipt", requirePermission("invoices.read"), async (req, res) => {
  const { access } = ctx(req);
  const { id } = idParam.parse(req.params);
  const { inv } = await loadInvoice(access, id);
  const [t] = await db.select().from(invoiceTransfers).where(eq(invoiceTransfers.invoiceId, id));
  if (!t) throw notFound("لا يوجد إيصال تحويل");
  await audit(db, req, { action: "FILE_DOWNLOADED", entity: "invoice", entityId: id, projectId: inv.projectId, metadata: { kind: "transfer_receipt" } });
  await sendStoredFile(db, res, t.receiptFileId);
});

// ---------------------------------------------------------------- workflow actions

const ReasonBody = z.object({ reason: z.string().trim().min(3, "السبب مطلوب (3 أحرف على الأقل)").max(1000) }).strict();
const TransferBody = z
  .object({
    transferDate: isoDate,
    amount: money,
    bank: z.string().trim().min(2).max(120),
    reference: z.string().trim().min(2).max(120),
    receiptFileId: uuid,
    notes: optionalText(1000),
  })
  .strict();

async function financeUsers(orgId: string, perm: "invoices.approve" | "finance.transfer", projectId: string) {
  return permissionHolders(db, orgId, perm, projectId, { includeAllScope: true });
}

async function runInvoiceAction(req: Request, action: InvoiceAction) {
  const { access } = ctx(req);
  const { id } = idParam.parse(req.params);
  const def = INVOICE_ACTIONS[action];
  const { inv, assigned } = await loadInvoice(access, id);
  assertCan(access, def.perm, inv, assigned);
  if (def.creatorOnly && inv.createdBy !== access.userId) throw forbidden("هذا الإجراء لصاحب الفاتورة فقط");
  // Separation of duties: nobody reviews, approves or rejects their own invoice.
  if (def.notCreator && inv.createdBy === access.userId) throw forbidden("لا يمكنك مراجعة أو اعتماد فاتورة قمت برفعها");
  const reason = def.reason ? ReasonBody.parse(req.body ?? {}).reason : null;
  const transfer = action === "transfer" ? TransferBody.parse(req.body ?? {}) : null;
  if (!def.reason && !transfer && req.body && Object.keys(req.body).length) throw badRequest("هذا الإجراء لا يقبل بيانات");
  if (!def.from.includes(inv.status as InvoiceStatus)) throw invalid();
  if (action === "submit" && !inv.fileId) throw invalid("يجب إرفاق ملف الفاتورة قبل التقديم");
  if (transfer) {
    if (Number(transfer.amount) <= 0 || Number(transfer.amount) > Number(inv.total)) throw badRequest("مبلغ التحويل يجب أن يكون أكبر من صفر ولا يتجاوز إجمالي الفاتورة");
    if (transfer.transferDate > today()) throw badRequest("تاريخ التحويل لا يمكن أن يكون في المستقبل");
    const [f] = await db.select().from(files).where(and(eq(files.id, transfer.receiptFileId), eq(files.organizationId, access.orgId), eq(files.uploadedBy, access.userId)));
    if (!f) throw badRequest("إيصال التحويل غير صالح — ارفع الإيصال أولًا");
    const [used] = await db.select({ id: invoiceTransfers.id }).from(invoiceTransfers).where(eq(invoiceTransfers.receiptFileId, f.id));
    if (used) throw badRequest("هذا الإيصال مستخدم في تحويل آخر");
  }

  return db.transaction(async (tx) => {
    const now = new Date();
    const extra: Partial<typeof invoices.$inferInsert> = {};
    if (action === "submit") Object.assign(extra, { submittedAt: now, rejectionReason: null, rejectedBy: null, rejectedAt: null });
    if (action === "startReview") extra.reviewStartedBy = access.userId;
    if (action === "approve") Object.assign(extra, { approvedBy: access.userId, approvedAt: now });
    if (action === "reject") Object.assign(extra, { rejectedBy: access.userId, rejectedAt: now, rejectionReason: reason });
    if (action === "cancel") extra.cancelledAt = now;
    if (action === "markPaid") extra.paidAt = now;
    // Approval moves straight on to TRANSFER_PENDING (both steps are recorded).
    const finalTo: InvoiceStatus = action === "approve" ? "TRANSFER_PENDING" : def.to;
    const [u] = await tx
      .update(invoices)
      .set({ ...extra, status: finalTo, updatedAt: now })
      .where(and(eq(invoices.id, id), eq(invoices.status, inv.status)))
      .returning();
    if (!u) throw invalid("تم تعديل الفاتورة من مستخدم آخر، أعد تحميل الصفحة");
    const label = invLabel(inv.number);
    await audit(tx, req, { action: def.audit, entity: "invoice", entityId: id, projectId: inv.projectId, vehicleId: inv.vehicleId, oldValue: { status: inv.status }, newValue: { status: def.to }, metadata: { number: label, fromStatus: inv.status, toStatus: def.to, ...(reason ? { reason } : {}) } });
    if (action === "approve") {
      await audit(tx, req, { action: "INVOICE_STATUS_CHANGED", entity: "invoice", entityId: id, projectId: inv.projectId, oldValue: { status: "APPROVED" }, newValue: { status: "TRANSFER_PENDING" }, metadata: { number: label, fromStatus: "APPROVED", toStatus: "TRANSFER_PENDING", trigger: "approved" } });
    }
    if (transfer) {
      await tx.insert(invoiceTransfers).values({ organizationId: access.orgId, invoiceId: id, transferDate: transfer.transferDate, amount: transfer.amount, bank: transfer.bank, reference: transfer.reference, receiptFileId: transfer.receiptFileId, notes: transfer.notes ?? null, createdBy: access.userId });
    }
    const notify = (userIds: string[], type: string, title: string) =>
      notifyUsers(tx, { orgId: access.orgId, userIds: userIds.filter((x) => x !== access.userId), type, title, link: `/finance/invoices/${id}`, entityType: "invoice", entityId: id, projectId: inv.projectId });
    switch (action) {
      case "submit":
        await notify(await financeUsers(access.orgId, "invoices.approve", inv.projectId), "INVOICE_SUBMITTED", `فاتورة جديدة ${label} بمبلغ ${inv.total} ريال تحتاج مراجعة`);
        break;
      case "approve":
        await notify([inv.createdBy], "INVOICE_APPROVED", `تم اعتماد الفاتورة ${label} وهي بانتظار التحويل`);
        await notify(await financeUsers(access.orgId, "finance.transfer", inv.projectId), "INVOICE_TRANSFER_PENDING", `الفاتورة ${label} بانتظار التحويل (${inv.total} ريال)`);
        break;
      case "reject":
        await notify([inv.createdBy], "INVOICE_REJECTED", `تم رفض الفاتورة ${label}: ${reason}`);
        break;
      case "transfer":
        await notify([inv.createdBy], "INVOICE_TRANSFERRED", `تم تحويل الفاتورة ${label} بمبلغ ${Number(transfer!.amount).toLocaleString("en-US")} ريال`);
        break;
      case "markPaid":
        await notify([inv.createdBy], "INVOICE_PAID", `تم إغلاق الفاتورة ${label} كمدفوعة`);
        break;
    }
    return u;
  });
}

const ROUTES: [string, InvoiceAction][] = [
  ["submit", "submit"],
  ["start-review", "startReview"],
  ["approve", "approve"],
  ["reject", "reject"],
  ["cancel", "cancel"],
  ["transfer", "transfer"],
  ["mark-paid", "markPaid"],
];
for (const [path, action] of ROUTES) {
  invoicesRouter.post(`/invoices/:id/${path}`, requirePermission(INVOICE_ACTIONS[action].perm), async (req, res) => {
    res.json({ data: await runInvoiceAction(req, action) });
  });
}

