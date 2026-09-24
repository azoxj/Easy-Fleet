import { and, desc, eq, isNull, sql } from "drizzle-orm";
import express, { Router, type Request, type Response } from "express";
import { z } from "zod";
import { vehicleScope, type Access } from "../../auth/access.js";
import type { PermissionKey } from "../../auth/permissions.js";
import { db, type DbOrTx } from "../../db/client.js";
import { coverageType, drivers, employees, files, insurancePolicies, users, vehicleDocuments, vehicles } from "../../db/schema/index.js";
import { ctx } from "../../http/context.js";
import { uploadRateLimit } from "../../lib/pg-rate-limit.js";
import { badRequest, forbidden, notFound } from "../../http/errors.js";
import { idParam, isoDate, money, optionalText, trimmed } from "../../http/validate.js";
import { audit, diff } from "../../services/audit.js";
import { daysUntil, expiryStatus } from "../../services/expiry.js";
import { ALLOWED_UPLOAD_MIME, MAX_UPLOAD_BYTES, sendStoredFile, storeUpload } from "../../services/storage.js";

export const documentsRouter = Router();

type DocKind = "registration" | "document";
const OTHER_TYPES = ["LICENSE", "WARRANTY", "OWNERSHIP", "OTHER"] as const;
const PERMS: Record<DocKind | "insurance", Record<"read" | "create" | "update" | "delete", PermissionKey>> = {
  registration: { read: "registration.read", create: "registration.create", update: "registration.update", delete: "vehicle_documents.delete" },
  document: { read: "vehicle_documents.read", create: "vehicle_documents.create", update: "vehicle_documents.update", delete: "vehicle_documents.delete" },
  insurance: { read: "insurance.read", create: "insurance.create", update: "insurance.update", delete: "vehicle_documents.delete" },
};
const kindOf = (type: string): DocKind => (type === "REGISTRATION" ? "registration" : "document");

/** Route-level guard: caller must hold at least one of the permissions (object-level checks follow). */
function requireAny(...perms: PermissionKey[]) {
  return (req: Request, _res: Response, next: (e?: unknown) => void) => {
    if (!req.access) return next(forbidden());
    if (!perms.some((p) => req.access!.has(p))) return next(forbidden());
    next();
  };
}

/** Loads the vehicle only if it is in scope for `perm` (404 otherwise, 403 when the permission is missing entirely). */
async function vehicleFor(a: Access, vehicleId: string, perm: PermissionKey) {
  const [v] = await db
    .select({ id: vehicles.id, plateNumber: vehicles.plateNumber, projectId: vehicles.projectId, status: vehicles.status, assignedDriverId: vehicles.assignedDriverId })
    .from(vehicles)
    .where(and(eq(vehicles.id, vehicleId), vehicleScope(a, perm)))
    .limit(1);
  if (!v) throw notFound("المركبة غير موجودة");
  return v;
}

async function vehicleInScope(a: Access, vehicleId: string, perm: PermissionKey): Promise<boolean> {
  if (!a.has(perm)) return false;
  const [v] = await db.select({ id: vehicles.id }).from(vehicles).where(and(eq(vehicles.id, vehicleId), vehicleScope(a, perm))).limit(1);
  return !!v;
}

/** Write access additionally excludes ASSIGNED-only scope. */
function assertWritable(a: Access, perm: PermissionKey) {
  if (a.require(perm) === "ASSIGNED") throw forbidden();
}

function withStatus<T extends { expiryDate: string | null }>(row: T) {
  return {
    ...row,
    status: expiryStatus(row.expiryDate),
    daysLeft: row.expiryDate ? daysUntil(row.expiryDate) : null,
  };
}

const docColumns = {
  id: vehicleDocuments.id,
  vehicleId: vehicleDocuments.vehicleId,
  documentType: vehicleDocuments.documentType,
  documentNumber: vehicleDocuments.documentNumber,
  issueDate: vehicleDocuments.issueDate,
  expiryDate: vehicleDocuments.expiryDate,
  issuer: vehicleDocuments.issuer,
  notes: vehicleDocuments.notes,
  isCurrent: sql<boolean>`(${vehicleDocuments.supersededAt} is null)`,
  supersededAt: vehicleDocuments.supersededAt,
  fileName: files.originalName,
  fileSize: files.sizeBytes,
  fileMime: files.mimeType,
  createdByName: users.name,
  createdAt: vehicleDocuments.createdAt,
  updatedAt: vehicleDocuments.updatedAt,
};

