import { and, desc, eq, sql, type SQL } from "drizzle-orm";
import express, { Router } from "express";
import { z } from "zod";
import { assertCanUseProject, canOnRecord, permissionHolders, recordScope, type Access } from "../../auth/access.js";
import { db } from "../../db/client.js";
import { expenseCategory, expenses, expenseStatus, projects, users, vehicles, vendors } from "../../db/schema/index.js";
import { ctx } from "../../http/context.js";
import { badRequest, forbidden, HttpError, notFound } from "../../http/errors.js";
import { requirePermission } from "../../http/middleware.js";
import { idParam, isoDate, money, optionalText, paged, pagination, uuid } from "../../http/validate.js";
import { today } from "../../lib/clock.js";
import { uploadRateLimit } from "../../lib/pg-rate-limit.js";
import { audit } from "../../services/audit.js";
import { notifyUsers } from "../../services/notifications.js";
import { MAX_UPLOAD_BYTES, sendStoredFile, storeUpload } from "../../services/storage.js";

export const expensesRouter = Router();

/** Manual expenses: ALL / PROJECT (member) / ASSIGNED (own records only). */
export function expenseScope(a: Access, perm: Parameters<Access["require"]>[0] = "finance.read"): SQL {
  return recordScope(a, perm, { orgCol: expenses.organizationId, projectCol: expenses.projectId, assigned: sql`${expenses.createdBy} = ${a.userId}` });
}

async function load(a: Access, id: string) {
  const [e] = await db.select().from(expenses).where(and(eq(expenses.id, id), expenseScope(a))).limit(1);
  if (!e) throw notFound("المصروف غير موجود");
  return e;
}

const columns = {
  id: expenses.id,
  projectId: expenses.projectId,
  projectName: projects.name,
  vehicleId: expenses.vehicleId,
  plateNumber: vehicles.plateNumber,
  category: expenses.category,
  amount: expenses.amount,
  expenseDate: expenses.expenseDate,
  vendorId: expenses.vendorId,
  vendorName: vendors.name,
  invoiceId: expenses.invoiceId,
  description: expenses.description,
  status: expenses.status,
  hasReceipt: sql<boolean>`(${expenses.receiptFileId} is not null)`,
  createdBy: expenses.createdBy,
  createdByName: users.name,
  reviewReason: expenses.reviewReason,
  reviewedAt: expenses.reviewedAt,
  createdAt: expenses.createdAt,
};

const base = () =>
  db
    .select(columns)
    .from(expenses)
    .innerJoin(projects, eq(projects.id, expenses.projectId))
    .leftJoin(vehicles, eq(vehicles.id, expenses.vehicleId))
    .leftJoin(vendors, eq(vendors.id, expenses.vendorId))
    .innerJoin(users, eq(users.id, expenses.createdBy));

const ListQuery = pagination.extend({
  status: z.enum(expenseStatus.enumValues).optional(),
  category: z.enum(expenseCategory.enumValues).optional(),
  projectId: uuid.optional(),
  vehicleId: uuid.optional(),
  from: isoDate.optional(),
  to: isoDate.optional(),
});

expensesRouter.get("/expenses", requirePermission("finance.read"), async (req, res) => {
  const { access } = ctx(req);
  const q = ListQuery.parse(req.query);
  const where: SQL[] = [expenseScope(access)];
  if (q.status) where.push(eq(expenses.status, q.status));
  if (q.category) where.push(eq(expenses.category, q.category));
  if (q.projectId) where.push(eq(expenses.projectId, q.projectId));
  if (q.vehicleId) where.push(eq(expenses.vehicleId, q.vehicleId));
  if (q.from) where.push(sql`${expenses.expenseDate} >= ${q.from}::date`);
  if (q.to) where.push(sql`${expenses.expenseDate} <= ${q.to}::date`);
  const cond = and(...where);
  const [rows, [count]] = await Promise.all([
    base().where(cond).orderBy(desc(expenses.expenseDate), desc(expenses.createdAt)).limit(q.pageSize).offset((q.page - 1) * q.pageSize),
    db.select({ n: sql<number>`count(*)::int` }).from(expenses).where(cond),
  ]);
  res.json(paged(rows, count?.n ?? 0, q.page, q.pageSize));
});

const Body = z
  .object({
    projectId: uuid,
    vehicleId: uuid.nullable().optional(),
    category: z.enum(expenseCategory.enumValues),
    amount: money.refine((v) => Number(v) > 0, "المبلغ يجب أن يكون أكبر من صفر"),
    expenseDate: isoDate,
    vendorId: uuid.nullable().optional(),
    description: optionalText(2000),
  })
  .strict();

