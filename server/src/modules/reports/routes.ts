import { and, asc, desc, eq, isNull, sql, type AnyColumn, type SQL } from "drizzle-orm";
import { Router } from "express";
import { z } from "zod";
import { driverScope, maintenanceScope, projectScope, vehicleScope, type Access } from "../../auth/access.js";
import type { PermissionKey } from "../../auth/permissions.js";
import { config } from "../../config.js";
import { db } from "../../db/client.js";
import {
  accidents,
  drivers,
  employees,
  expenses,
  fuelTransactions,
  handoverSessions,
  insurancePolicies,
  invoices,
  maintenanceRequests,
  projects,
  users,
  vehicleDocuments,
  vehicles,
  vendors,
  violations,
} from "../../db/schema/index.js";
import { ctx } from "../../http/context.js";
import { badRequest, forbidden, notFound } from "../../http/errors.js";
import { requirePermission } from "../../http/middleware.js";
import { isoDate, uuid } from "../../http/validate.js";
import { addDays, today } from "../../lib/clock.js";
import { audit } from "../../services/audit.js";
import { EXPIRING_SOON_DAYS } from "../../services/expiry.js";
import { costsCte, costsScope } from "../finance/costs.js";
import { expenseScope } from "../finance/expenses.js";
import { invoiceScope } from "../finance/invoices.js";
import { accidentScope } from "../operations/accidents.js";
import { driverNameSql } from "../operations/common.js";
import { fuelScope } from "../operations/fuel.js";
import { handoverScope } from "../operations/handover.js";
import { violationScope } from "../operations/violations.js";

/**
 * Reports. Each report reuses the scope predicate of its module, so a report
 * never shows more than the matching list screen. JSON (on screen / print→PDF)
 * or CSV (UTF-8 with BOM for Excel, formula-injection safe).
 */
export const reportsRouter = Router();

type Filters = { from?: string; to?: string; projectId?: string; vehicleId?: string; status?: string };
type Column = { key: string; label: string; type?: "money" | "number" | "date" | "datetime" | "text" };
type ReportDef = {
  key: string;
  title: string;
  description: string;
  perms: PermissionKey[];
  statuses?: readonly string[];
  columns: Column[];
  run: (a: Access, f: Filters, limit: number) => Promise<Record<string, unknown>[]>;
  totals?: string[];
};

const tz = () => config.APP_TIMEZONE;
function range(col: AnyColumn | SQL, f: Filters, isTimestamp = true): SQL[] {
  const c = isTimestamp ? sql`(${col} at time zone ${tz()})::date` : sql`${col}`;
  const out: SQL[] = [];
  if (f.from) out.push(sql`${c} >= ${f.from}::date`);
  if (f.to) out.push(sql`${c} <= ${f.to}::date`);
  return out;
}
const opt = (cond: boolean, v: SQL) => (cond ? v : undefined);

