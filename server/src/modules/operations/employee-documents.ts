import { and, asc, desc, eq, ilike, isNull, or, sql, type SQL } from "drizzle-orm";
import { unionAll } from "drizzle-orm/pg-core";
import { Router } from "express";
import { z } from "zod";
import { driverScope, employeeScope, vehicleScope, type Access } from "../../auth/access.js";
import { db } from "../../db/client.js";
import { documentType, drivers, employeeDocuments, employeeDocumentType, employees, insurancePolicies, projects, vehicleDocuments, vehicles } from "../../db/schema/index.js";
import { ctx } from "../../http/context.js";
import { badRequest, notFound } from "../../http/errors.js";
import { requirePermission } from "../../http/middleware.js";
import { idParam, isoDate, optionalText, paged, pagination, uuid } from "../../http/validate.js";
import { addDays, today } from "../../lib/clock.js";
import { uploadRateLimit } from "../../lib/pg-rate-limit.js";
import { audit, diff } from "../../services/audit.js";
import { EXPIRING_SOON_DAYS, expiryStatus } from "../../services/expiry.js";
import { sendStoredFile, storeUpload } from "../../services/storage.js";
import { getEmployeeInScope } from "../employees/service.js";
import { rawUpload } from "./common.js";

export const employeeDocumentsRouter = Router();

type EmpDoc = typeof employeeDocuments.$inferSelect;

const withStatus = (d: EmpDoc) => {
  const { fileId, ...rest } = d;
  return { ...rest, hasFile: !!fileId, status: expiryStatus(d.expiryDate) };
};

employeeDocumentsRouter.get("/employees/:id/documents", requirePermission("employees.read"), async (req, res) => {
  const { access } = ctx(req);
  const { id } = idParam.parse(req.params);
  await getEmployeeInScope(db, access, id, "employees.read");
  const rows = await db
    .select()
    .from(employeeDocuments)
    .where(and(eq(employeeDocuments.employeeId, id), isNull(employeeDocuments.deletedAt)))
    .orderBy(asc(employeeDocuments.expiryDate));
  res.json({ data: rows.map(withStatus) });
});

const DocBody = z
  .object({
    documentType: z.enum(employeeDocumentType.enumValues),
    documentNumber: optionalText(100),
    issueDate: isoDate.nullable().optional(),
    expiryDate: isoDate.nullable().optional(),
    notes: optionalText(1000),
  })
  .strict();

function checkDates(issue?: string | null, expiry?: string | null) {
  if (issue && expiry && expiry < issue) throw badRequest("تاريخ الانتهاء يجب أن يكون بعد تاريخ الإصدار");
  if (issue && issue > today()) throw badRequest("تاريخ الإصدار لا يمكن أن يكون في المستقبل");
}

/** Loads a document whose employee is inside the caller's scope for `perm`. */
async function loadDoc(a: Access, id: string, perm: "employees.read" | "employees.update") {
  const [row] = await db
    .select({ doc: employeeDocuments, projectId: employees.projectId })
    .from(employeeDocuments)
    .innerJoin(employees, eq(employees.id, employeeDocuments.employeeId))
    .where(and(eq(employeeDocuments.id, id), isNull(employeeDocuments.deletedAt), employeeScope(a, perm)))
    .limit(1);
  if (!row) throw notFound("المستند غير موجود");
  return row;
}

employeeDocumentsRouter.post("/employees/:id/documents", requirePermission("employees.update"), requirePermission("documents.upload"), async (req, res) => {
  const { access } = ctx(req);
  const { id } = idParam.parse(req.params);
  const emp = await getEmployeeInScope(db, access, id, "employees.update");
  const b = DocBody.parse(req.body);
  checkDates(b.issueDate, b.expiryDate);
  const doc = await db.transaction(async (tx) => {
    const [d] = await tx
      .insert(employeeDocuments)
      .values({ organizationId: access.orgId, employeeId: id, documentType: b.documentType, documentNumber: b.documentNumber ?? null, issueDate: b.issueDate ?? null, expiryDate: b.expiryDate ?? null, notes: b.notes ?? null, createdBy: access.userId })
      .returning();
    await audit(tx, req, { action: "EMPLOYEE_DOCUMENT_ADDED", entity: "employee_document", entityId: d!.id, projectId: emp.projectId, metadata: { employeeId: id, documentType: d!.documentType, expiryDate: d!.expiryDate } });
    return d!;
  });
  res.status(201).json({ data: withStatus(doc) });
});