function docQuery() {
  return db
    .select(docColumns)
    .from(vehicleDocuments)
    .leftJoin(files, eq(files.id, vehicleDocuments.fileId))
    .leftJoin(users, eq(users.id, vehicleDocuments.createdBy));
}

const insColumns = {
  id: insurancePolicies.id,
  vehicleId: insurancePolicies.vehicleId,
  provider: insurancePolicies.provider,
  policyNumber: insurancePolicies.policyNumber,
  issueDate: insurancePolicies.issueDate,
  expiryDate: insurancePolicies.expiryDate,
  premiumAmount: insurancePolicies.premiumAmount,
  coverageType: insurancePolicies.coverageType,
  notes: insurancePolicies.notes,
  isCurrent: sql<boolean>`(${insurancePolicies.supersededAt} is null)`,
  supersededAt: insurancePolicies.supersededAt,
  fileName: files.originalName,
  fileSize: files.sizeBytes,
  fileMime: files.mimeType,
  createdByName: users.name,
  createdAt: insurancePolicies.createdAt,
  updatedAt: insurancePolicies.updatedAt,
};

function insQuery() {
  return db
    .select(insColumns)
    .from(insurancePolicies)
    .leftJoin(files, eq(files.id, insurancePolicies.fileId))
    .leftJoin(users, eq(users.id, insurancePolicies.createdBy));
}

function checkDates(issue?: string | null, expiry?: string | null) {
  if (issue && expiry && expiry < issue) throw badRequest("تاريخ الانتهاء يجب أن يكون بعد تاريخ الإصدار");
}

// ======================================================================= generic documents

documentsRouter.get("/vehicles/:id/documents", requireAny("vehicle_documents.read", "registration.read"), async (req, res) => {
  const { access } = ctx(req);
  const { id } = idParam.parse(req.params);
  const canDocs = await vehicleInScope(access, id, "vehicle_documents.read");
  const canReg = await vehicleInScope(access, id, "registration.read");
  if (!canDocs && !canReg) throw notFound("المركبة غير موجودة");
  const typeFilter = canDocs && canReg ? sql`true` : canDocs ? sql`${vehicleDocuments.documentType} <> 'REGISTRATION'` : sql`${vehicleDocuments.documentType} = 'REGISTRATION'`;
  const rows = await docQuery()
    .where(and(eq(vehicleDocuments.vehicleId, id), eq(vehicleDocuments.organizationId, access.orgId), isNull(vehicleDocuments.deletedAt), typeFilter))
    .orderBy(desc(vehicleDocuments.createdAt));
  res.json({ data: rows.map(withStatus) });
});

const DocBody = z.object({
  documentType: z.enum(OTHER_TYPES, { message: "نوع المستند غير صالح (الاستمارة والتأمين لهما صفحات مستقلة)" }),
  documentNumber: optionalText(60),
  issueDate: isoDate.nullable().optional(),
  expiryDate: isoDate.nullable().optional(),
  issuer: optionalText(120),
  notes: optionalText(2000),
});

documentsRouter.post("/vehicles/:id/documents", requireAny("vehicle_documents.create"), async (req, res) => {
  const { access } = ctx(req);
  const { id } = idParam.parse(req.params);
  assertWritable(access, "vehicle_documents.create");
  const v = await vehicleFor(access, id, "vehicle_documents.create");
  const body = DocBody.strict().parse(req.body);
  checkDates(body.issueDate, body.expiryDate);
  const created = await db.transaction(async (tx) => {
    const [d] = await tx
      .insert(vehicleDocuments)
      .values({ organizationId: access.orgId, vehicleId: v.id, ...body, createdBy: access.userId })
      .returning();
    await audit(tx, req, {
      action: "VEHICLE_DOCUMENT_ADDED",
      entity: "vehicle_document",
      entityId: d!.id,
      projectId: v.projectId,
      vehicleId: v.id,
      metadata: { documentType: d!.documentType, documentNumber: d!.documentNumber, expiryDate: d!.expiryDate },
    });
    return d!;
  });
  res.status(201).json({ data: withStatus(created) });
});

