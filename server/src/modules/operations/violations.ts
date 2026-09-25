import { and, desc, eq, ilike, isNull, lte, or, sql, type SQL } from "drizzle-orm";
import { Router } from "express";
import { z } from "zod";
import { permissionHolders, type Access } from "../../auth/access.js";
import { db } from "../../db/client.js";
import { drivers, employees, projects, users, vehicleDriverHistory, vehicles, violations, violationStatus } from "../../db/schema/index.js";
import { ctx } from "../../http/context.js";
import { badRequest, conflict, HttpError, notFound } from "../../http/errors.js";
import { requirePermission } from "../../http/middleware.js";
import { idParam, isoDate, money, optionalText, paged, pagination, trimmed, uuid } from "../../http/validate.js";
import { today } from "../../lib/clock.js";
import { uploadRateLimit } from "../../lib/pg-rate-limit.js";
import { audit, diff } from "../../services/audit.js";
import { notifyUsers } from "../../services/notifications.js";
import { sendStoredFile, storeUpload } from "../../services/storage.js";
import { assertCanAct, driverNameSql, isVehicleRecordAssigned, rawUpload, recordTimeline, resolveDriver, vehicleForCreate, vehicleRecordScope } from "./common.js";

export const violationsRouter = Router();

type ViolationStatus = (typeof violationStatus.enumValues)[number];
type Violation = typeof violations.$inferSelect;

/** Allowed transitions. PAID and CANCELLED are terminal. */
export const VIOLATION_TRANSITIONS: Record<string, { from: ViolationStatus[]; to: ViolationStatus }> = {
  pay: { from: ["OPEN", "DISPUTED"], to: "PAID" },
  dispute: { from: ["OPEN"], to: "DISPUTED" },
  cancel: { from: ["OPEN", "DISPUTED"], to: "CANCELLED" },
  reopen: { from: ["DISPUTED"], to: "OPEN" },
};

export function violationScope(a: Access, perm: "violations.read" | "violations.update" = "violations.read"): SQL {
  return vehicleRecordScope(a, perm, violations, "VIOLATION");
}

const isAssigned = (a: Access, id: string) => isVehicleRecordAssigned(a, violations, id, "VIOLATION");

async function loadViolation(a: Access, id: string, perm: "violations.read" | "violations.update" = "violations.read") {
  const [row] = await db.select().from(violations).where(and(eq(violations.id, id), violationScope(a, perm))).limit(1);
  if (!row) throw notFound("المخالفة غير موجودة");
  return row;
}

const columns = {
  id: violations.id,
  vehicleId: violations.vehicleId,
  plateNumber: vehicles.plateNumber,
  projectId: violations.projectId,
  projectName: projects.name,
  driverId: violations.driverId,
  driverName: driverNameSql(violations.driverId),
  violationNumber: violations.violationNumber,
  violationDate: violations.violationDate,
  type: violations.type,
  amount: violations.amount,
  authority: violations.authority,
  status: violations.status,
  paymentDate: violations.paymentDate,
  disputeReason: violations.disputeReason,
  hasFile: sql<boolean>`(${violations.fileId} is not null)`,
  notes: violations.notes,
  createdAt: violations.createdAt,
};

const ListQuery = pagination.extend({
  q: z.string().trim().max(100).optional(),
  status: z.enum(violationStatus.enumValues).optional(),
  projectId: uuid.optional(),
  vehicleId: uuid.optional(),
  driverId: uuid.optional(),
  from: isoDate.optional(),
  to: isoDate.optional(),
});