employeeDocumentsRouter.patch("/employee-documents/:id", requirePermission("employees.update"), requirePermission("documents.upload"), async (req, res) => {
  const { access } = ctx(req);
  const { id } = idParam.parse(req.params);
  const { doc, projectId } = await loadDoc(access, id, "employees.update");
  const b = DocBody.partial().strict().parse(req.body);
  checkDates(b.issueDate === undefined ? doc.issueDate : b.issueDate, b.expiryDate === undefined ? doc.expiryDate : b.expiryDate);
  const patch = Object.fromEntries(Object.entries(b).filter(([, v]) => v !== undefined)) as Partial<EmpDoc>;
  const changes = diff(doc as unknown as Record<string, unknown>, patch as Record<string, unknown>);
  if (!Object.keys(changes).length) throw badRequest("لا يوجد تغيير");
  const updated = await db.transaction(async (tx) => {
    const [u] = await tx.update(employeeDocuments).set({ ...patch, updatedAt: new Date() }).where(eq(employeeDocuments.id, id)).returning();
    await audit(tx, req, { action: "EMPLOYEE_DOCUMENT_UPDATED", entity: "employee_document", entityId: id, projectId, metadata: { employeeId: doc.employeeId, changes } });
    return u!;
  });
  res.json({ data: withStatus(updated) });
});

employeeDocumentsRouter.delete("/employee-documents/:id", requirePermission("documents.delete"), async (req, res) => {
  const { access } = ctx(req);
  const { id } = idParam.parse(req.params);
  const scope = access.require("documents.delete");
  const { doc, projectId } = await loadDoc(access, id, "employees.read");
  if (scope === "PROJECT" && !access.isMemberOf(projectId)) throw notFound("المستند غير موجود");
  if (scope === "ASSIGNED") throw notFound("المستند غير موجود");
  await db.transaction(async (tx) => {
    await tx.update(employeeDocuments).set({ deletedAt: new Date(), deletedBy: access.userId }).where(eq(employeeDocuments.id, id));
    await audit(tx, req, { action: "EMPLOYEE_DOCUMENT_DELETED", entity: "employee_document", entityId: id, projectId, metadata: { employeeId: doc.employeeId, documentType: doc.documentType } });
  });
  res.status(204).end();
});

employeeDocumentsRouter.put("/employee-documents/:id/file", requirePermission("employees.update"), requirePermission("documents.upload"), uploadRateLimit, rawUpload, async (req, res) => {
  const { access } = ctx(req);
  const { id } = idParam.parse(req.params);
  const { doc, projectId } = await loadDoc(access, id, "employees.update");
  const f = await db.transaction(async (tx) => {
    const file = await storeUpload(tx, req, access.orgId, access.userId);
    await tx.update(employeeDocuments).set({ fileId: file.id, updatedAt: new Date() }).where(eq(employeeDocuments.id, id));
    await audit(tx, req, { action: "FILE_UPLOADED", entity: "employee_document", entityId: id, projectId, metadata: { employeeId: doc.employeeId, fileName: file.originalName } });
    return file;
  });
  res.status(201).json({ data: { fileName: f.originalName } });
});

employeeDocumentsRouter.get("/employee-documents/:id/file", requirePermission("employees.read"), async (req, res) => {
  const { access } = ctx(req);
  const { id } = idParam.parse(req.params);
  const { doc, projectId } = await loadDoc(access, id, "employees.read");
  await audit(db, req, { action: "FILE_DOWNLOADED", entity: "employee_document", entityId: id, projectId, metadata: { employeeId: doc.employeeId } });
  await sendStoredFile(db, res, doc.fileId);
});

// ---------------------------------------------------------------- documents center

const CenterQuery = pagination.extend({
  kind: z.enum(["VEHICLE", "INSURANCE", "EMPLOYEE", "LICENSE"]).optional(),
  type: z.string().trim().max(40).optional(),
  status: z.enum(["ACTIVE", "EXPIRING_SOON", "EXPIRED", "NO_EXPIRY"]).optional(),
  projectId: uuid.optional(),
  q: z.string().trim().max(100).optional(),
});

/**
 * Unified, read-only list of every expiring document the caller may see:
 * vehicle documents, insurance policies, employee documents and driver licenses.
 * Each source is included only when the caller holds its read permission and is
 * filtered by that permission's scope. Status is computed from the server date.
 */