/** Loads a document the caller may act on with `action`; unknown or out-of-scope ids are 404. */
async function docFor(a: Access, docId: string, action: "read" | "update" | "delete") {
  const [d] = await db
    .select()
    .from(vehicleDocuments)
    .where(and(eq(vehicleDocuments.id, docId), eq(vehicleDocuments.organizationId, a.orgId), isNull(vehicleDocuments.deletedAt)))
    .limit(1);
  if (!d) throw notFound("المستند غير موجود");
  const perm = PERMS[kindOf(d.documentType)][action];
  if (!(await vehicleInScope(a, d.vehicleId, perm))) throw notFound("المستند غير موجود");
  if (action !== "read" && a.scopeOf(perm) === "ASSIGNED") throw forbidden();
  const [v] = await db.select({ projectId: vehicles.projectId }).from(vehicles).where(eq(vehicles.id, d.vehicleId));
  return { doc: d, projectId: v?.projectId ?? null };
}

const UpdateDoc = z
  .object({
    documentNumber: optionalText(60),
    issueDate: isoDate.nullable().optional(),
    expiryDate: isoDate.nullable().optional(),
    issuer: optionalText(120),
    notes: optionalText(2000),
  })
  .strict();

documentsRouter.patch("/vehicle-documents/:id", requireAny("vehicle_documents.update", "registration.update"), async (req, res) => {
  const { access } = ctx(req);
  const { id } = idParam.parse(req.params);
  const { doc, projectId } = await docFor(access, id, "update");
  if (doc.supersededAt) throw badRequest("لا يمكن تعديل نسخة سابقة؛ عدّل النسخة الحالية");
  const patch = UpdateDoc.parse(req.body);
  if (doc.documentType === "REGISTRATION") {
    if (patch.documentNumber === null) throw badRequest("رقم الاستمارة مطلوب");
    if (patch.expiryDate === null) throw badRequest("تاريخ انتهاء الاستمارة مطلوب");
  }
  checkDates(patch.issueDate === undefined ? doc.issueDate : patch.issueDate, patch.expiryDate === undefined ? doc.expiryDate : patch.expiryDate);
  const updated = await db.transaction(async (tx) => {
    const [d] = await tx.update(vehicleDocuments).set({ ...patch, updatedAt: new Date() }).where(eq(vehicleDocuments.id, id)).returning();
    const changes = diff(doc, patch);
    if (Object.keys(changes).length) {
      await audit(tx, req, {
        action: doc.documentType === "REGISTRATION" ? "REGISTRATION_UPDATED" : "VEHICLE_DOCUMENT_UPDATED",
        entity: "vehicle_document",
        entityId: id,
        projectId,
        vehicleId: doc.vehicleId,
        metadata: { documentType: doc.documentType, changes },
      });
    }
    return d!;
  });
  res.json({ data: withStatus(updated) });
});

documentsRouter.delete("/vehicle-documents/:id", requireAny("vehicle_documents.delete"), async (req, res) => {
  const { access } = ctx(req);
  const { id } = idParam.parse(req.params);
  const { doc, projectId } = await docFor(access, id, "delete");
  await db.transaction(async (tx) => {
    // Soft delete keeps the record and file for the audit trail.
    await tx.update(vehicleDocuments).set({ deletedAt: new Date(), deletedBy: access.userId, updatedAt: new Date() }).where(eq(vehicleDocuments.id, id));
    await audit(tx, req, {
      action: "VEHICLE_DOCUMENT_DELETED",
      entity: "vehicle_document",
      entityId: id,
      projectId,
      vehicleId: doc.vehicleId,
      metadata: { documentType: doc.documentType, documentNumber: doc.documentNumber },
    });
  });
  res.status(204).end();
});

// ======================================================================= registration

documentsRouter.get("/vehicles/:id/registration", requireAny("registration.read"), async (req, res) => {
  const { access } = ctx(req);
  const { id } = idParam.parse(req.params);
  await vehicleFor(access, id, "registration.read");
  const rows = await docQuery()
    .where(and(eq(vehicleDocuments.vehicleId, id), eq(vehicleDocuments.documentType, "REGISTRATION"), isNull(vehicleDocuments.deletedAt)))
    .orderBy(desc(vehicleDocuments.createdAt));
  const list = rows.map(withStatus);
  res.json({ data: { current: list.find((r) => r.isCurrent) ?? null, history: list.filter((r) => !r.isCurrent) } });
});