expensesRouter.post("/expenses", requirePermission("finance.create"), async (req, res) => {
  const { access } = ctx(req);
  const b = Body.parse(req.body);
  if (b.expenseDate > today()) throw badRequest("تاريخ المصروف لا يمكن أن يكون في المستقبل");
  await assertCanUseProject(db, access, b.projectId, "finance.create");
  if (b.vehicleId) {
    const [v] = await db.select({ projectId: vehicles.projectId }).from(vehicles).where(and(eq(vehicles.id, b.vehicleId), eq(vehicles.organizationId, access.orgId)));
    if (!v || v.projectId !== b.projectId) throw badRequest("المركبة لا تتبع هذا المشروع");
  }
  if (b.vendorId) {
    const [v] = await db.select({ id: vendors.id }).from(vendors).where(and(eq(vendors.id, b.vendorId), eq(vendors.organizationId, access.orgId)));
    if (!v) throw badRequest("المورد غير موجود");
  }
  const created = await db.transaction(async (tx) => {
    const [e] = await tx
      .insert(expenses)
      .values({ organizationId: access.orgId, projectId: b.projectId, vehicleId: b.vehicleId ?? null, category: b.category, amount: b.amount, expenseDate: b.expenseDate, vendorId: b.vendorId ?? null, description: b.description ?? null, createdBy: access.userId })
      .returning();
    await audit(tx, req, { action: "EXPENSE_CREATED", entity: "expense", entityId: e!.id, projectId: e!.projectId, vehicleId: e!.vehicleId, newValue: { status: "SUBMITTED", amount: e!.amount, category: e!.category } });
    const approvers = (await permissionHolders(tx, access.orgId, "finance.approve", e!.projectId, { includeAllScope: true })).filter((u) => u !== access.userId);
    await notifyUsers(tx, { orgId: access.orgId, userIds: approvers, type: "EXPENSE_SUBMITTED", title: `مصروف جديد بقيمة ${e!.amount} ريال بانتظار الاعتماد`, link: "/finance/expenses", entityType: "expense", entityId: e!.id, projectId: e!.projectId });
    return e!;
  });
  res.status(201).json({ data: created });
});

const rawUpload = express.raw({ type: () => true, limit: MAX_UPLOAD_BYTES });

expensesRouter.put("/expenses/:id/receipt", requirePermission("finance.create"), uploadRateLimit, rawUpload, async (req, res) => {
  const { access } = ctx(req);
  const { id } = idParam.parse(req.params);
  const e = await load(access, id);
  if (e.createdBy !== access.userId) throw forbidden("يمكن لصاحب المصروف فقط إرفاق الإيصال");
  if (e.status !== "SUBMITTED") throw new HttpError(409, "INVALID_TRANSITION", "لا يمكن تغيير الإيصال بعد المراجعة");
  const f = await db.transaction(async (tx) => {
    const file = await storeUpload(tx, req, access.orgId, access.userId);
    await tx.update(expenses).set({ receiptFileId: file.id, updatedAt: new Date() }).where(eq(expenses.id, id));
    await audit(tx, req, { action: "FILE_UPLOADED", entity: "expense", entityId: id, projectId: e.projectId, metadata: { fileName: file.originalName } });
    return file;
  });
  res.status(201).json({ data: { fileName: f.originalName } });
});

expensesRouter.get("/expenses/:id/receipt", requirePermission("finance.read"), async (req, res) => {
  const { access } = ctx(req);
  const { id } = idParam.parse(req.params);
  const e = await load(access, id);
  await audit(db, req, { action: "FILE_DOWNLOADED", entity: "expense", entityId: id, projectId: e.projectId });
  await sendStoredFile(db, res, e.receiptFileId);
});

const Reason = z.object({ reason: z.string().trim().min(3, "السبب مطلوب").max(1000) }).strict();

for (const decision of ["approve", "reject"] as const) {
  const perm = decision === "approve" ? "finance.approve" : "finance.reject";
  expensesRouter.post(`/expenses/:id/${decision}`, requirePermission(perm), async (req, res) => {
    const { access } = ctx(req);
    const { id } = idParam.parse(req.params);
    const e = await load(access, id);
    if (!canOnRecord(access, perm, e, false, "act")) throw forbidden();
    if (e.createdBy === access.userId) throw forbidden("لا يمكنك اعتماد أو رفض مصروف قمت بتسجيله");
    const reason = decision === "reject" ? Reason.parse(req.body ?? {}).reason : null;
    if (e.status !== "SUBMITTED") throw new HttpError(409, "INVALID_TRANSITION", "تمت مراجعة هذا المصروف مسبقًا");
    const to = decision === "approve" ? "APPROVED" : "REJECTED";
    const u = await db.transaction(async (tx) => {
      const [row] = await tx
        .update(expenses)
        .set({ status: to, reviewedBy: access.userId, reviewedAt: new Date(), reviewReason: reason, updatedAt: new Date() })
        .where(and(eq(expenses.id, id), eq(expenses.status, "SUBMITTED")))
        .returning();
      if (!row) throw new HttpError(409, "INVALID_TRANSITION", "تم تعديل المصروف من مستخدم آخر");
      await audit(tx, req, { action: decision === "approve" ? "EXPENSE_APPROVED" : "EXPENSE_REJECTED", entity: "expense", entityId: id, projectId: e.projectId, vehicleId: e.vehicleId, oldValue: { status: "SUBMITTED" }, newValue: { status: to }, metadata: { reason } });
      await notifyUsers(tx, { orgId: access.orgId, userIds: [e.createdBy], type: decision === "approve" ? "EXPENSE_APPROVED" : "EXPENSE_REJECTED", title: decision === "approve" ? `تم اعتماد المصروف بقيمة ${e.amount} ريال` : `تم رفض المصروف بقيمة ${e.amount} ريال: ${reason}`, link: "/finance/expenses", entityType: "expense", entityId: id, projectId: e.projectId });
      return row;
    });
    res.json({ data: u });
  });
}