employeeDocumentsRouter.get("/documents-center", requirePermission("documents.read"), async (req, res) => {
  const { access } = ctx(req);
  const q = CenterQuery.parse(req.query);
  const t = today();
  const soon = addDays(t, EXPIRING_SOON_DAYS);
  const like = q.q ? `%${q.q.replace(/[%_\\]/g, "\\$&")}%` : null;
  const statusOf = (col: SQL) =>
    sql<string>`case when ${col} is null then 'NO_EXPIRY' when ${col} < ${t}::date then 'EXPIRED' when ${col} <= ${soon}::date then 'EXPIRING_SOON' else 'ACTIVE' end`;
  const statusCond = (col: SQL): SQL | undefined => (q.status ? sql`${statusOf(col)} = ${q.status}` : undefined);

  const parts = [];
  if ((!q.kind || q.kind === "VEHICLE") && access.has("vehicle_documents.read")) {
    const exp = sql`${vehicleDocuments.expiryDate}`;
    parts.push(
      db
        .select({
          kind: sql<string>`'VEHICLE'`.as("kind"),
          id: sql<string>`${vehicleDocuments.id}`.as("id"),
          type: sql<string>`${vehicleDocuments.documentType}::text`.as("type"),
          number: sql<string | null>`${vehicleDocuments.documentNumber}`.as("number"),
          expiryDate: sql<string | null>`${vehicleDocuments.expiryDate}`.as("expiry_date"),
          ownerId: sql<string>`${vehicles.id}`.as("owner_id"),
          ownerName: sql<string>`${vehicles.plateNumber}`.as("owner_name"),
          projectId: sql<string | null>`${vehicles.projectId}`.as("project_id"),
          projectName: sql<string | null>`${projects.name}`.as("project_name"),
          hasFile: sql<boolean>`(${vehicleDocuments.fileId} is not null)`.as("has_file"),
          status: statusOf(exp).as("status"),
        })
        .from(vehicleDocuments)
        .innerJoin(vehicles, eq(vehicles.id, vehicleDocuments.vehicleId))
        .leftJoin(projects, eq(projects.id, vehicles.projectId))
        .where(
          and(
            vehicleScope(access, "vehicle_documents.read"),
            isNull(vehicleDocuments.deletedAt),
            isNull(vehicleDocuments.supersededAt),
            statusCond(exp),
            q.type && (documentType.enumValues as readonly string[]).includes(q.type) ? sql`${vehicleDocuments.documentType} = ${q.type}` : q.type ? sql`false` : undefined,
            q.projectId ? eq(vehicles.projectId, q.projectId) : undefined,
            like ? or(ilike(vehicles.plateNumber, like), ilike(vehicleDocuments.documentNumber, like)) : undefined,
          ),
        ),
    );
  }
  if ((!q.kind || q.kind === "INSURANCE") && access.has("insurance.read") && (!q.type || q.type === "INSURANCE")) {
    const exp = sql`${insurancePolicies.expiryDate}`;
    parts.push(
      db
        .select({
          kind: sql<string>`'INSURANCE'`.as("kind"),
          id: sql<string>`${insurancePolicies.id}`.as("id"),
          type: sql<string>`'INSURANCE'`.as("type"),
          number: sql<string | null>`${insurancePolicies.policyNumber}`.as("number"),
          expiryDate: sql<string | null>`${insurancePolicies.expiryDate}`.as("expiry_date"),
          ownerId: sql<string>`${vehicles.id}`.as("owner_id"),
          ownerName: sql<string>`${vehicles.plateNumber}`.as("owner_name"),
          projectId: sql<string | null>`${vehicles.projectId}`.as("project_id"),
          projectName: sql<string | null>`${projects.name}`.as("project_name"),
          hasFile: sql<boolean>`(${insurancePolicies.fileId} is not null)`.as("has_file"),
          status: statusOf(exp).as("status"),
        })
        .from(insurancePolicies)
        .innerJoin(vehicles, eq(vehicles.id, insurancePolicies.vehicleId))
        .leftJoin(projects, eq(projects.id, vehicles.projectId))
        .where(
          and(
            vehicleScope(access, "insurance.read"),
            isNull(insurancePolicies.supersededAt),
            statusCond(exp),
            q.projectId ? eq(vehicles.projectId, q.projectId) : undefined,
            like ? or(ilike(vehicles.plateNumber, like), ilike(insurancePolicies.policyNumber, like), ilike(insurancePolicies.provider, like)) : undefined,
          ),
        ),
    );
  }
  if ((!q.kind || q.kind === "EMPLOYEE") && access.has("employees.read")) {
    const exp = sql`${employeeDocuments.expiryDate}`;
    parts.push(
      db
        .select({
          kind: sql<string>`'EMPLOYEE'`.as("kind"),
          id: sql<string>`${employeeDocuments.id}`.as("id"),
          type: sql<string>`${employeeDocuments.documentType}::text`.as("type"),
          number: sql<string | null>`${employeeDocuments.documentNumber}`.as("number"),
          expiryDate: sql<string | null>`${employeeDocuments.expiryDate}`.as("expiry_date"),
          ownerId: sql<string>`${employees.id}`.as("owner_id"),
          ownerName: sql<string>`${employees.fullName}`.as("owner_name"),
          projectId: sql<string | null>`${employees.projectId}`.as("project_id"),
          projectName: sql<string | null>`${projects.name}`.as("project_name"),
          hasFile: sql<boolean>`(${employeeDocuments.fileId} is not null)`.as("has_file"),
          status: statusOf(exp).as("status"),
        })
        .from(employeeDocuments)
        .innerJoin(employees, eq(employees.id, employeeDocuments.employeeId))
        .leftJoin(projects, eq(projects.id, employees.projectId))
        .where(
          and(
            employeeScope(access, "employees.read"),
            isNull(employeeDocuments.deletedAt),
            statusCond(exp),
            q.type && (employeeDocumentType.enumValues as readonly string[]).includes(q.type) ? sql`${employeeDocuments.documentType} = ${q.type}` : q.type ? sql`false` : undefined,
            q.projectId ? eq(employees.projectId, q.projectId) : undefined,
            like ? or(ilike(employees.fullName, like), ilike(employeeDocuments.documentNumber, like)) : undefined,
          ),
        ),
    );
  }
  if ((!q.kind || q.kind === "LICENSE") && access.has("drivers.read") && (!q.type || q.type === "DRIVING_LICENSE")) {
    const exp = sql`${drivers.licenseExpiryDate}`;
    parts.push(
      db
        .select({
          kind: sql<string>`'LICENSE'`.as("kind"),
          id: sql<string>`${drivers.id}`.as("id"),
          type: sql<string>`'DRIVING_LICENSE'`.as("type"),
          number: sql<string | null>`${drivers.licenseNumber}`.as("number"),
          expiryDate: sql<string | null>`${drivers.licenseExpiryDate}`.as("expiry_date"),
          ownerId: sql<string>`${drivers.id}`.as("owner_id"),
          ownerName: sql<string>`${employees.fullName}`.as("owner_name"),
          projectId: sql<string | null>`${employees.projectId}`.as("project_id"),
          projectName: sql<string | null>`${projects.name}`.as("project_name"),
          hasFile: sql<boolean>`false`.as("has_file"),
          status: statusOf(exp).as("status"),
        })
        .from(drivers)
        .innerJoin(employees, eq(employees.id, drivers.employeeId))
        .leftJoin(projects, eq(projects.id, employees.projectId))
        .where(
          and(
            driverScope(access, "drivers.read"),
            isNull(drivers.archivedAt),
            statusCond(exp),
            q.projectId ? eq(employees.projectId, q.projectId) : undefined,
            like ? or(ilike(employees.fullName, like), ilike(drivers.licenseNumber, like)) : undefined,
          ),
        ),
    );
  }
  if (parts.length === 0) {
    res.json({ ...paged([], 0, q.page, q.pageSize), summary: { EXPIRED: 0, EXPIRING_SOON: 0, ACTIVE: 0, NO_EXPIRY: 0 } });
    return;
  }
  const [first, ...rest] = parts;
  // Every branch selects the same aliased shape; only the source-table typing differs.
  type Branch = NonNullable<typeof first>;
  const union = rest.length ? (unionAll as unknown as (...q: Branch[]) => Branch)(first!, ...(rest as Branch[])) : first!;
  const sub = union.as("docs");
  const [rows, summary] = await Promise.all([
    db
      .select()
      .from(sub)
      .orderBy(sql`${sub.expiryDate} asc nulls last`, desc(sub.kind))
      .limit(q.pageSize)
      .offset((q.page - 1) * q.pageSize),
    db.select({ status: sub.status, n: sql<number>`count(*)::int` }).from(sub).groupBy(sub.status),
  ]);
  const counts: Record<string, number> = { EXPIRED: 0, EXPIRING_SOON: 0, ACTIVE: 0, NO_EXPIRY: 0 };
  for (const s of summary) counts[s.status] = s.n;
  const total = Object.values(counts).reduce((x, y) => x + y, 0);
  res.json({ ...paged(rows, total, q.page, q.pageSize), summary: counts });
});
