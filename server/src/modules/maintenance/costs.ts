import { and, eq, sql } from "drizzle-orm";
import { Router } from "express";
import { z } from "zod";
import { canOnMaintenance, type Access } from "../../auth/access.js";
import type { PermissionKey } from "../../auth/permissions.js";
import { db } from "../../db/client.js";
import { maintenanceLabor, maintenanceParts, vendors } from "../../db/schema/index.js";
import { ctx } from "../../http/context.js";
import { badRequest, forbidden, notFound } from "../../http/errors.js";
import { requirePermission } from "../../http/middleware.js";
import { idParam, money, optionalText, trimmed, uuid } from "../../http/validate.js";
import { invalidTransition, loadRequest, recordEvent, type MR } from "./service.js";
import { COST_EDITABLE, type MaintenanceStatus } from "./workflow.js";

/**
 * Parts & labor. Totals are ALWAYS computed by the database as
 * round(quantity × unit_price, 2) / round(hours × hourly_rate, 2) — a client
 * `total` field is rejected (strict schema) and a CHECK constraint guards the column.
 */
export const costsRouter = Router();

const decimal = (max: number, message: string) =>
  z
    .union([z.string(), z.number()])
    .transform((v) => String(v).trim())
    .refine((s) => /^\d{1,8}(\.\d{1,2})?$/.test(s) && Number(s) > 0 && Number(s) <= max, message);

const PartBody = z
  .object({
    partName: trimmed(2, 150),
    partNumber: optionalText(60),
    quantity: decimal(100_000, "الكمية يجب أن تكون أكبر من صفر"),
    unitPrice: money,
    vendorId: uuid.nullable().optional(),
    notes: optionalText(1000),
  })
  .strict();

const LaborBody = z
  .object({
    description: trimmed(2, 300),
    hours: decimal(1_000, "عدد الساعات يجب أن يكون أكبر من صفر (بحد أقصى 1000)"),
    hourlyRate: money,
  })
  .strict();

async function assertVendor(orgId: string, vendorId: string | null | undefined) {
  if (!vendorId) return;
  const [v] = await db.select({ id: vendors.id }).from(vendors).where(and(eq(vendors.id, vendorId), eq(vendors.organizationId, orgId)));
  if (!v) throw badRequest("المورد غير موجود");
}

function assertEditable(mr: MR) {
  if (!COST_EDITABLE.includes(mr.status as MaintenanceStatus)) throw invalidTransition("لا يمكن تعديل القطع أو العمالة في حالة الطلب الحالية");
}

/** Loads a child row and re-authorizes through its request (404 outside scope, 403 without the action). */
async function loadChild<T extends { maintenanceRequestId: string; organizationId: string }>(a: Access, row: T | undefined, perm: PermissionKey, label: string) {
  if (!row || row.organizationId !== a.orgId) throw notFound(`${label} غير موجود`);
  const { mr, assigned } = await loadRequest(a, row.maintenanceRequestId, "maintenance.read", "read").catch((e) => {
    if (e?.status === 404) throw notFound(`${label} غير موجود`);
    throw e;
  });
  if (!canOnMaintenance(a, perm, mr, assigned, "act")) throw forbidden();
  return mr;
}

// ------------------------------------------------------------------ parts

costsRouter.get("/maintenance/:id/parts", requirePermission("maintenance.parts.read"), async (req, res) => {
  const { access } = ctx(req);
  const { id } = idParam.parse(req.params);
  await loadRequest(access, id, "maintenance.parts.read", "read");
  res.json({ data: await db.select().from(maintenanceParts).where(eq(maintenanceParts.maintenanceRequestId, id)) });
});

costsRouter.post("/maintenance/:id/parts", requirePermission("maintenance.parts.manage"), async (req, res) => {
  const { access } = ctx(req);
  const { id } = idParam.parse(req.params);
  const { mr } = await loadRequest(access, id, "maintenance.parts.manage");
  assertEditable(mr);
  const b = PartBody.parse(req.body);
  await assertVendor(access.orgId, b.vendorId);
  const part = await db.transaction(async (tx) => {
    const [p] = await tx
      .insert(maintenanceParts)
      .values({
        organizationId: access.orgId,
        maintenanceRequestId: mr.id,
        partName: b.partName,
        partNumber: b.partNumber ?? null,
        quantity: b.quantity,
        unitPrice: b.unitPrice,
        total: sql`round(${b.quantity}::numeric * ${b.unitPrice}::numeric, 2)`,
        vendorId: b.vendorId ?? null,
        notes: b.notes ?? null,
        createdBy: access.userId,
      })
      .returning();
    await recordEvent(tx, req, mr, { type: "PART_ADDED", audit: "PART_ADDED", entity: "maintenance_part", entityId: p!.id, metadata: { partName: p!.partName, quantity: p!.quantity, unitPrice: p!.unitPrice, total: p!.total } });
    return p!;
  });
  res.status(201).json({ data: part });
});