violationsRouter.get("/violations", requirePermission("violations.read"), async (req, res) => {
  const { access } = ctx(req);
  const q = ListQuery.parse(req.query);
  const where: SQL[] = [violationScope(access)];
  if (q.status) where.push(eq(violations.status, q.status));
  if (q.projectId) where.push(eq(violations.projectId, q.projectId));
  if (q.vehicleId) where.push(eq(violations.vehicleId, q.vehicleId));
  if (q.driverId) where.push(eq(violations.driverId, q.driverId));
  if (q.from) where.push(sql`${violations.violationDate} >= ${q.from}::date`);
  if (q.to) where.push(sql`${violations.violationDate} <= ${q.to}::date`);
  if (q.q) {
    const like = `%${q.q.replace(/[%_\\]/g, "\\$&")}%`;
    where.push(or(ilike(vehicles.plateNumber, like), ilike(violations.violationNumber, like), ilike(violations.type, like))!);
  }
  const cond = and(...where);
  const [rows, [agg]] = await Promise.all([
    db.select(columns).from(violations).innerJoin(vehicles, eq(vehicles.id, violations.vehicleId)).leftJoin(projects, eq(projects.id, violations.projectId)).where(cond).orderBy(desc(violations.violationDate), desc(violations.createdAt)).limit(q.pageSize).offset((q.page - 1) * q.pageSize),
    db
      .select({
        n: sql<number>`count(*)::int`,
        openAmount: sql<string>`coalesce(sum(${violations.amount}) filter (where ${violations.status} in ('OPEN','DISPUTED')), 0)::numeric(14,2)`,
        paidAmount: sql<string>`coalesce(sum(${violations.amount}) filter (where ${violations.status} = 'PAID'), 0)::numeric(14,2)`,
      })
      .from(violations)
      .innerJoin(vehicles, eq(vehicles.id, violations.vehicleId))
      .where(cond),
  ]);
  res.json({ ...paged(rows, agg?.n ?? 0, q.page, q.pageSize), summary: { openAmount: agg?.openAmount ?? "0.00", paidAmount: agg?.paidAmount ?? "0.00" } });
});

function actionsFor(a: Access, v: Violation, assigned: boolean): string[] {
  const s = a.scopeOf("violations.update");
  const can = s === "ALL" || (s === "PROJECT" && a.isMemberOf(v.projectId)) || (s === "ASSIGNED" && assigned);
  if (!can) return [];
  const out = Object.entries(VIOLATION_TRANSITIONS)
    .filter(([, t]) => t.from.includes(v.status))
    .map(([k]) => k);
  if (v.status === "OPEN" || v.status === "DISPUTED") out.push("edit", "attach");
  return out;
}

violationsRouter.get("/violations/:id", requirePermission("violations.read"), async (req, res) => {
  const { access } = ctx(req);
  const { id } = idParam.parse(req.params);
  const v = await loadViolation(access, id);
  const [[row], timeline, assigned] = await Promise.all([
    db.select({ ...columns, createdByName: users.name }).from(violations).innerJoin(vehicles, eq(vehicles.id, violations.vehicleId)).leftJoin(projects, eq(projects.id, violations.projectId)).innerJoin(users, eq(users.id, violations.createdBy)).where(eq(violations.id, id)),
    recordTimeline(access.orgId, "violation", id),
    isAssigned(access, id),
  ]);
  res.json({ data: { ...row, timeline, actions: actionsFor(access, v, assigned) } });
});

const CreateBody = z
  .object({
    vehicleId: uuid,
    driverId: uuid.nullable().optional(),
    violationNumber: optionalText(100),
    violationDate: isoDate,
    type: trimmed(2, 200),
    amount: money,
    authority: optionalText(200),
    notes: optionalText(2000),
  })
  .strict();

/** Driver who held the vehicle on `date` (from assignment history), if any. */
async function driverOnDate(vehicleId: string, date: string): Promise<string | null> {
  const [h] = await db
    .select({ driverId: vehicleDriverHistory.driverId })
    .from(vehicleDriverHistory)
    .where(and(eq(vehicleDriverHistory.vehicleId, vehicleId), lte(sql`${vehicleDriverHistory.assignedAt}::date`, sql`${date}::date`), or(isNull(vehicleDriverHistory.unassignedAt), sql`${vehicleDriverHistory.unassignedAt}::date >= ${date}::date`)))
    .orderBy(desc(vehicleDriverHistory.assignedAt))
    .limit(1);
  return h?.driverId ?? null;
}

async function driverUser(driverId: string | null) {
  if (!driverId) return null;
  const [d] = await db.select({ userId: employees.userId }).from(drivers).innerJoin(employees, eq(employees.id, drivers.employeeId)).where(eq(drivers.id, driverId));
  return d?.userId ?? null;
}