const RegistrationBody = z
  .object({
    documentNumber: trimmed(2, 60),
    issueDate: isoDate.nullable().optional(),
    expiryDate: isoDate,
    issuer: optionalText(120),
    notes: optionalText(2000),
  })
  .strict();

/** Adds a registration. If one is current it is superseded (renewal) in the same transaction. */
documentsRouter.post("/vehicles/:id/registration", requireAny("registration.create"), async (req, res) => {
  const { access } = ctx(req);
  const { id } = idParam.parse(req.params);
  assertWritable(access, "registration.create");
  const v = await vehicleFor(access, id, "registration.create");
  if (v.status === "ARCHIVED") throw badRequest("لا يمكن إضافة استمارة لمركبة مؤرشفة");
  const body = RegistrationBody.parse(req.body);
  checkDates(body.issueDate, body.expiryDate);
  const created = await db.transaction(async (tx) => {
    const superseded = await tx
      .update(vehicleDocuments)
      .set({ supersededAt: new Date(), updatedAt: new Date() })
      .where(and(eq(vehicleDocuments.vehicleId, v.id), eq(vehicleDocuments.documentType, "REGISTRATION"), isNull(vehicleDocuments.supersededAt), isNull(vehicleDocuments.deletedAt)))
      .returning({ id: vehicleDocuments.id });
    const [d] = await tx
      .insert(vehicleDocuments)
      .values({ organizationId: access.orgId, vehicleId: v.id, documentType: "REGISTRATION", ...body, createdBy: access.userId })
      .returning();
    await audit(tx, req, {
      action: "REGISTRATION_ADDED",
      entity: "vehicle_document",
      entityId: d!.id,
      projectId: v.projectId,
      vehicleId: v.id,
      metadata: { documentNumber: d!.documentNumber, expiryDate: d!.expiryDate, renewedFrom: superseded[0]?.id ?? null },
    });
    return d!;
  });
  res.status(201).json({ data: withStatus(created) });
});

// ======================================================================= insurance

documentsRouter.get("/vehicles/:id/insurance", requireAny("insurance.read"), async (req, res) => {
  const { access } = ctx(req);
  const { id } = idParam.parse(req.params);
  await vehicleFor(access, id, "insurance.read");
  const rows = await insQuery().where(eq(insurancePolicies.vehicleId, id)).orderBy(desc(insurancePolicies.createdAt));
  const list = rows.map(withStatus);
  res.json({ data: { current: list.find((r) => r.isCurrent) ?? null, history: list.filter((r) => !r.isCurrent) } });
});

const InsuranceBody = z.object({
  provider: trimmed(2, 120),
  policyNumber: trimmed(2, 60),
  issueDate: isoDate.nullable().optional(),
  expiryDate: isoDate,
  premiumAmount: money.nullable().optional(),
  coverageType: z.enum(coverageType.enumValues),
  notes: optionalText(2000),
});

documentsRouter.post("/vehicles/:id/insurance", requireAny("insurance.create"), async (req, res) => {
  const { access } = ctx(req);
  const { id } = idParam.parse(req.params);
  assertWritable(access, "insurance.create");
  const v = await vehicleFor(access, id, "insurance.create");
  if (v.status === "ARCHIVED") throw badRequest("لا يمكن إضافة تأمين لمركبة مؤرشفة");
  const body = InsuranceBody.strict().parse(req.body);
  checkDates(body.issueDate, body.expiryDate);
  const created = await db.transaction(async (tx) => {
    const superseded = await tx
      .update(insurancePolicies)
      .set({ supersededAt: new Date(), updatedAt: new Date() })
      .where(and(eq(insurancePolicies.vehicleId, v.id), isNull(insurancePolicies.supersededAt)))
      .returning({ id: insurancePolicies.id });
    const [p] = await tx
      .insert(insurancePolicies)
      .values({ organizationId: access.orgId, vehicleId: v.id, ...body, premiumAmount: body.premiumAmount ?? null, createdBy: access.userId })
      .returning();
    await audit(tx, req, {
      action: "INSURANCE_ADDED",
      entity: "insurance_policy",
      entityId: p!.id,
      projectId: v.projectId,
      vehicleId: v.id,
      metadata: { provider: p!.provider, policyNumber: p!.policyNumber, expiryDate: p!.expiryDate, renewedFrom: superseded[0]?.id ?? null },
    });
    return p!;
  });
  res.status(201).json({ data: withStatus(created) });
});

