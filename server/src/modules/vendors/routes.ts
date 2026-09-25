import { and, asc, eq, ilike, or, sql } from "drizzle-orm";
import { Router, type NextFunction, type Request, type Response } from "express";
import { z } from "zod";
import type { PermissionKey } from "../../auth/permissions.js";
import { db } from "../../db/client.js";
import { vendors, vendorStatus } from "../../db/schema/index.js";
import { ctx } from "../../http/context.js";
import { badRequest, conflict, forbidden, notFound } from "../../http/errors.js";
import { idParam, optionalText, trimmed } from "../../http/validate.js";
import { audit, diff } from "../../services/audit.js";

/** Vendor directory (org-wide) used by maintenance quotes/parts, invoices and expenses. */
export const vendorsRouter = Router();

const anyOf = (...perms: PermissionKey[]) => (req: Request, _res: Response, next: NextFunction) =>
  req.access && perms.some((p) => req.access!.has(p)) ? next() : next(forbidden());

const READ_PERMS: PermissionKey[] = ["maintenance.quote.read", "maintenance.parts.read", "vendors.manage", "invoices.read", "finance.read"];

vendorsRouter.get("/", anyOf(...READ_PERMS), async (req, res) => {
  const { access } = ctx(req);
  const { q, status } = z.object({ q: z.string().trim().max(100).optional(), status: z.enum([...vendorStatus.enumValues, "ALL"]).default("ACTIVE") }).parse(req.query);
  const like = q ? `%${q.replace(/[%_\\]/g, "\\$&")}%` : null;
  // Inactive vendors are listed only for vendor managers.
  const showAll = status !== "ACTIVE" && access.has("vendors.manage");
  const rows = await db
    .select({ id: vendors.id, name: vendors.name, phone: vendors.phone, email: vendors.email, taxNumber: vendors.taxNumber, address: vendors.address, status: vendors.status, notes: vendors.notes })
    .from(vendors)
    .where(
      and(
        eq(vendors.organizationId, access.orgId),
        showAll ? (status === "ALL" ? undefined : eq(vendors.status, status)) : eq(vendors.status, "ACTIVE"),
        like ? or(ilike(vendors.name, like), ilike(vendors.taxNumber, like), ilike(vendors.phone, like)) : undefined,
      ),
    )
    .orderBy(asc(vendors.name))
    .limit(500);
  res.json({ data: rows });
});

const nullableText = (re: RegExp, msg: string, max: number) =>
  z.string().trim().max(max).regex(re, msg).nullable().optional().or(z.literal("").transform(() => null));

const VendorBody = z
  .object({
    name: trimmed(2, 150),
    phone: nullableText(/^\+?[0-9 ]{7,20}$/, "رقم جوال غير صالح", 20),
    email: z.string().trim().toLowerCase().email().max(254).nullable().optional().or(z.literal("").transform(() => null)),
    taxNumber: nullableText(/^[0-9]{10,20}$/, "الرقم الضريبي يجب أن يكون أرقامًا (10-20)", 20),
    address: optionalText(500),
    notes: optionalText(1000),
  })
  .strict();

/** Creating/editing shared vendors needs a project-level (or wider) scope. */
function assertCanManage(access: NonNullable<Request["access"]>) {
  const wide = (p: PermissionKey) => ["PROJECT", "ALL"].includes(access.scopeOf(p) ?? "");
  if (!wide("vendors.manage") && !wide("maintenance.quote.create") && !wide("maintenance.parts.manage")) throw forbidden("إدارة الموردين تتطلب صلاحية على مستوى المشروع");
}

const uniqueName = (e: unknown) => {
  if ((e as { code?: string }).code === "23505") throw conflict("يوجد مورد بنفس الاسم");
  throw e;
};

vendorsRouter.post("/", anyOf("vendors.manage", "maintenance.quote.create", "maintenance.parts.manage"), async (req, res) => {
  const { access } = ctx(req);
  assertCanManage(access);
  const b = VendorBody.parse(req.body);
  const created = await db
    .transaction(async (tx) => {
      const [v] = await tx
        .insert(vendors)
        .values({ organizationId: access.orgId, name: b.name, phone: b.phone ?? null, email: b.email ?? null, taxNumber: b.taxNumber ?? null, address: b.address ?? null, notes: b.notes ?? null, createdBy: access.userId })
        .returning();
      await audit(tx, req, { action: "VENDOR_CREATED", entity: "vendor", entityId: v!.id, metadata: { name: v!.name }, newValue: { name: v!.name, taxNumber: v!.taxNumber } });
      return v!;
    })
    .catch(uniqueName);
  res.status(201).json({ data: created });
});

vendorsRouter.get("/:id", anyOf(...READ_PERMS), async (req, res) => {
  const { access } = ctx(req);
  const { id } = idParam.parse(req.params);
  const [v] = await db.select().from(vendors).where(and(eq(vendors.id, id), eq(vendors.organizationId, access.orgId)));
  if (!v) throw notFound("المورد غير موجود");
  const [usage] = await db.execute<{ quotes: number; invoices: number; expenses: number }>(sql`
    select (select count(*)::int from maintenance_quotes where vendor_id = ${id}) as quotes,
           (select count(*)::int from invoices where vendor_id = ${id}) as invoices,
           (select count(*)::int from expenses where vendor_id = ${id}) as expenses`).then((r) => r.rows);
  res.json({ data: { ...v, usage } });
});

vendorsRouter.patch("/:id", anyOf("vendors.manage", "maintenance.quote.create", "maintenance.parts.manage"), async (req, res) => {
  const { access } = ctx(req);
  assertCanManage(access);
  const { id } = idParam.parse(req.params);
  const [before] = await db.select().from(vendors).where(and(eq(vendors.id, id), eq(vendors.organizationId, access.orgId)));
  if (!before) throw notFound("المورد غير موجود");
  const b = VendorBody.partial().extend({ status: z.enum(vendorStatus.enumValues).optional() }).strict().parse(req.body);
  const patch = Object.fromEntries(Object.entries(b).filter(([, v]) => v !== undefined));
  const changes = diff(before as unknown as Record<string, unknown>, patch);
  if (!Object.keys(changes).length) throw badRequest("لا يوجد تغيير");
  const updated = await db
    .transaction(async (tx) => {
      const [v] = await tx.update(vendors).set({ ...patch, updatedAt: new Date() }).where(eq(vendors.id, id)).returning();
      await audit(tx, req, { action: "VENDOR_UPDATED", entity: "vendor", entityId: id, metadata: { changes } });
      return v!;
    })
    .catch(uniqueName);
  res.json({ data: updated });
});