const REPORTS: ReportDef[] = [
  {
    key: "vehicles",
    title: "سجل المركبات",
    description: "جميع المركبات مع الحالة والمشروع والسائق والعداد وانتهاء الاستمارة والتأمين",
    perms: ["vehicles.read"],
    statuses: ["AVAILABLE", "ASSIGNED", "IN_MAINTENANCE", "OUT_OF_SERVICE", "ACCIDENT", "SOLD", "ARCHIVED"],
    columns: [
      { key: "plateNumber", label: "اللوحة" },
      { key: "plateArabic", label: "اللوحة (عربي)" },
      { key: "make", label: "الشركة" },
      { key: "model", label: "الطراز" },
      { key: "year", label: "السنة", type: "number" },
      { key: "status", label: "الحالة" },
      { key: "projectName", label: "المشروع" },
      { key: "driverName", label: "السائق" },
      { key: "currentOdometer", label: "العداد", type: "number" },
      { key: "registrationExpiry", label: "انتهاء الاستمارة", type: "date" },
      { key: "insuranceExpiry", label: "انتهاء التأمين", type: "date" },
    ],
    run: (a, f, limit) =>
      db
        .select({
          plateNumber: vehicles.plateNumber,
          plateArabic: vehicles.plateArabic,
          make: vehicles.make,
          model: vehicles.model,
          year: vehicles.year,
          status: vehicles.status,
          projectName: projects.name,
          driverName: driverNameSql(vehicles.assignedDriverId),
          currentOdometer: vehicles.currentOdometer,
          registrationExpiry: sql<string | null>`(select vd.expiry_date from vehicle_documents vd where vd.vehicle_id = ${vehicles.id} and vd.document_type = 'REGISTRATION' and vd.superseded_at is null and vd.deleted_at is null limit 1)`,
          insuranceExpiry: sql<string | null>`(select ip.expiry_date from insurance_policies ip where ip.vehicle_id = ${vehicles.id} and ip.superseded_at is null limit 1)`,
        })
        .from(vehicles)
        .leftJoin(projects, eq(projects.id, vehicles.projectId))
        .where(and(vehicleScope(a, "vehicles.read"), opt(!!f.projectId, eq(vehicles.projectId, f.projectId!)), opt(!!f.vehicleId, eq(vehicles.id, f.vehicleId!)), opt(!!f.status, sql`${vehicles.status} = ${f.status}`)))
        .orderBy(asc(vehicles.plateNumber))
        .limit(limit),
  },
  {
    key: "maintenance",
    title: "تقرير الصيانة",
    description: "طلبات الصيانة مع الحالة والفني والتكلفة ومدة الإنجاز",
    perms: ["maintenance.read"],
    statuses: ["REQUESTED", "INSPECTION", "QUOTE_PENDING", "PENDING_APPROVAL", "APPROVED", "IN_REPAIR", "READY_FOR_HANDOVER", "ACCEPTED", "CLOSED", "REJECTED"],
    columns: [
      { key: "label", label: "رقم الطلب" },
      { key: "plateNumber", label: "المركبة" },
      { key: "projectName", label: "المشروع" },
      { key: "issue", label: "المشكلة" },
      { key: "priority", label: "الأولوية" },
      { key: "status", label: "الحالة" },
      { key: "technician", label: "الفني" },
      { key: "createdAt", label: "تاريخ الطلب", type: "datetime" },
      { key: "closedAt", label: "تاريخ الإغلاق", type: "datetime" },
      { key: "days", label: "المدة (أيام)", type: "number" },
      { key: "partsCost", label: "قطع الغيار", type: "money" },
      { key: "laborCost", label: "العمالة", type: "money" },
      { key: "totalCost", label: "الإجمالي", type: "money" },
    ],
    totals: ["partsCost", "laborCost", "totalCost"],
    run: async (a, f, limit) => {
      const rows = await db
        .select({
          number: maintenanceRequests.number,
          plateNumber: vehicles.plateNumber,
          projectName: projects.name,
          issue: maintenanceRequests.issue,
          priority: maintenanceRequests.priority,
          status: maintenanceRequests.status,
          technician: users.name,
          createdAt: maintenanceRequests.createdAt,
          closedAt: maintenanceRequests.closedAt,
          days: sql<number | null>`case when "maintenance_requests"."closed_at" is not null then round(extract(epoch from ("maintenance_requests"."closed_at" - "maintenance_requests"."created_at")) / 86400.0, 1) end`,
          partsCost: sql<string>`coalesce((select sum(p.total) from maintenance_parts p where p.maintenance_request_id = "maintenance_requests"."id"), 0)::numeric(14,2)::text`,
          laborCost: sql<string>`coalesce((select sum(l.total) from maintenance_labor l where l.maintenance_request_id = "maintenance_requests"."id"), 0)::numeric(14,2)::text`,
        })
        .from(maintenanceRequests)
        .innerJoin(vehicles, eq(vehicles.id, maintenanceRequests.vehicleId))
        .leftJoin(projects, eq(projects.id, maintenanceRequests.projectId))
        .leftJoin(users, eq(users.id, maintenanceRequests.assignedTo))
        .where(and(maintenanceScope(a, "maintenance.read"), ...range(maintenanceRequests.createdAt, f), opt(!!f.projectId, eq(maintenanceRequests.projectId, f.projectId!)), opt(!!f.vehicleId, eq(maintenanceRequests.vehicleId, f.vehicleId!)), opt(!!f.status, sql`${maintenanceRequests.status} = ${f.status}`)))
        .orderBy(desc(maintenanceRequests.createdAt))
        .limit(limit);
      const costVisible = a.has("maintenance.parts.read") && a.has("maintenance.labor.read");
      return rows.map((r) => ({ ...r, label: `MR-${r.number}`, partsCost: costVisible ? r.partsCost : null, laborCost: costVisible ? r.laborCost : null, totalCost: costVisible ? (Number(r.partsCost) + Number(r.laborCost)).toFixed(2) : null }));
    },
  },
  {
    key: "fuel",
    title: "تقرير الوقود",
    description: "عمليات تعبئة الوقود واللترات والتكلفة",
    perms: ["fuel.read"],
    columns: [
      { key: "fueledAt", label: "التاريخ", type: "datetime" },
      { key: "plateNumber", label: "المركبة" },
      { key: "projectName", label: "المشروع" },
      { key: "driverName", label: "السائق" },
      { key: "liters", label: "اللترات", type: "number" },
      { key: "pricePerLiter", label: "سعر اللتر", type: "money" },
      { key: "total", label: "الإجمالي", type: "money" },
      { key: "odometer", label: "العداد", type: "number" },
      { key: "station", label: "المحطة" },
    ],
    totals: ["liters", "total"],
    run: (a, f, limit) =>
      db
        .select({ fueledAt: fuelTransactions.fueledAt, plateNumber: vehicles.plateNumber, projectName: projects.name, driverName: driverNameSql(fuelTransactions.driverId), liters: fuelTransactions.liters, pricePerLiter: fuelTransactions.pricePerLiter, total: fuelTransactions.total, odometer: fuelTransactions.odometer, station: fuelTransactions.station })
        .from(fuelTransactions)
        .innerJoin(vehicles, eq(vehicles.id, fuelTransactions.vehicleId))
        .leftJoin(projects, eq(projects.id, fuelTransactions.projectId))
        .where(and(fuelScope(a), ...range(fuelTransactions.fueledAt, f), opt(!!f.projectId, eq(fuelTransactions.projectId, f.projectId!)), opt(!!f.vehicleId, eq(fuelTransactions.vehicleId, f.vehicleId!))))
        .orderBy(desc(fuelTransactions.fueledAt))
        .limit(limit),
  },
  {
    key: "accidents",
    title: "تقرير الحوادث",
    description: "الحوادث مع الخطورة والمسؤولية والحالة وتكلفة الإصلاح",
    perms: ["accidents.read"],
    statuses: ["OPEN", "UNDER_REVIEW", "INSURANCE", "REPAIR", "CLOSED"],
    columns: [
      { key: "label", label: "الرقم" },
      { key: "occurredAt", label: "التاريخ", type: "datetime" },
      { key: "plateNumber", label: "المركبة" },
      { key: "projectName", label: "المشروع" },
      { key: "driverName", label: "السائق" },
      { key: "severity", label: "الخطورة" },
      { key: "responsibility", label: "المسؤولية" },
      { key: "status", label: "الحالة" },
      { key: "insuranceClaimNumber", label: "رقم المطالبة" },
      { key: "repairCost", label: "تكلفة الإصلاح", type: "money" },
    ],
    totals: ["repairCost"],
    run: async (a, f, limit) =>
      (
        await db
          .select({ number: accidents.number, occurredAt: accidents.occurredAt, plateNumber: vehicles.plateNumber, projectName: projects.name, driverName: driverNameSql(accidents.driverId), severity: accidents.severity, responsibility: accidents.responsibility, status: accidents.status, insuranceClaimNumber: accidents.insuranceClaimNumber, repairCost: accidents.repairCost })
          .from(accidents)
          .innerJoin(vehicles, eq(vehicles.id, accidents.vehicleId))
          .leftJoin(projects, eq(projects.id, accidents.projectId))
          .where(and(accidentScope(a), ...range(accidents.occurredAt, f), opt(!!f.projectId, eq(accidents.projectId, f.projectId!)), opt(!!f.vehicleId, eq(accidents.vehicleId, f.vehicleId!)), opt(!!f.status, sql`${accidents.status} = ${f.status}`)))
          .orderBy(desc(accidents.occurredAt))
          .limit(limit)
      ).map((r) => ({ ...r, label: `ACC-${r.number}` })),
  },
  {
    key: "violations",
    title: "تقرير المخالفات",
    description: "المخالفات المرورية والمبالغ وحالة السداد",
    perms: ["violations.read"],
    statuses: ["OPEN", "PAID", "DISPUTED", "CANCELLED"],
    columns: [
      { key: "violationDate", label: "التاريخ", type: "date" },
      { key: "violationNumber", label: "رقم المخالفة" },
      { key: "plateNumber", label: "المركبة" },
      { key: "projectName", label: "المشروع" },
      { key: "driverName", label: "السائق" },
      { key: "type", label: "النوع" },
      { key: "amount", label: "المبلغ", type: "money" },
      { key: "status", label: "الحالة" },
      { key: "paymentDate", label: "تاريخ السداد", type: "date" },
    ],
    totals: ["amount"],
    run: (a, f, limit) =>
      db
        .select({ violationDate: violations.violationDate, violationNumber: violations.violationNumber, plateNumber: vehicles.plateNumber, projectName: projects.name, driverName: driverNameSql(violations.driverId), type: violations.type, amount: violations.amount, status: violations.status, paymentDate: violations.paymentDate })
        .from(violations)
        .innerJoin(vehicles, eq(vehicles.id, violations.vehicleId))
        .leftJoin(projects, eq(projects.id, violations.projectId))
        .where(and(violationScope(a), ...range(violations.violationDate, f, false), opt(!!f.projectId, eq(violations.projectId, f.projectId!)), opt(!!f.vehicleId, eq(violations.vehicleId, f.vehicleId!)), opt(!!f.status, sql`${violations.status} = ${f.status}`)))
        .orderBy(desc(violations.violationDate))
        .limit(limit),
  },
  {
    key: "invoices",
    title: "تقرير الفواتير",
    description: "الفواتير وحالاتها ومبالغها والتحويلات",
    perms: ["invoices.read"],
    statuses: ["DRAFT", "SUBMITTED", "UNDER_REVIEW", "APPROVED", "REJECTED", "TRANSFER_PENDING", "TRANSFERRED", "PAID", "CANCELLED"],
    columns: [
      { key: "label", label: "الرقم" },
      { key: "invoiceNumber", label: "رقم فاتورة المورد" },
      { key: "invoiceDate", label: "التاريخ", type: "date" },
      { key: "dueDate", label: "الاستحقاق", type: "date" },
      { key: "projectName", label: "المشروع" },
      { key: "vendorName", label: "المورد" },
      { key: "amount", label: "المبلغ", type: "money" },
      { key: "tax", label: "الضريبة", type: "money" },
      { key: "total", label: "الإجمالي", type: "money" },
      { key: "status", label: "الحالة" },
      { key: "transferReference", label: "مرجع التحويل" },
    ],
    totals: ["amount", "tax", "total"],
    run: async (a, f, limit) =>
      (
        await db
          .select({ number: invoices.number, invoiceNumber: invoices.invoiceNumber, invoiceDate: invoices.invoiceDate, dueDate: invoices.dueDate, projectName: projects.name, vendorName: vendors.name, amount: invoices.amount, tax: invoices.tax, total: invoices.total, status: invoices.status, transferReference: sql<string | null>`(select t.reference from invoice_transfers t where t.invoice_id = ${invoices.id})` })
          .from(invoices)
          .innerJoin(projects, eq(projects.id, invoices.projectId))
          .leftJoin(vendors, eq(vendors.id, invoices.vendorId))
          .where(and(invoiceScope(a), ...range(invoices.invoiceDate, f, false), opt(!!f.projectId, eq(invoices.projectId, f.projectId!)), opt(!!f.vehicleId, eq(invoices.vehicleId, f.vehicleId!)), opt(!!f.status, sql`${invoices.status} = ${f.status}`)))
          .orderBy(desc(invoices.invoiceDate))
          .limit(limit)
      ).map((r) => ({ ...r, label: `INV-${r.number}` })),
  },
  {
    key: "expenses",
    title: "تقرير المصروفات",
    description: "المصروفات اليدوية حسب الفئة والحالة",
    perms: ["finance.read"],
    statuses: ["SUBMITTED", "APPROVED", "REJECTED"],
    columns: [
      { key: "expenseDate", label: "التاريخ", type: "date" },
      { key: "projectName", label: "المشروع" },
      { key: "plateNumber", label: "المركبة" },
      { key: "category", label: "الفئة" },
      { key: "vendorName", label: "المورد" },
      { key: "description", label: "الوصف" },
      { key: "amount", label: "المبلغ", type: "money" },
      { key: "status", label: "الحالة" },
    ],
    totals: ["amount"],
    run: (a, f, limit) =>
      db
        .select({ expenseDate: expenses.expenseDate, projectName: projects.name, plateNumber: vehicles.plateNumber, category: expenses.category, vendorName: vendors.name, description: expenses.description, amount: expenses.amount, status: expenses.status })
        .from(expenses)
        .innerJoin(projects, eq(projects.id, expenses.projectId))
        .leftJoin(vehicles, eq(vehicles.id, expenses.vehicleId))
        .leftJoin(vendors, eq(vendors.id, expenses.vendorId))
        .where(and(expenseScope(a), ...range(expenses.expenseDate, f, false), opt(!!f.projectId, eq(expenses.projectId, f.projectId!)), opt(!!f.vehicleId, eq(expenses.vehicleId, f.vehicleId!)), opt(!!f.status, sql`${expenses.status} = ${f.status}`)))
        .orderBy(desc(expenses.expenseDate))
        .limit(limit),
  },
  {
    key: "vehicle-costs",
    title: "تكاليف المركبات",
    description: "إجمالي تكلفة كل مركبة حسب الفئة (وقود، صيانة، تأمين، استمارة، حوادث، مخالفات، أخرى)",
    perms: ["finance.read"],
    columns: [
      { key: "plateNumber", label: "المركبة" },
      { key: "projectName", label: "المشروع" },
      { key: "FUEL", label: "وقود", type: "money" },
      { key: "MAINTENANCE", label: "صيانة", type: "money" },
      { key: "INSURANCE", label: "تأمين", type: "money" },
      { key: "REGISTRATION", label: "استمارة", type: "money" },
      { key: "ACCIDENT", label: "حوادث", type: "money" },
      { key: "VIOLATION", label: "مخالفات", type: "money" },
      { key: "OTHER", label: "أخرى", type: "money" },
      { key: "total", label: "الإجمالي", type: "money" },
    ],
    totals: ["FUEL", "MAINTENANCE", "INSURANCE", "REGISTRATION", "ACCIDENT", "VIOLATION", "OTHER", "total"],
    run: async (a, f, limit) => {
      const cond: SQL[] = [costsScope(a)];
      if (f.from) cond.push(sql`day >= ${f.from}::date`);
      if (f.to) cond.push(sql`day <= ${f.to}::date`);
      if (f.projectId) cond.push(sql`c.project_id = ${f.projectId}::uuid`);
      if (f.vehicleId) cond.push(sql`c.vehicle_id = ${f.vehicleId}::uuid`);
      const r = await db.execute<Record<string, string>>(sql`with ${costsCte(a.orgId, tz())}
        select v.plate_number as "plateNumber", p.name as "projectName",
          ${sql.join(
            ["FUEL", "MAINTENANCE", "INSURANCE", "REGISTRATION", "ACCIDENT", "VIOLATION", "OTHER"].map((k) => sql`coalesce(sum(c.amount) filter (where c.category = ${k}), 0)::numeric(16,2)::text as ${sql.raw(`"${k}"`)}`),
            sql`, `,
          )},
          sum(c.amount)::numeric(16,2)::text as total
        from costs c join vehicles v on v.id = c.vehicle_id left join projects p on p.id = v.project_id
        where ${sql.join(cond.map((c) => sql`(${c})`), sql` and `)}
        group by v.plate_number, p.name order by sum(c.amount) desc limit ${limit}`);
      return r.rows;
    },
  },
  {
    key: "documents-expiry",
    title: "انتهاء المستندات",
    description: "الاستمارات والتأمين ومستندات المركبات ورخص السائقين حسب تاريخ الانتهاء",
    perms: ["vehicle_documents.read"],
    statuses: ["EXPIRED", "EXPIRING_SOON", "ACTIVE"],
    columns: [
      { key: "kind", label: "النوع" },
      { key: "owner", label: "المركبة/السائق" },
      { key: "projectName", label: "المشروع" },
      { key: "number", label: "الرقم" },
      { key: "expiryDate", label: "تاريخ الانتهاء", type: "date" },
      { key: "daysLeft", label: "الأيام المتبقية", type: "number" },
      { key: "status", label: "الحالة" },
    ],
    run: async (a, f, limit) => {
      const t = today();
      const soon = addDays(t, EXPIRING_SOON_DAYS);
      const st = (col: SQL) => sql<string>`case when ${col} < ${t}::date then 'EXPIRED' when ${col} <= ${soon}::date then 'EXPIRING_SOON' else 'ACTIVE' end`;
      const statusCond = (col: SQL) => (f.status ? sql`${st(col)} = ${f.status}` : undefined);
      const dateCond = (col: SQL) => and(f.from ? sql`${col} >= ${f.from}::date` : undefined, f.to ? sql`${col} <= ${f.to}::date` : undefined);
      const days = (col: SQL) => sql<number>`(${col} - ${t}::date)`;
      const out: Record<string, unknown>[] = [];
      const vd = sql`${vehicleDocuments.expiryDate}`;
      out.push(
        ...(await db
          .select({ kind: sql<string>`${vehicleDocuments.documentType}::text`, owner: vehicles.plateNumber, projectName: projects.name, number: vehicleDocuments.documentNumber, expiryDate: vehicleDocuments.expiryDate, daysLeft: days(vd), status: st(vd) })
          .from(vehicleDocuments)
          .innerJoin(vehicles, eq(vehicles.id, vehicleDocuments.vehicleId))
          .leftJoin(projects, eq(projects.id, vehicles.projectId))
          .where(and(vehicleScope(a, "vehicle_documents.read"), isNull(vehicleDocuments.deletedAt), isNull(vehicleDocuments.supersededAt), sql`${vd} is not null`, statusCond(vd), dateCond(vd), opt(!!f.projectId, eq(vehicles.projectId, f.projectId!)), opt(!!f.vehicleId, eq(vehicles.id, f.vehicleId!))))
          .limit(limit)),
      );
      if (a.has("insurance.read")) {
        const ie = sql`${insurancePolicies.expiryDate}`;
        out.push(
          ...(await db
            .select({ kind: sql<string>`'INSURANCE'`, owner: vehicles.plateNumber, projectName: projects.name, number: insurancePolicies.policyNumber, expiryDate: insurancePolicies.expiryDate, daysLeft: days(ie), status: st(ie) })
            .from(insurancePolicies)
            .innerJoin(vehicles, eq(vehicles.id, insurancePolicies.vehicleId))
            .leftJoin(projects, eq(projects.id, vehicles.projectId))
            .where(and(vehicleScope(a, "insurance.read"), isNull(insurancePolicies.supersededAt), statusCond(ie), dateCond(ie), opt(!!f.projectId, eq(vehicles.projectId, f.projectId!)), opt(!!f.vehicleId, eq(vehicles.id, f.vehicleId!))))
            .limit(limit)),
        );
      }
      if (a.has("drivers.read") && !f.vehicleId) {
        const le = sql`${drivers.licenseExpiryDate}`;
        out.push(
          ...(await db
            .select({ kind: sql<string>`'DRIVING_LICENSE'`, owner: employees.fullName, projectName: projects.name, number: drivers.licenseNumber, expiryDate: drivers.licenseExpiryDate, daysLeft: days(le), status: st(le) })
            .from(drivers)
            .innerJoin(employees, eq(employees.id, drivers.employeeId))
            .leftJoin(projects, eq(projects.id, employees.projectId))
            .where(and(driverScope(a, "drivers.read"), isNull(drivers.archivedAt), sql`${le} is not null`, statusCond(le), dateCond(le), opt(!!f.projectId, eq(employees.projectId, f.projectId!))))
            .limit(limit)),
        );
      }
      return out.sort((x, y) => String(x.expiryDate).localeCompare(String(y.expiryDate))).slice(0, limit);
    },
  },
  {
    key: "drivers",
    title: "تقرير السائقين",
    description: "السائقون مع حالة الرخصة والمركبة الحالية وعدد الحوادث والمخالفات",
    perms: ["drivers.read"],
    columns: [
      { key: "fullName", label: "السائق" },
      { key: "projectName", label: "المشروع" },
      { key: "licenseNumber", label: "رقم الرخصة" },
      { key: "licenseExpiryDate", label: "انتهاء الرخصة", type: "date" },
      { key: "status", label: "الحالة" },
      { key: "vehicle", label: "المركبة الحالية" },
      { key: "accidents", label: "الحوادث", type: "number" },
      { key: "violations", label: "المخالفات", type: "number" },
      { key: "violationsAmount", label: "مبالغ المخالفات", type: "money" },
    ],
    totals: ["accidents", "violations", "violationsAmount"],
    run: (a, f, limit) =>
      db
        .select({
          fullName: employees.fullName,
          projectName: projects.name,
          licenseNumber: drivers.licenseNumber,
          licenseExpiryDate: drivers.licenseExpiryDate,
          status: drivers.status,
          vehicle: sql<string | null>`(select v.plate_number from vehicles v where v.assigned_driver_id = ${drivers.id} limit 1)`,
          accidents: sql<number>`(select count(*)::int from accidents x where x.driver_id = ${drivers.id} ${f.from ? sql`and (x.occurred_at at time zone ${tz()})::date >= ${f.from}::date` : sql``} ${f.to ? sql`and (x.occurred_at at time zone ${tz()})::date <= ${f.to}::date` : sql``})`,
          violations: sql<number>`(select count(*)::int from violations x where x.driver_id = ${drivers.id} ${f.from ? sql`and x.violation_date >= ${f.from}::date` : sql``} ${f.to ? sql`and x.violation_date <= ${f.to}::date` : sql``})`,
          violationsAmount: sql<string>`(select coalesce(sum(x.amount), 0)::numeric(14,2)::text from violations x where x.driver_id = ${drivers.id} and x.status <> 'CANCELLED' ${f.from ? sql`and x.violation_date >= ${f.from}::date` : sql``} ${f.to ? sql`and x.violation_date <= ${f.to}::date` : sql``})`,
        })
        .from(drivers)
        .innerJoin(employees, eq(employees.id, drivers.employeeId))
        .leftJoin(projects, eq(projects.id, employees.projectId))
        .where(and(driverScope(a, "drivers.read"), isNull(drivers.archivedAt), opt(!!f.projectId, eq(employees.projectId, f.projectId!))))
        .orderBy(asc(employees.fullName))
        .limit(limit),
  },
  {
    key: "handovers",
    title: "تقرير التسليم والاستلام",
    description: "جلسات تسليم المركبات للسائقين وإرجاعها مع المسافة وملاحظات الضرر",
    perms: ["handover.read"],
    statuses: ["PENDING_HANDOVER", "RETURN_PENDING", "RETURN_COMPLETED", "CLOSED", "CANCELLED"],
    columns: [
      { key: "plateNumber", label: "المركبة" },
      { key: "driverName", label: "السائق" },
      { key: "projectName", label: "المشروع" },
      { key: "status", label: "الحالة" },
      { key: "handoverAt", label: "وقت التسليم", type: "datetime" },
      { key: "returnAt", label: "وقت الإرجاع", type: "datetime" },
      { key: "handoverOdometer", label: "عداد التسليم", type: "number" },
      { key: "returnOdometer", label: "عداد الإرجاع", type: "number" },
      { key: "distance", label: "المسافة (كم)", type: "number" },
      { key: "damagePhotos", label: "صور ضرر عند الإرجاع", type: "number" },
    ],
    totals: ["distance"],
    run: (a, f, limit) =>
      db
        .select({
          plateNumber: vehicles.plateNumber,
          driverName: driverNameSql(handoverSessions.driverId),
          projectName: projects.name,
          status: handoverSessions.status,
          handoverAt: handoverSessions.handoverAt,
          returnAt: handoverSessions.returnAt,
          handoverOdometer: handoverSessions.handoverOdometer,
          returnOdometer: handoverSessions.returnOdometer,
          distance: sql<number | null>`("handover_sessions"."return_odometer" - "handover_sessions"."handover_odometer")`,
          damagePhotos: sql<number>`(select count(*)::int from handover_photos hp where hp.session_id = "handover_sessions"."id" and hp.phase = 'RETURN' and hp.damage)`,
        })
        .from(handoverSessions)
        .innerJoin(vehicles, eq(vehicles.id, handoverSessions.vehicleId))
        .leftJoin(projects, eq(projects.id, handoverSessions.projectId))
        .where(and(handoverScope(a), ...range(handoverSessions.createdAt, f), opt(!!f.projectId, eq(handoverSessions.projectId, f.projectId!)), opt(!!f.vehicleId, eq(handoverSessions.vehicleId, f.vehicleId!)), opt(!!f.status, sql`${handoverSessions.status} = ${f.status}`)))
        .orderBy(desc(handoverSessions.createdAt))
        .limit(limit),
  },
  {
    key: "projects",
    title: "ملخص المشاريع",
    description: "لكل مشروع: المركبات، الميزانية، قيمة العقد، التكاليف، المتبقي، والفواتير المفتوحة",
    perms: ["projects.read"],
    statuses: ["PLANNED", "ACTIVE", "ON_HOLD", "COMPLETED", "ARCHIVED"],
    columns: [
      { key: "code", label: "الرمز" },
      { key: "name", label: "المشروع" },
      { key: "status", label: "الحالة" },
      { key: "vehicles", label: "المركبات", type: "number" },
      { key: "budget", label: "الميزانية", type: "money" },
      { key: "contractValue", label: "قيمة العقد", type: "money" },
      { key: "costs", label: "التكاليف", type: "money" },
      { key: "remaining", label: "المتبقي من الميزانية", type: "money" },
      { key: "openMaintenance", label: "صيانة مفتوحة", type: "number" },
      { key: "openAccidents", label: "حوادث مفتوحة", type: "number" },
    ],
    totals: ["vehicles", "budget", "contractValue", "costs", "remaining"],
    run: async (a, f, limit) => {
      const list = await db
        .select({ id: projects.id, code: projects.code, name: projects.name, status: projects.status, budget: projects.budget, contractValue: projects.contractValue })
        .from(projects)
        .where(and(projectScope(a, "projects.read"), opt(!!f.projectId, eq(projects.id, f.projectId!)), opt(!!f.status, sql`${projects.status} = ${f.status}`)))
        .orderBy(asc(projects.code))
        .limit(limit);
      if (!list.length) return [];
      const ids = list.map((p) => p.id);
      const idArr = sql`array[${sql.join(ids.map((i) => sql`${i}::uuid`), sql`, `)}]::uuid[]`;
      const counts = await db.execute<{ id: string; vehicles: number; open_maintenance: number; open_accidents: number }>(sql`
        select p.id,
          (select count(*)::int from vehicles v where v.project_id = p.id and v.status <> 'ARCHIVED') as vehicles,
          (select count(*)::int from maintenance_requests m where m.project_id = p.id and m.status not in ('CLOSED','REJECTED')) as open_maintenance,
          (select count(*)::int from accidents x where x.project_id = p.id and x.status <> 'CLOSED') as open_accidents
        from projects p where p.id = any(${idArr})`);
      const costMap = new Map<string, string>();
      if (a.has("finance.read")) {
        const c = await db.execute<{ project_id: string; total: string }>(sql`with ${costsCte(a.orgId, tz())}
          select project_id, sum(amount)::numeric(16,2)::text as total from costs
           where project_id = any(${idArr}) and ${costsScope(a)} ${f.from ? sql`and day >= ${f.from}::date` : sql``} ${f.to ? sql`and day <= ${f.to}::date` : sql``}
           group by project_id`);
        for (const r of c.rows) costMap.set(r.project_id, r.total);
      }
      const cm = new Map(counts.rows.map((r) => [r.id, r]));
      return list.map((p) => {
        const costs = a.has("finance.read") ? (costMap.get(p.id) ?? "0.00") : null;
        return {
          code: p.code,
          name: p.name,
          status: p.status,
          vehicles: cm.get(p.id)?.vehicles ?? 0,
          budget: p.budget,
          contractValue: p.contractValue,
          costs,
          remaining: p.budget !== null && costs !== null ? (Number(p.budget) - Number(costs)).toFixed(2) : null,
          openMaintenance: cm.get(p.id)?.open_maintenance ?? 0,
          openAccidents: cm.get(p.id)?.open_accidents ?? 0,
        };
      });
    },
  },
];

