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
import { tr } from "../../i18n/index.js";

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
    get title() { return tr("سجل المركبات"); },
    get description() { return tr("جميع المركبات مع الحالة والمشروع والسائق والعداد وانتهاء الاستمارة والتأمين"); },
    perms: ["vehicles.read"],
    statuses: ["AVAILABLE", "ASSIGNED", "IN_MAINTENANCE", "OUT_OF_SERVICE", "ACCIDENT", "SOLD", "ARCHIVED"],
    columns: [
      { key: "plateNumber", get label() { return tr("اللوحة"); } },
      { key: "plateArabic", get label() { return tr("اللوحة (عربي)"); } },
      { key: "make", get label() { return tr("الشركة"); } },
      { key: "model", get label() { return tr("الطراز"); } },
      { key: "year", get label() { return tr("السنة"); }, type: "number" },
      { key: "status", get label() { return tr("الحالة"); } },
      { key: "projectName", get label() { return tr("المشروع"); } },
      { key: "driverName", get label() { return tr("السائق"); } },
      { key: "currentOdometer", get label() { return tr("العداد"); }, type: "number" },
      { key: "registrationExpiry", get label() { return tr("انتهاء الاستمارة"); }, type: "date" },
      { key: "insuranceExpiry", get label() { return tr("انتهاء التأمين"); }, type: "date" },
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
    get title() { return tr("تقرير الصيانة"); },
    get description() { return tr("طلبات الصيانة مع الحالة والفني والتكلفة ومدة الإنجاز"); },
    perms: ["maintenance.read"],
    statuses: ["REQUESTED", "INSPECTION", "QUOTE_PENDING", "PENDING_APPROVAL", "APPROVED", "IN_REPAIR", "READY_FOR_HANDOVER", "ACCEPTED", "CLOSED", "REJECTED"],
    columns: [
      { key: "label", get label() { return tr("رقم الطلب"); } },
      { key: "plateNumber", get label() { return tr("المركبة"); } },
      { key: "projectName", get label() { return tr("المشروع"); } },
      { key: "issue", get label() { return tr("المشكلة"); } },
      { key: "priority", get label() { return tr("الأولوية"); } },
      { key: "status", get label() { return tr("الحالة"); } },
      { key: "technician", get label() { return tr("الفني"); } },
      { key: "createdAt", get label() { return tr("تاريخ الطلب"); }, type: "datetime" },
      { key: "closedAt", get label() { return tr("تاريخ الإغلاق"); }, type: "datetime" },
      { key: "days", get label() { return tr("المدة (أيام)"); }, type: "number" },
      { key: "partsCost", get label() { return tr("قطع الغيار"); }, type: "money" },
      { key: "laborCost", get label() { return tr("العمالة"); }, type: "money" },
      { key: "totalCost", get label() { return tr("الإجمالي"); }, type: "money" },
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
    get title() { return tr("تقرير الوقود"); },
    get description() { return tr("عمليات تعبئة الوقود واللترات والتكلفة"); },
    perms: ["fuel.read"],
    columns: [
      { key: "fueledAt", get label() { return tr("التاريخ"); }, type: "datetime" },
      { key: "plateNumber", get label() { return tr("المركبة"); } },
      { key: "projectName", get label() { return tr("المشروع"); } },
      { key: "driverName", get label() { return tr("السائق"); } },
      { key: "liters", get label() { return tr("اللترات"); }, type: "number" },
      { key: "pricePerLiter", get label() { return tr("سعر اللتر"); }, type: "money" },
      { key: "total", get label() { return tr("الإجمالي"); }, type: "money" },
      { key: "odometer", get label() { return tr("العداد"); }, type: "number" },
      { key: "station", get label() { return tr("المحطة"); } },
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
    get title() { return tr("تقرير الحوادث"); },
    get description() { return tr("الحوادث مع الخطورة والمسؤولية والحالة وتكلفة الإصلاح"); },
    perms: ["accidents.read"],
    statuses: ["OPEN", "UNDER_REVIEW", "INSURANCE", "REPAIR", "CLOSED"],
    columns: [
      { key: "label", get label() { return tr("الرقم"); } },
      { key: "occurredAt", get label() { return tr("التاريخ"); }, type: "datetime" },
      { key: "plateNumber", get label() { return tr("المركبة"); } },
      { key: "projectName", get label() { return tr("المشروع"); } },
      { key: "driverName", get label() { return tr("السائق"); } },
      { key: "severity", get label() { return tr("الخطورة"); } },
      { key: "responsibility", get label() { return tr("المسؤولية"); } },
      { key: "status", get label() { return tr("الحالة"); } },
      { key: "insuranceClaimNumber", get label() { return tr("رقم المطالبة"); } },
      { key: "repairCost", get label() { return tr("تكلفة الإصلاح"); }, type: "money" },
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
    get title() { return tr("تقرير المخالفات"); },
    get description() { return tr("المخالفات المرورية والمبالغ وحالة السداد"); },
    perms: ["violations.read"],
    statuses: ["OPEN", "PAID", "DISPUTED", "CANCELLED"],
    columns: [
      { key: "violationDate", get label() { return tr("التاريخ"); }, type: "date" },
      { key: "violationNumber", get label() { return tr("رقم المخالفة"); } },
      { key: "plateNumber", get label() { return tr("المركبة"); } },
      { key: "projectName", get label() { return tr("المشروع"); } },
      { key: "driverName", get label() { return tr("السائق"); } },
      { key: "type", get label() { return tr("النوع"); } },
      { key: "amount", get label() { return tr("المبلغ"); }, type: "money" },
      { key: "status", get label() { return tr("الحالة"); } },
      { key: "paymentDate", get label() { return tr("تاريخ السداد"); }, type: "date" },
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
    get title() { return tr("تقرير الفواتير"); },
    get description() { return tr("الفواتير وحالاتها ومبالغها والتحويلات"); },
    perms: ["invoices.read"],
    statuses: ["DRAFT", "SUBMITTED", "UNDER_REVIEW", "APPROVED", "REJECTED", "TRANSFER_PENDING", "TRANSFERRED", "PAID", "CANCELLED"],
    columns: [
      { key: "label", get label() { return tr("الرقم"); } },
      { key: "invoiceNumber", get label() { return tr("رقم فاتورة المورد"); } },
      { key: "invoiceDate", get label() { return tr("التاريخ"); }, type: "date" },
      { key: "dueDate", get label() { return tr("الاستحقاق"); }, type: "date" },
      { key: "projectName", get label() { return tr("المشروع"); } },
      { key: "vendorName", get label() { return tr("المورد"); } },
      { key: "amount", get label() { return tr("المبلغ"); }, type: "money" },
      { key: "tax", get label() { return tr("الضريبة"); }, type: "money" },
      { key: "total", get label() { return tr("الإجمالي"); }, type: "money" },
      { key: "status", get label() { return tr("الحالة"); } },
      { key: "transferReference", get label() { return tr("مرجع التحويل"); } },
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
    get title() { return tr("تقرير المصروفات"); },
    get description() { return tr("المصروفات اليدوية حسب الفئة والحالة"); },
    perms: ["finance.read"],
    statuses: ["SUBMITTED", "APPROVED", "REJECTED"],
    columns: [
      { key: "expenseDate", get label() { return tr("التاريخ"); }, type: "date" },
      { key: "projectName", get label() { return tr("المشروع"); } },
      { key: "plateNumber", get label() { return tr("المركبة"); } },
      { key: "category", get label() { return tr("الفئة"); } },
      { key: "vendorName", get label() { return tr("المورد"); } },
      { key: "description", get label() { return tr("الوصف"); } },
      { key: "amount", get label() { return tr("المبلغ"); }, type: "money" },
      { key: "status", get label() { return tr("الحالة"); } },
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
    get title() { return tr("تكاليف المركبات"); },
    get description() { return tr("إجمالي تكلفة كل مركبة حسب الفئة (وقود، صيانة، تأمين، استمارة، حوادث، مخالفات، أخرى)"); },
    perms: ["finance.read"],
    columns: [
      { key: "plateNumber", get label() { return tr("المركبة"); } },
      { key: "projectName", get label() { return tr("المشروع"); } },
      { key: "FUEL", get label() { return tr("وقود"); }, type: "money" },
      { key: "MAINTENANCE", get label() { return tr("صيانة"); }, type: "money" },
      { key: "INSURANCE", get label() { return tr("تأمين"); }, type: "money" },
      { key: "REGISTRATION", get label() { return tr("استمارة"); }, type: "money" },
      { key: "ACCIDENT", get label() { return tr("حوادث"); }, type: "money" },
      { key: "VIOLATION", get label() { return tr("مخالفات"); }, type: "money" },
      { key: "OTHER", get label() { return tr("أخرى"); }, type: "money" },
      { key: "total", get label() { return tr("الإجمالي"); }, type: "money" },
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
    get title() { return tr("انتهاء المستندات"); },
    get description() { return tr("الاستمارات والتأمين ومستندات المركبات ورخص السائقين حسب تاريخ الانتهاء"); },
    perms: ["vehicle_documents.read"],
    statuses: ["EXPIRED", "EXPIRING_SOON", "ACTIVE"],
    columns: [
      { key: "kind", get label() { return tr("النوع"); } },
      { key: "owner", get label() { return tr("المركبة/السائق"); } },
      { key: "projectName", get label() { return tr("المشروع"); } },
      { key: "number", get label() { return tr("الرقم"); } },
      { key: "expiryDate", get label() { return tr("تاريخ الانتهاء"); }, type: "date" },
      { key: "daysLeft", get label() { return tr("الأيام المتبقية"); }, type: "number" },
      { key: "status", get label() { return tr("الحالة"); } },
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
    get title() { return tr("تقرير السائقين"); },
    get description() { return tr("السائقون مع حالة الرخصة والمركبة الحالية وعدد الحوادث والمخالفات"); },
    perms: ["drivers.read"],
    columns: [
      { key: "fullName", get label() { return tr("السائق"); } },
      { key: "projectName", get label() { return tr("المشروع"); } },
      { key: "licenseNumber", get label() { return tr("رقم الرخصة"); } },
      { key: "licenseExpiryDate", get label() { return tr("انتهاء الرخصة"); }, type: "date" },
      { key: "status", get label() { return tr("الحالة"); } },
      { key: "vehicle", get label() { return tr("المركبة الحالية"); } },
      { key: "accidents", get label() { return tr("الحوادث"); }, type: "number" },
      { key: "violations", get label() { return tr("المخالفات"); }, type: "number" },
      { key: "violationsAmount", get label() { return tr("مبالغ المخالفات"); }, type: "money" },
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
    get title() { return tr("تقرير التسليم والاستلام"); },
    get description() { return tr("جلسات تسليم المركبات للسائقين وإرجاعها مع المسافة وملاحظات الضرر"); },
    perms: ["handover.read"],
    statuses: ["PENDING_HANDOVER", "RETURN_PENDING", "RETURN_COMPLETED", "CLOSED", "CANCELLED"],
    columns: [
      { key: "plateNumber", get label() { return tr("المركبة"); } },
      { key: "driverName", get label() { return tr("السائق"); } },
      { key: "projectName", get label() { return tr("المشروع"); } },
      { key: "status", get label() { return tr("الحالة"); } },
      { key: "handoverAt", get label() { return tr("وقت التسليم"); }, type: "datetime" },
      { key: "returnAt", get label() { return tr("وقت الإرجاع"); }, type: "datetime" },
      { key: "handoverOdometer", get label() { return tr("عداد التسليم"); }, type: "number" },
      { key: "returnOdometer", get label() { return tr("عداد الإرجاع"); }, type: "number" },
      { key: "distance", get label() { return tr("المسافة (كم)"); }, type: "number" },
      { key: "damagePhotos", get label() { return tr("صور ضرر عند الإرجاع"); }, type: "number" },
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
    get title() { return tr("ملخص المشاريع"); },
    get description() { return tr("لكل مشروع: المركبات، الميزانية، قيمة العقد، التكاليف، المتبقي، والفواتير المفتوحة"); },
    perms: ["projects.read"],
    statuses: ["PLANNED", "ACTIVE", "ON_HOLD", "COMPLETED", "ARCHIVED"],
    columns: [
      { key: "code", get label() { return tr("الرمز"); } },
      { key: "name", get label() { return tr("المشروع"); } },
      { key: "status", get label() { return tr("الحالة"); } },
      { key: "vehicles", get label() { return tr("المركبات"); }, type: "number" },
      { key: "budget", get label() { return tr("الميزانية"); }, type: "money" },
      { key: "contractValue", get label() { return tr("قيمة العقد"); }, type: "money" },
      { key: "costs", get label() { return tr("التكاليف"); }, type: "money" },
      { key: "remaining", get label() { return tr("المتبقي من الميزانية"); }, type: "money" },
      { key: "openMaintenance", get label() { return tr("صيانة مفتوحة"); }, type: "number" },
      { key: "openAccidents", get label() { return tr("حوادث مفتوحة"); }, type: "number" },
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
  if (!def) throw notFound(tr("التقرير غير موجود"));
  if (!visible(access, def)) throw forbidden();
  const q = Query.parse(req.query);
  if (q.from && q.to && q.to < q.from) throw badRequest(tr("تاريخ النهاية قبل تاريخ البداية"));
  if (q.status && def.statuses && !def.statuses.includes(q.status)) throw badRequest(tr("حالة غير صالحة لهذا التقرير"));
  if (q.status && !def.statuses) throw badRequest(tr("هذا التقرير لا يدعم التصفية بالحالة"));
  if (q.format === "csv" && !access.has("reports.export")) throw forbidden(tr("تصدير التقارير يتطلب صلاحية التصدير"));
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
    if (totals) lines.push(def.columns.map((c, i) => (i === 0 ? csvCell(tr("الإجمالي")) : csvCell(totals[c.key] ?? ""))).join(","));
    res.setHeader("Content-Type", "text/csv; charset=utf-8");
    res.setHeader("Content-Disposition", `attachment; filename="${def.key}-${today()}.csv"`);
    res.send("﻿" + lines.join("\r\n"));
    return;
  }
  res.json({ data, meta: { key: def.key, title: def.title, columns: def.columns, totals, truncated, count: data.length, generatedAt: new Date().toISOString(), filters: q } });
});

