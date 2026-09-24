import { and, asc, eq, ilike } from "drizzle-orm";
import { Router, type NextFunction, type Request, type Response } from "express";
import { z } from "zod";
import type { PermissionKey } from "../../auth/permissions.js";
import { db } from "../../db/client.js";
import { vendors } from "../../db/schema/index.js";
import { ctx } from "../../http/context.js";
import { forbidden } from "../../http/errors.js";
import { optionalText, trimmed } from "../../http/validate.js";
import { audit } from "../../services/audit.js";

/** Minimal vendor directory used by maintenance quotes and parts (org-wide). */
export const vendorsRouter = Router();

const anyOf = (...perms: PermissionKey[]) => (req: Request, _res: Response, next: NextFunction) =>
  req.access && perms.some((p) => req.access!.has(p)) ? next() : next(forbidden());

vendorsRouter.get("/", anyOf("maintenance.quote.read", "maintenance.parts.read"), async (req, res) => {
  const { access } = ctx(req);
  const { q } = z.object({ q: z.string().trim().max(100).optional() }).parse(req.query);
  const rows = await db
    .select({ id: vendors.id, name: vendors.name, phone: vendors.phone, status: vendors.status })
    .from(vendors)
    .where(and(eq(vendors.organizationId, access.orgId), eq(vendors.status, "ACTIVE"), q ? ilike(vendors.name, `%${q}%`) : undefined))
    .orderBy(asc(vendors.name))
    .limit(200);
  res.json({ data: rows });
});

const VendorBody = z
  .object({
    name: trimmed(2, 150),
    phone: z.string().trim().regex(/^\+?[0-9 ]{7,20}$/, "رقم جوال غير صالح").nullable().optional().or(z.literal("").transform(() => null)),
    email: z.string().trim().toLowerCase().email().max(254).nullable().optional().or(z.literal("").transform(() => null)),
    notes: optionalText(1000),
  })
  .strict();

vendorsRouter.post("/", anyOf("maintenance.quote.create", "maintenance.parts.manage"), async (req, res) => {
  const { access } = ctx(req);
  // Vendors are shared across projects: creating one requires a project-level (or wider) scope.
  const wide = (p: PermissionKey) => ["PROJECT", "ALL"].includes(access.scopeOf(p) ?? "");
  if (!wide("maintenance.quote.create") && !wide("maintenance.parts.manage")) throw forbidden("إضافة الموردين تتطلب صلاحية على مستوى المشروع");
  const b = VendorBody.parse(req.body);
  const created = await db.transaction(async (tx) => {
    const [v] = await tx.insert(vendors).values({ organizationId: access.orgId, name: b.name, phone: b.phone ?? null, email: b.email ?? null, notes: b.notes ?? null, createdBy: access.userId }).returning();
    await audit(tx, req, { action: "VENDOR_CREATED", entity: "vendor", entityId: v!.id, metadata: { name: v!.name } });
    return v!;
  });
  res.status(201).json({ data: created });
});