costsRouter.patch("/maintenance-parts/:id", requirePermission("maintenance.parts.manage"), async (req, res) => {
  const { access } = ctx(req);
  const { id } = idParam.parse(req.params);
  const [row] = await db.select().from(maintenanceParts).where(eq(maintenanceParts.id, id));
  const mr = await loadChild(access, row, "maintenance.parts.manage", "القطعة");
  assertEditable(mr);
  const b = PartBody.partial().parse(req.body);
  await assertVendor(access.orgId, b.vendorId);
  const q = b.quantity ?? row!.quantity;
  const p = b.unitPrice ?? row!.unitPrice;
  const part = await db.transaction(async (tx) => {
    const [u] = await tx
      .update(maintenanceParts)
      .set({ ...b, quantity: q, unitPrice: p, total: sql`round(${q}::numeric * ${p}::numeric, 2)`, updatedAt: new Date() })
      .where(eq(maintenanceParts.id, id))
      .returning();
    await recordEvent(tx, req, mr, { type: "PART_UPDATED", audit: "PART_UPDATED", entity: "maintenance_part", entityId: id, metadata: { partName: u!.partName, total: u!.total } });
    return u!;
  });
  res.json({ data: part });
});

costsRouter.delete("/maintenance-parts/:id", requirePermission("maintenance.parts.manage"), async (req, res) => {
  const { access } = ctx(req);
  const { id } = idParam.parse(req.params);
  const [row] = await db.select().from(maintenanceParts).where(eq(maintenanceParts.id, id));
  const mr = await loadChild(access, row, "maintenance.parts.manage", "القطعة");
  assertEditable(mr);
  await db.transaction(async (tx) => {
    await tx.delete(maintenanceParts).where(eq(maintenanceParts.id, id));
    await recordEvent(tx, req, mr, { type: "PART_REMOVED", audit: "PART_REMOVED", entity: "maintenance_part", entityId: id, metadata: { partName: row!.partName, total: row!.total } });
  });
  res.status(204).end();
});

// ------------------------------------------------------------------ labor

costsRouter.get("/maintenance/:id/labor", requirePermission("maintenance.labor.read"), async (req, res) => {
  const { access } = ctx(req);
  const { id } = idParam.parse(req.params);
  await loadRequest(access, id, "maintenance.labor.read", "read");
  res.json({ data: await db.select().from(maintenanceLabor).where(eq(maintenanceLabor.maintenanceRequestId, id)) });
});

costsRouter.post("/maintenance/:id/labor", requirePermission("maintenance.labor.manage"), async (req, res) => {
  const { access } = ctx(req);
  const { id } = idParam.parse(req.params);
  const { mr } = await loadRequest(access, id, "maintenance.labor.manage");
  assertEditable(mr);
  const b = LaborBody.parse(req.body);
  const labor = await db.transaction(async (tx) => {
    const [l] = await tx
      .insert(maintenanceLabor)
      .values({ organizationId: access.orgId, maintenanceRequestId: mr.id, description: b.description, hours: b.hours, hourlyRate: b.hourlyRate, total: sql`round(${b.hours}::numeric * ${b.hourlyRate}::numeric, 2)`, createdBy: access.userId })
      .returning();
    await recordEvent(tx, req, mr, { type: "LABOR_ADDED", audit: "LABOR_ADDED", entity: "maintenance_labor", entityId: l!.id, metadata: { description: l!.description, hours: l!.hours, hourlyRate: l!.hourlyRate, total: l!.total } });
    return l!;
  });
  res.status(201).json({ data: labor });
});

costsRouter.patch("/maintenance-labor/:id", requirePermission("maintenance.labor.manage"), async (req, res) => {
  const { access } = ctx(req);
  const { id } = idParam.parse(req.params);
  const [row] = await db.select().from(maintenanceLabor).where(eq(maintenanceLabor.id, id));
  const mr = await loadChild(access, row, "maintenance.labor.manage", "بند العمالة");
  assertEditable(mr);
  const b = LaborBody.partial().parse(req.body);
  const h = b.hours ?? row!.hours;
  const r = b.hourlyRate ?? row!.hourlyRate;
  const labor = await db.transaction(async (tx) => {
    const [u] = await tx
      .update(maintenanceLabor)
      .set({ ...b, hours: h, hourlyRate: r, total: sql`round(${h}::numeric * ${r}::numeric, 2)`, updatedAt: new Date() })
      .where(eq(maintenanceLabor.id, id))
      .returning();
    await recordEvent(tx, req, mr, { type: "LABOR_UPDATED", audit: "LABOR_UPDATED", entity: "maintenance_labor", entityId: id, metadata: { total: u!.total } });
    return u!;
  });
  res.json({ data: labor });
});

costsRouter.delete("/maintenance-labor/:id", requirePermission("maintenance.labor.manage"), async (req, res) => {
  const { access } = ctx(req);
  const { id } = idParam.parse(req.params);
  const [row] = await db.select().from(maintenanceLabor).where(eq(maintenanceLabor.id, id));
  const mr = await loadChild(access, row, "maintenance.labor.manage", "بند العمالة");
  assertEditable(mr);
  await db.transaction(async (tx) => {
    await tx.delete(maintenanceLabor).where(eq(maintenanceLabor.id, id));
    await recordEvent(tx, req, mr, { type: "LABOR_REMOVED", audit: "LABOR_REMOVED", entity: "maintenance_labor", entityId: id, metadata: { description: row!.description, total: row!.total } });
  });
  res.status(204).end();
});