async function policyFor(a: Access, policyId: string, action: "read" | "update") {
  const [p] = await db
    .select()
    .from(insurancePolicies)
    .where(and(eq(insurancePolicies.id, policyId), eq(insurancePolicies.organizationId, a.orgId)))
    .limit(1);
  if (!p) throw notFound("وثيقة التأمين غير موجودة");
  const perm = PERMS.insurance[action];
  if (!(await vehicleInScope(a, p.vehicleId, perm))) throw notFound("وثيقة التأمين غير موجودة");
  if (action !== "read" && a.scopeOf(perm) === "ASSIGNED") throw forbidden();
  const [v] = await db.select({ projectId: vehicles.projectId }).from(vehicles).where(eq(vehicles.id, p.vehicleId));
  return { policy: p, projectId: v?.projectId ?? null };
}

documentsRouter.patch("/insurance/:id", requireAny("insurance.update"), async (req, res) => {
  const { access } = ctx(req);
  const { id } = idParam.parse(req.params);
  const { policy, projectId } = await policyFor(access, id, "update");
  if (policy.supersededAt) throw badRequest("لا يمكن تعديل وثيقة سابقة؛ عدّل الوثيقة الحالية");
  const patch = InsuranceBody.partial().strict().parse(req.body);
  if (patch.expiryDate === null) throw badRequest("تاريخ الانتهاء مطلوب");
  checkDates(patch.issueDate === undefined ? policy.issueDate : patch.issueDate, patch.expiryDate ?? policy.expiryDate);
  const updated = await db.transaction(async (tx) => {
    const [p] = await tx.update(insurancePolicies).set({ ...patch, updatedAt: new Date() }).where(eq(insurancePolicies.id, id)).returning();
    const changes = diff(policy, patch);
    if (Object.keys(changes).length) {
      await audit(tx, req, { action: "INSURANCE_UPDATED", entity: "insurance_policy", entityId: id, projectId, vehicleId: policy.vehicleId, metadata: { changes } });
    }
    return p!;
  });
  res.json({ data: withStatus(updated) });
});

// ======================================================================= files

const rawUpload = express.raw({ type: () => true, limit: MAX_UPLOAD_BYTES });

async function attachFile(tx: DbOrTx, req: Request, a: Access) {
  return storeUpload(tx, req, a.orgId, a.userId);
}

const sendFile = (res: Response, fileId: string | null) => sendStoredFile(db, res, fileId);

documentsRouter.put("/vehicle-documents/:id/file", requireAny("vehicle_documents.update", "registration.update"), uploadRateLimit, rawUpload, async (req, res) => {
  const { access } = ctx(req);
  const { id } = idParam.parse(req.params);
  const { doc, projectId } = await docFor(access, id, "update");
  if (doc.supersededAt) throw badRequest("لا يمكن إرفاق ملف بنسخة سابقة");
  const file = await db.transaction(async (tx) => {
    const f = await attachFile(tx, req, access);
    await tx.update(vehicleDocuments).set({ fileId: f.id, updatedAt: new Date() }).where(eq(vehicleDocuments.id, id));
    await audit(tx, req, { action: "FILE_UPLOADED", entity: "vehicle_document", entityId: id, projectId, vehicleId: doc.vehicleId, metadata: { documentType: doc.documentType, fileName: f.originalName, sizeBytes: f.sizeBytes } });
    return f;
  });
  res.status(201).json({ data: { fileName: file.originalName, fileSize: file.sizeBytes, fileMime: file.mimeType } });
});

documentsRouter.get("/vehicle-documents/:id/file", requireAny("vehicle_documents.read", "registration.read"), async (req, res) => {
  const { access } = ctx(req);
  const { id } = idParam.parse(req.params);
  const { doc, projectId } = await docFor(access, id, "read");
  await audit(db, req, { action: "FILE_DOWNLOADED", entity: "vehicle_document", entityId: id, projectId, metadata: { documentType: doc.documentType } });
  await sendFile(res, doc.fileId);
});

