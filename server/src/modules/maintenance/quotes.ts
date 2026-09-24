import { and, eq, inArray, ne } from "drizzle-orm";
import express, { Router } from "express";
import { z } from "zod";
import { canOnMaintenance, permissionHolders, type Access } from "../../auth/access.js";
import type { PermissionKey } from "../../auth/permissions.js";
import { db } from "../../db/client.js";
import { maintenanceQuotes, maintenanceRequests, vendors } from "../../db/schema/index.js";
import { ctx } from "../../http/context.js";
import { badRequest, forbidden, notFound } from "../../http/errors.js";
import { requirePermission } from "../../http/middleware.js";
import { idParam, isoDate, money, optionalText, uuid } from "../../http/validate.js";
import { today } from "../../lib/clock.js";
import { audit } from "../../services/audit.js";
import { MAX_UPLOAD_BYTES, sendStoredFile, storeUpload } from "../../services/storage.js";
import { changeStatus, invalidTransition, loadRequest, mrLabel, notifyMaintenance, projectManagersOf, recordEvent } from "./service.js";
import { QUOTE_OPEN, type MaintenanceStatus } from "./workflow.js";

export const quotesRouter = Router();

type Quote = typeof maintenanceQuotes.$inferSelect;

/**
 * Loads a quote and re-authorizes through its request:
 * unknown / other org / request outside read scope → 404; readable but not allowed to act → 403.
 */
async function loadQuote(a: Access, quoteId: string, perm: PermissionKey, mode: "read" | "act" = "act") {
  const [q] = await db.select().from(maintenanceQuotes).where(and(eq(maintenanceQuotes.id, quoteId), eq(maintenanceQuotes.organizationId, a.orgId))).limit(1);
  if (!q) throw notFound("عرض السعر غير موجود");
  const { mr, assigned } = await loadRequest(a, q.maintenanceRequestId, "maintenance.read", "read").catch((e) => {
    if (e?.status === 404) throw notFound("عرض السعر غير موجود");
    throw e;
  });
  if (!canOnMaintenance(a, perm, mr, assigned, mode)) throw forbidden();
  return { quote: q, mr };
}

async function assertVendor(orgId: string, vendorId: string | null | undefined) {
  if (!vendorId) return;
  const [v] = await db.select({ id: vendors.id }).from(vendors).where(and(eq(vendors.id, vendorId), eq(vendors.organizationId, orgId), eq(vendors.status, "ACTIVE")));
  if (!v) throw badRequest("المورد غير موجود أو غير نشط");
}

const validUntil = isoDate.nullable().optional().refine((d) => !d || d >= today(), "تاريخ صلاحية العرض يجب ألا يكون في الماضي");

const QuoteBody = z
  .object({
    vendorId: uuid.nullable().optional(),
    quoteNumber: optionalText(60),
    amount: money,
    validUntil,
    notes: optionalText(2000),
  })
  .strict(); // status / approved / createdBy are server-controlled.

quotesRouter.get("/maintenance/:id/quotes", requirePermission("maintenance.quote.read"), async (req, res) => {
  const { access } = ctx(req);
  const { id } = idParam.parse(req.params);
  await loadRequest(access, id, "maintenance.quote.read", "read");
  const rows = await db.select().from(maintenanceQuotes).where(eq(maintenanceQuotes.maintenanceRequestId, id));
  res.json({ data: rows.map(({ attachmentFileId, ...r }) => ({ ...r, hasFile: !!attachmentFileId })) });
});