violationsRouter.post("/violations", requirePermission("violations.create"), async (req, res) => {
  const { access } = ctx(req);
  const b = CreateBody.parse(req.body);
  if (b.violationDate > today()) throw badRequest("تاريخ المخالفة لا يمكن أن يكون في المستقبل");
  const created = await db
    .transaction(async (tx) => {
      const v = await vehicleForCreate(tx, access, b.vehicleId, "violations.create");
      const driverId = b.driverId === undefined ? ((await driverOnDate(v.id, b.violationDate)) ?? v.assignedDriverId) : await resolveDriver(tx, access, "violations.create", v, b.driverId);
      const [row] = await tx
        .insert(violations)
        .values({ organizationId: access.orgId, vehicleId: v.id, projectId: v.projectId, driverId, violationNumber: b.violationNumber ?? null, violationDate: b.violationDate, type: b.type, amount: b.amount, authority: b.authority ?? null, notes: b.notes ?? null, createdBy: access.userId })
        .returning();
      await audit(tx, req, { action: "VIOLATION_CREATED", entity: "violation", entityId: row!.id, projectId: v.projectId, vehicleId: v.id, metadata: { amount: row!.amount, type: row!.type }, newValue: { status: "OPEN", amount: row!.amount } });
      const title = `مخالفة مرورية جديدة على المركبة ${v.plateNumber} بقيمة ${row!.amount} ريال`;
      const managers = (await permissionHolders(tx, access.orgId, "violations.update", v.projectId, { includeAllScope: false })).filter((u) => u !== access.userId);
      await notifyUsers(tx, { orgId: access.orgId, userIds: managers, type: "VIOLATION_RECORDED", title, link: `/violations/${row!.id}`, entityType: "violation", entityId: row!.id, projectId: v.projectId });
      // The driver is told about their own violation (a record they can read) even without project membership.
      const du = await driverUser(driverId);
      if (du && du !== access.userId) await notifyUsers(tx, { orgId: access.orgId, userIds: [du], type: "VIOLATION_RECORDED", title, link: `/violations/${row!.id}`, entityType: "violation", entityId: row!.id });
      return row!;
    })
    .catch((e: unknown) => {
      if ((e as { code?: string }).code === "23505") throw conflict("رقم المخالفة مسجل مسبقًا");
      throw e;
    });
  res.status(201).json({ data: created });
});

const PatchBody = z
  .object({
    violationNumber: optionalText(100),
    violationDate: isoDate.optional(),
    type: trimmed(2, 200).optional(),
    amount: money.optional(),
    authority: optionalText(200),
    notes: optionalText(2000),
    driverId: uuid.nullable().optional(),
  })
  .strict();

violationsRouter.patch("/violations/:id", requirePermission("violations.update"), async (req, res) => {
  const { access } = ctx(req);
  const { id } = idParam.parse(req.params);
  const v = await loadViolation(access, id, "violations.update");
  assertCanAct(access, "violations.update", v, await isAssigned(access, id));
  if (v.status !== "OPEN" && v.status !== "DISPUTED") throw new HttpError(409, "INVALID_TRANSITION", "لا يمكن تعديل مخالفة مدفوعة أو ملغاة");
  const b = PatchBody.parse(req.body);
  if (b.violationDate && b.violationDate > today()) throw badRequest("تاريخ المخالفة لا يمكن أن يكون في المستقبل");
  const patch: Partial<Violation> = {};
  for (const k of ["violationNumber", "violationDate", "type", "amount", "authority", "notes"] as const) {
    if (b[k] !== undefined) (patch as Record<string, unknown>)[k] = b[k];
  }
  if (b.driverId !== undefined) {
    const [veh] = await db.select().from(vehicles).where(eq(vehicles.id, v.vehicleId));
    patch.driverId = await resolveDriver(db, access, "violations.update", veh!, b.driverId);
  }
  const changes = diff(v as unknown as Record<string, unknown>, patch as Record<string, unknown>);
  if (!Object.keys(changes).length) throw badRequest("لا يوجد تغيير");
  const updated = await db
    .transaction(async (tx) => {
      const [u] = await tx.update(violations).set({ ...patch, updatedAt: new Date() }).where(and(eq(violations.id, id), eq(violations.status, v.status))).returning();
      if (!u) throw new HttpError(409, "INVALID_TRANSITION", "تم تعديل المخالفة من مستخدم آخر");
      await audit(tx, req, { action: "VIOLATION_UPDATED", entity: "violation", entityId: id, projectId: v.projectId, vehicleId: v.vehicleId, metadata: { changes } });
      return u;
    })
    .catch((e: unknown) => {
      if ((e as { code?: string }).code === "23505") throw conflict("رقم المخالفة مسجل مسبقًا");
      throw e;
    });
  res.json({ data: updated });
});