documentsRouter.put("/insurance/:id/file", requireAny("insurance.update"), uploadRateLimit, rawUpload, async (req, res) => {
  const { access } = ctx(req);
  const { id } = idParam.parse(req.params);
  const { policy, projectId } = await policyFor(access, id, "update");
  if (policy.supersededAt) throw badRequest("لا يمكن إرفاق ملف بوثيقة سابقة");
  const file = await db.transaction(async (tx) => {
    const f = await attachFile(tx, req, access);
    await tx.update(insurancePolicies).set({ fileId: f.id, updatedAt: new Date() }).where(eq(insurancePolicies.id, id));
    await audit(tx, req, { action: "FILE_UPLOADED", entity: "insurance_policy", entityId: id, projectId, vehicleId: policy.vehicleId, metadata: { fileName: f.originalName, sizeBytes: f.sizeBytes } });
    return f;
  });
  res.status(201).json({ data: { fileName: file.originalName, fileSize: file.sizeBytes, fileMime: file.mimeType } });
});

documentsRouter.get("/insurance/:id/file", requireAny("insurance.read"), async (req, res) => {
  const { access } = ctx(req);
  const { id } = idParam.parse(req.params);
  const { policy, projectId } = await policyFor(access, id, "read");
  await audit(db, req, { action: "FILE_DOWNLOADED", entity: "insurance_policy", entityId: id, projectId });
  await sendFile(res, policy.fileId);
});

export const UPLOAD_LIMITS = { maxBytes: MAX_UPLOAD_BYTES, mimeTypes: ALLOWED_UPLOAD_MIME };

// ======================================================================= compliance summary

/**
 * One call for the vehicle overview: current registration / insurance / driver
 * license and derived alerts. Each part is included only when the caller holds
 * the matching read permission for this vehicle.
 */
documentsRouter.get("/vehicles/:id/compliance", requireAny("vehicles.read"), async (req, res) => {
  const { access } = ctx(req);
  const { id } = idParam.parse(req.params);
  const v = await vehicleFor(access, id, "vehicles.read");
  type Alert = { level: "warning" | "danger"; kind: string; message: string };
  const alerts: Alert[] = [];

  let registration = null;
  if (await vehicleInScope(access, id, "registration.read")) {
    const [r] = await docQuery().where(and(eq(vehicleDocuments.vehicleId, id), eq(vehicleDocuments.documentType, "REGISTRATION"), isNull(vehicleDocuments.supersededAt), isNull(vehicleDocuments.deletedAt)));
    registration = r ? withStatus(r) : null;
    if (!registration) alerts.push({ level: "warning", kind: "registration", message: "لا توجد استمارة مسجلة" });
    else if (registration.status === "EXPIRED") alerts.push({ level: "danger", kind: "registration", message: "الاستمارة منتهية" });
    else if (registration.status === "EXPIRING_SOON") alerts.push({ level: "warning", kind: "registration", message: `الاستمارة تنتهي خلال ${registration.daysLeft} يوم` });
  }

  let insurance = null;
  if (await vehicleInScope(access, id, "insurance.read")) {
    const [p] = await insQuery().where(and(eq(insurancePolicies.vehicleId, id), isNull(insurancePolicies.supersededAt)));
    insurance = p ? withStatus(p) : null;
    if (!insurance) alerts.push({ level: "warning", kind: "insurance", message: "لا توجد وثيقة تأمين" });
    else if (insurance.status === "EXPIRED") alerts.push({ level: "danger", kind: "insurance", message: "التأمين منتهٍ" });
    else if (insurance.status === "EXPIRING_SOON") alerts.push({ level: "warning", kind: "insurance", message: `التأمين ينتهي خلال ${insurance.daysLeft} يوم` });
  }

  let driverLicense = null;
  if (v.assignedDriverId) {
    const [d] = await db
      .select({ id: drivers.id, fullName: employees.fullName, licenseExpiryDate: drivers.licenseExpiryDate })
      .from(drivers)
      .innerJoin(employees, eq(employees.id, drivers.employeeId))
      .where(eq(drivers.id, v.assignedDriverId));
    if (d) {
      const status = d.licenseExpiryDate ? expiryStatus(d.licenseExpiryDate) : null;
      driverLicense = { driverId: d.id, fullName: d.fullName, licenseExpiryDate: d.licenseExpiryDate, licenseStatus: status };
      if (status === "EXPIRED") alerts.push({ level: "danger", kind: "license", message: "رخصة السائق الحالي منتهية" });
      else if (status === "EXPIRING_SOON") alerts.push({ level: "warning", kind: "license", message: `رخصة السائق تنتهي خلال ${daysUntil(d.licenseExpiryDate!)} يوم` });
    }
  }

  res.json({ data: { registration, insurance, driverLicense, alerts } });
});