quotesRouter.post("/maintenance/:id/quotes", requirePermission("maintenance.quote.create"), async (req, res) => {
  const { access } = ctx(req);
  const { id } = idParam.parse(req.params);
  const { mr } = await loadRequest(access, id, "maintenance.quote.create");
  if (!QUOTE_OPEN.includes(mr.status as MaintenanceStatus)) throw invalidTransition("لا يمكن إضافة عرض سعر في حالة الطلب الحالية");
  const body = QuoteBody.parse(req.body);
  await assertVendor(access.orgId, body.vendorId);
  const created = await db.transaction(async (tx) => {
    const [q] = await tx
      .insert(maintenanceQuotes)
      .values({ organizationId: access.orgId, maintenanceRequestId: mr.id, vendorId: body.vendorId ?? null, quoteNumber: body.quoteNumber ?? null, amount: body.amount, validUntil: body.validUntil ?? null, notes: body.notes ?? null, createdBy: access.userId })
      .returning();
    await recordEvent(tx, req, mr, { type: "QUOTE_CREATED", audit: "QUOTE_CREATED", entity: "maintenance_quote", entityId: q!.id, metadata: { quoteId: q!.id, amount: q!.amount } });
    return q!;
  });
  res.status(201).json({ data: created });
});

quotesRouter.patch("/maintenance-quotes/:id", requirePermission("maintenance.quote.create"), async (req, res) => {
  const { access } = ctx(req);
  const { id } = idParam.parse(req.params);
  const { quote, mr } = await loadQuote(access, id, "maintenance.quote.create");
  if (quote.status !== "DRAFT") throw invalidTransition("يمكن تعديل العرض في حالة المسودة فقط");
  const patch = QuoteBody.partial().parse(req.body);
  await assertVendor(access.orgId, patch.vendorId);
  const updated = await db.transaction(async (tx) => {
    const [q] = await tx.update(maintenanceQuotes).set({ ...patch, updatedAt: new Date() }).where(and(eq(maintenanceQuotes.id, id), eq(maintenanceQuotes.status, "DRAFT"))).returning();
    if (!q) throw invalidTransition();
    await audit(tx, req, { action: "QUOTE_UPDATED", entity: "maintenance_quote", entityId: id, projectId: mr.projectId, vehicleId: mr.vehicleId, metadata: { maintenanceId: mr.id } });
    return q;
  });
  res.json({ data: updated });
});

/** Guarded quote status change (current status must match). */
async function setQuoteStatus(tx: Parameters<Parameters<typeof db.transaction>[0]>[0], q: Quote, from: Quote["status"][], to: Quote["status"], extra: Partial<typeof maintenanceQuotes.$inferInsert> = {}) {
  const [u] = await tx
    .update(maintenanceQuotes)
    .set({ ...extra, status: to, updatedAt: new Date() })
    .where(and(eq(maintenanceQuotes.id, q.id), inArray(maintenanceQuotes.status, from)))
    .returning();
  if (!u) throw invalidTransition("تم تعديل العرض من مستخدم آخر، أعد تحميل الصفحة");
  return u;
}

const Empty = z.object({}).strict();
const Reason = z.object({ reason: z.string().trim().min(3, "سبب الرفض مطلوب (3 أحرف على الأقل)").max(1000) }).strict();

quotesRouter.post("/maintenance-quotes/:id/submit", requirePermission("maintenance.quote.create"), async (req, res) => {
  const { access } = ctx(req);
  const { id } = idParam.parse(req.params);
  Empty.parse(req.body ?? {});
  const { quote, mr } = await loadQuote(access, id, "maintenance.quote.create");
  if (quote.status !== "DRAFT") throw invalidTransition("تم تقديم هذا العرض مسبقًا");
  if (!QUOTE_OPEN.includes(mr.status as MaintenanceStatus)) throw invalidTransition("لا يمكن تقديم عروض في حالة الطلب الحالية");
  if (quote.validUntil && quote.validUntil < today()) throw badRequest("انتهت صلاحية العرض");
  const result = await db.transaction(async (tx) => {
    const q = await setQuoteStatus(tx, quote, ["DRAFT"], "SUBMITTED", { submittedAt: new Date() });
    await recordEvent(tx, req, mr, { type: "QUOTE_SUBMITTED", audit: "QUOTE_SUBMITTED", entity: "maintenance_quote", entityId: id, metadata: { quoteId: id, amount: q.amount } });
    let request = mr;
    if (mr.status === "QUOTE_PENDING") {
      // System transition: the server moves the request forward, never the client.
      request = await changeStatus(tx, mr, "PENDING_APPROVAL");
      await recordEvent(tx, req, mr, { type: "STATUS_CHANGED", audit: "MAINTENANCE_STATUS_CHANGED", from: "QUOTE_PENDING", to: "PENDING_APPROVAL", metadata: { trigger: "quote_submitted", quoteId: id } });
    }
    const approvers = await permissionHolders(tx, mr.organizationId, "maintenance.quote.approve", mr.projectId, { includeAllScope: true });
    await notifyMaintenance(tx, access.userId, request, approvers, "MAINTENANCE_QUOTE_REVIEW", `عرض سعر بقيمة ${q.amount} ريال يحتاج مراجعة — ${mrLabel(mr)}`);
    await notifyMaintenance(tx, access.userId, request, await projectManagersOf(tx, request), "MAINTENANCE_ACTION_REQUIRED", `تم تقديم عرض سعر لطلب الصيانة ${mrLabel(mr)}`);
    return q;
  });
  res.json({ data: result });
});