export const REPORT_KEYS = REPORTS.map((r) => r.key);

const visible = (a: Access, r: ReportDef) => a.has("reports.read") && r.perms.every((p) => a.has(p));

reportsRouter.get("/reports", requirePermission("reports.read"), (req, res) => {
  const { access } = ctx(req);
  res.json({
    data: REPORTS.filter((r) => visible(access, r)).map((r) => ({ key: r.key, title: r.title, description: r.description, statuses: r.statuses ?? null, columns: r.columns })),
    meta: { canExport: access.has("reports.export") },
  });
});

const Query = z.object({
  from: isoDate.optional(),
  to: isoDate.optional(),
  projectId: uuid.optional(),
  vehicleId: uuid.optional(),
  status: z.string().trim().max(40).optional(),
  format: z.enum(["json", "csv"]).default("json"),
});

const JSON_LIMIT = 1000;
const CSV_LIMIT = 20000;

/** Neutralises spreadsheet formula injection and quotes the cell. */
export function csvCell(v: unknown): string {
  if (v === null || v === undefined) return "";
  let s = v instanceof Date ? v.toISOString() : String(v);
  if (/^[=+\-@\t\r]/.test(s)) s = `'${s}`;
  return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

reportsRouter.get("/reports/:key", requirePermission("reports.read"), async (req, res) => {
  const { access } = ctx(req);
  const def = REPORTS.find((r) => r.key === req.params.key);
  if (!def) throw notFound("التقرير غير موجود");
  if (!visible(access, def)) throw forbidden();
  const q = Query.parse(req.query);
  if (q.from && q.to && q.to < q.from) throw badRequest("تاريخ النهاية قبل تاريخ البداية");
  if (q.status && def.statuses && !def.statuses.includes(q.status)) throw badRequest("حالة غير صالحة لهذا التقرير");
  if (q.status && !def.statuses) throw badRequest("هذا التقرير لا يدعم التصفية بالحالة");
  if (q.format === "csv" && !access.has("reports.export")) throw forbidden("تصدير التقارير يتطلب صلاحية التصدير");
  const limit = q.format === "csv" ? CSV_LIMIT : JSON_LIMIT;
  const rows = await def.run(access, q, limit + 1);
  const truncated = rows.length > limit;
  const data = rows.slice(0, limit);
  const totals = def.totals
    ? Object.fromEntries(def.totals.map((k) => [k, data.every((r) => r[k] === null || r[k] === undefined) ? null : data.reduce((acc, r) => acc + Number(r[k] ?? 0), 0).toFixed(def.columns.find((c) => c.key === k)?.type === "money" ? 2 : 1)]))
    : null;

  if (q.format === "csv") {
    await audit(db, req, { action: "REPORT_EXPORTED", entity: "report", metadata: { report: def.key, rows: data.length, filters: { from: q.from, to: q.to, projectId: q.projectId, vehicleId: q.vehicleId, status: q.status } } });
    const lines = [def.columns.map((c) => csvCell(c.label)).join(","), ...data.map((r) => def.columns.map((c) => csvCell(r[c.key])).join(","))];
    if (totals) lines.push(def.columns.map((c, i) => (i === 0 ? csvCell("الإجمالي") : csvCell(totals[c.key] ?? ""))).join(","));
    res.setHeader("Content-Type", "text/csv; charset=utf-8");
    res.setHeader("Content-Disposition", `attachment; filename="${def.key}-${today()}.csv"`);
    res.send("﻿" + lines.join("\r\n"));
    return;
  }
  res.json({ data, meta: { key: def.key, title: def.title, columns: def.columns, totals, truncated, count: data.length, generatedAt: new Date().toISOString(), filters: q } });
});