const ActionBodies = {
  pay: z.object({ paymentDate: isoDate, notes: optionalText(1000) }).strict(),
  dispute: z.object({ reason: trimmed(3, 1000) }).strict(),
  cancel: z.object({ reason: trimmed(3, 1000) }).strict(),
  reopen: z.object({ notes: optionalText(1000) }).strict(),
} as const;

for (const action of Object.keys(VIOLATION_TRANSITIONS) as (keyof typeof ActionBodies)[]) {
  violationsRouter.post(`/violations/:id/${action}`, requirePermission("violations.update"), async (req, res) => {
    const { access } = ctx(req);
    const { id } = idParam.parse(req.params);
    const v = await loadViolation(access, id, "violations.update");
    assertCanAct(access, "violations.update", v, await isAssigned(access, id));
    const t = VIOLATION_TRANSITIONS[action]!;
    if (!t.from.includes(v.status)) throw new HttpError(409, "INVALID_TRANSITION", "هذا الإجراء غير مسموح في حالة المخالفة الحالية");
    const body = ActionBodies[action].parse(req.body ?? {}) as { paymentDate?: string; reason?: string; notes?: string | null };
    if (body.paymentDate && body.paymentDate > today()) throw badRequest("تاريخ السداد لا يمكن أن يكون في المستقبل");
    if (body.paymentDate && body.paymentDate < v.violationDate) throw badRequest("تاريخ السداد قبل تاريخ المخالفة");
    const set: Partial<Violation> = { status: t.to, updatedAt: new Date() };
    if (action === "pay") set.paymentDate = body.paymentDate!;
    if (action === "dispute") set.disputeReason = body.reason!;
    if (action === "cancel") set.notes = [v.notes, `سبب الإلغاء: ${body.reason}`].filter(Boolean).join("\n");
    const updated = await db.transaction(async (tx) => {
      const [u] = await tx.update(violations).set(set).where(and(eq(violations.id, id), eq(violations.status, v.status))).returning();
      if (!u) throw new HttpError(409, "INVALID_TRANSITION", "تم تعديل المخالفة من مستخدم آخر، أعد تحميل الصفحة");
      await audit(tx, req, { action: "VIOLATION_STATUS_CHANGED", entity: "violation", entityId: id, projectId: v.projectId, vehicleId: v.vehicleId, metadata: { action, fromStatus: v.status, toStatus: t.to, reason: body.reason, paymentDate: body.paymentDate } });
      const du = await driverUser(v.driverId);
      const title = "تغيرت حالة المخالفة على المركبة";
      if (v.createdBy !== access.userId) await notifyUsers(tx, { orgId: access.orgId, userIds: [v.createdBy], type: "VIOLATION_STATUS_CHANGED", title, link: `/violations/${id}`, entityType: "violation", entityId: id, projectId: v.projectId });
      if (du && du !== access.userId && du !== v.createdBy) await notifyUsers(tx, { orgId: access.orgId, userIds: [du], type: "VIOLATION_STATUS_CHANGED", title, link: `/violations/${id}`, entityType: "violation", entityId: id });
      return u;
    });
    res.json({ data: updated });
  });
}

violationsRouter.put("/violations/:id/file", requirePermission("violations.update"), uploadRateLimit, rawUpload, async (req, res) => {
  const { access } = ctx(req);
  const { id } = idParam.parse(req.params);
  const v = await loadViolation(access, id, "violations.update");
  assertCanAct(access, "violations.update", v, await isAssigned(access, id));
  const f = await db.transaction(async (tx) => {
    const file = await storeUpload(tx, req, access.orgId, access.userId);
    await tx.update(violations).set({ fileId: file.id, updatedAt: new Date() }).where(eq(violations.id, id));
    await audit(tx, req, { action: "FILE_UPLOADED", entity: "violation", entityId: id, projectId: v.projectId, vehicleId: v.vehicleId, metadata: { fileName: file.originalName } });
    return file;
  });
  res.status(201).json({ data: { fileName: f.originalName } });
});

violationsRouter.get("/violations/:id/file", requirePermission("violations.read"), async (req, res) => {
  const { access } = ctx(req);
  const { id } = idParam.parse(req.params);
  const v = await loadViolation(access, id);
  await audit(db, req, { action: "FILE_DOWNLOADED", entity: "violation", entityId: id, projectId: v.projectId, vehicleId: v.vehicleId, metadata: {} });
  await sendStoredFile(db, res, v.fileId);
});