quotesRouter.post("/maintenance-quotes/:id/review", requirePermission("maintenance.quote.approve"), async (req, res) => {
  const { access } = ctx(req);
  const { id } = idParam.parse(req.params);
  Empty.parse(req.body ?? {});
  const { quote, mr } = await loadQuote(access, id, "maintenance.quote.approve");
  if (quote.status !== "SUBMITTED") throw invalidTransition("يمكن بدء مراجعة العروض المقدمة فقط");
  const q = await db.transaction(async (tx) => {
    const u = await setQuoteStatus(tx, quote, ["SUBMITTED"], "UNDER_REVIEW");
    await recordEvent(tx, req, mr, { type: "QUOTE_REVIEW_STARTED", audit: "QUOTE_REVIEW_STARTED", entity: "maintenance_quote", entityId: id, metadata: { quoteId: id } });
    return u;
  });
  res.json({ data: q });
});

quotesRouter.post("/maintenance-quotes/:id/approve", requirePermission("maintenance.quote.approve"), async (req, res) => {
  const { access } = ctx(req);
  const { id } = idParam.parse(req.params);
  Empty.parse(req.body ?? {});
  const { quote, mr } = await loadQuote(access, id, "maintenance.quote.approve");
  if (!["SUBMITTED", "UNDER_REVIEW"].includes(quote.status)) throw invalidTransition("لا يمكن اعتماد هذا العرض في حالته الحالية");
  if (mr.status !== "PENDING_APPROVAL") throw invalidTransition("طلب الصيانة ليس بانتظار الاعتماد");
  if (quote.validUntil && quote.validUntil < today()) throw badRequest("انتهت صلاحية العرض؛ لا يمكن اعتماده");
  const q = await db.transaction(async (tx) => {
    const u = await setQuoteStatus(tx, quote, ["SUBMITTED", "UNDER_REVIEW"], "APPROVED", { reviewedBy: access.userId, reviewedAt: new Date() });
    // Other open quotes of the same request are closed automatically.
    const others = await tx
      .update(maintenanceQuotes)
      .set({ status: "REJECTED", reviewedBy: access.userId, reviewedAt: new Date(), reviewReason: "تم اعتماد عرض آخر", updatedAt: new Date() })
      .where(and(eq(maintenanceQuotes.maintenanceRequestId, mr.id), ne(maintenanceQuotes.id, id), inArray(maintenanceQuotes.status, ["DRAFT", "SUBMITTED", "UNDER_REVIEW"])))
      .returning({ id: maintenanceQuotes.id });
    await recordEvent(tx, req, mr, { type: "QUOTE_APPROVED", audit: "QUOTE_APPROVED", entity: "maintenance_quote", entityId: id, metadata: { quoteId: id, amount: u.amount, autoRejected: others.map((o) => o.id) } });
    const recipients = [mr.assignedTo, quote.createdBy, ...(await projectManagersOf(tx, mr))];
    await notifyMaintenance(tx, access.userId, mr, recipients, "MAINTENANCE_QUOTE_APPROVED", `تم اعتماد عرض السعر لطلب الصيانة ${mrLabel(mr)} — بانتظار اعتماد التنفيذ`);
    return u;
  });
  res.json({ data: q });
});

quotesRouter.post("/maintenance-quotes/:id/reject", requirePermission("maintenance.quote.reject"), async (req, res) => {
  const { access } = ctx(req);
  const { id } = idParam.parse(req.params);
  const { reason } = Reason.parse(req.body ?? {});
  const { quote, mr } = await loadQuote(access, id, "maintenance.quote.reject");
  if (!["SUBMITTED", "UNDER_REVIEW"].includes(quote.status)) throw invalidTransition("لا يمكن رفض هذا العرض في حالته الحالية");
  const q = await db.transaction(async (tx) => {
    const u = await setQuoteStatus(tx, quote, ["SUBMITTED", "UNDER_REVIEW"], "REJECTED", { reviewedBy: access.userId, reviewedAt: new Date(), reviewReason: reason });
    await recordEvent(tx, req, mr, { type: "QUOTE_REJECTED", audit: "QUOTE_REJECTED", entity: "maintenance_quote", entityId: id, reason, metadata: { quoteId: id } });
    const [fresh] = await tx.select().from(maintenanceRequests).where(eq(maintenanceRequests.id, mr.id));
    const open = await tx
      .select({ id: maintenanceQuotes.id })
      .from(maintenanceQuotes)
      .where(and(eq(maintenanceQuotes.maintenanceRequestId, mr.id), inArray(maintenanceQuotes.status, ["SUBMITTED", "UNDER_REVIEW", "APPROVED"])));
    if (fresh!.status === "PENDING_APPROVAL" && open.length === 0) {
      // System transition: no quote left to decide on → back to collecting quotes.
      await changeStatus(tx, fresh!, "QUOTE_PENDING");
      await recordEvent(tx, req, fresh!, { type: "STATUS_CHANGED", audit: "MAINTENANCE_STATUS_CHANGED", from: "PENDING_APPROVAL", to: "QUOTE_PENDING", metadata: { trigger: "all_quotes_rejected", quoteId: id } });
    }
    await notifyMaintenance(tx, access.userId, mr, [mr.assignedTo, quote.createdBy], "MAINTENANCE_QUOTE_REJECTED", `تم رفض عرض السعر لطلب الصيانة ${mrLabel(mr)}: ${reason}`);
    return u;
  });
  res.json({ data: q });
});

const rawUpload = express.raw({ type: () => true, limit: MAX_UPLOAD_BYTES });

quotesRouter.put("/maintenance-quotes/:id/file", requirePermission("maintenance.quote.create"), rawUpload, async (req, res) => {
  const { access } = ctx(req);
  const { id } = idParam.parse(req.params);
  const { quote, mr } = await loadQuote(access, id, "maintenance.quote.create");
  if (!["DRAFT", "SUBMITTED"].includes(quote.status)) throw invalidTransition("لا يمكن تغيير مرفق عرض تمت مراجعته");
  const f = await db.transaction(async (tx) => {
    const file = await storeUpload(tx, req, access.orgId, access.userId);
    await tx.update(maintenanceQuotes).set({ attachmentFileId: file.id, updatedAt: new Date() }).where(eq(maintenanceQuotes.id, id));
    await recordEvent(tx, req, mr, { type: "ATTACHMENT_ADDED", audit: "FILE_UPLOADED", entity: "maintenance_quote", entityId: id, metadata: { quoteId: id, fileName: file.originalName } });
    return file;
  });
  res.status(201).json({ data: { fileName: f.originalName, fileSize: f.sizeBytes, fileMime: f.mimeType } });
});

quotesRouter.get("/maintenance-quotes/:id/file", requirePermission("maintenance.quote.read"), async (req, res) => {
  const { access } = ctx(req);
  const { id } = idParam.parse(req.params);
  const { quote, mr } = await loadQuote(access, id, "maintenance.quote.read", "read");
  await audit(db, req, { action: "FILE_DOWNLOADED", entity: "maintenance_quote", entityId: id, projectId: mr.projectId, metadata: { maintenanceId: mr.id } });
  await sendStoredFile(db, res, quote.attachmentFileId);
});

