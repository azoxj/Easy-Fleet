import { sql } from "drizzle-orm";
import { bigserial, check, date, index, integer, numeric, pgTable, text, timestamp, uniqueIndex, uuid } from "drizzle-orm/pg-core";
import { users } from "./auth.js";
import { files } from "./documents.js";
import { accidentResponsibility, accidentSeverity, accidentStatus, employeeDocumentType, vehicleStatus, violationStatus } from "./enums.js";
import { maintenanceRequests } from "./maintenance.js";
import { organizations } from "./organizations.js";
import { drivers, employees } from "./people.js";
import { projects } from "./projects.js";
import { vehicles } from "./vehicles.js";

/** Fuel fill-ups. total = round(liters × price_per_liter, 2) enforced by CHECK. */
export const fuelTransactions = pgTable(
  "fuel_transactions",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    organizationId: uuid("organization_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "restrict" }),
    vehicleId: uuid("vehicle_id")
      .notNull()
      .references(() => vehicles.id, { onDelete: "restrict" }),
    driverId: uuid("driver_id").references(() => drivers.id, { onDelete: "set null" }),
    projectId: uuid("project_id").references(() => projects.id, { onDelete: "restrict" }),
    fueledAt: timestamp("fueled_at", { withTimezone: true }).notNull(),
    liters: numeric("liters", { precision: 10, scale: 2 }).notNull(),
    pricePerLiter: numeric("price_per_liter", { precision: 10, scale: 3 }).notNull(),
    total: numeric("total", { precision: 14, scale: 2 }).notNull(),
    station: text("station"),
    odometer: integer("odometer"),
    receiptFileId: uuid("receipt_file_id").references(() => files.id, { onDelete: "set null" }),
    notes: text("notes"),
    createdBy: uuid("created_by")
      .notNull()
      .references(() => users.id, { onDelete: "restrict" }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    index("fuel_vehicle_idx").on(t.vehicleId, t.fueledAt),
    index("fuel_project_idx").on(t.projectId, t.fueledAt),
    check("fuel_liters_ck", sql`${t.liters} > 0`),
    check("fuel_price_ck", sql`${t.pricePerLiter} >= 0`),
    check("fuel_total_ck", sql`${t.total} = round(${t.liters} * ${t.pricePerLiter}, 2)`),
    check("fuel_odometer_ck", sql`${t.odometer} is null or ${t.odometer} >= 0`),
  ],
);

export const accidents = pgTable(
  "accidents",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    number: bigserial("number", { mode: "number" }).notNull().unique(),
    organizationId: uuid("organization_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "restrict" }),
    vehicleId: uuid("vehicle_id")
      .notNull()
      .references(() => vehicles.id, { onDelete: "restrict" }),
    projectId: uuid("project_id").references(() => projects.id, { onDelete: "restrict" }),
    driverId: uuid("driver_id").references(() => drivers.id, { onDelete: "set null" }),
    occurredAt: timestamp("occurred_at", { withTimezone: true }).notNull(),
    location: text("location"),
    latitude: numeric("latitude", { precision: 9, scale: 6 }),
    longitude: numeric("longitude", { precision: 9, scale: 6 }),
    description: text("description").notNull(),
    severity: accidentSeverity("severity").notNull(),
    responsibility: accidentResponsibility("responsibility").notNull().default("UNKNOWN"),
    policeReportNumber: text("police_report_number"),
    insuranceClaimNumber: text("insurance_claim_number"),
    repairCost: numeric("repair_cost", { precision: 14, scale: 2 }),
    status: accidentStatus("status").notNull().default("OPEN"),
    resolution: text("resolution"),
    vehicleStatusBefore: vehicleStatus("vehicle_status_before"),
    maintenanceRequestId: uuid("maintenance_request_id").references(() => maintenanceRequests.id, { onDelete: "set null" }),
    createdBy: uuid("created_by")
      .notNull()
      .references(() => users.id, { onDelete: "restrict" }),
    closedAt: timestamp("closed_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    index("accidents_org_status_idx").on(t.organizationId, t.status),
    index("accidents_project_idx").on(t.projectId, t.occurredAt),
    index("accidents_vehicle_idx").on(t.vehicleId, t.occurredAt),
    check("accidents_cost_ck", sql`${t.repairCost} is null or ${t.repairCost} >= 0`),
    check("accidents_geo_ck", sql`(${t.latitude} is null or ${t.latitude} between -90 and 90) and (${t.longitude} is null or ${t.longitude} between -180 and 180)`),
  ],
);

export const accidentAttachments = pgTable(
  "accident_attachments",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    organizationId: uuid("organization_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "restrict" }),
    accidentId: uuid("accident_id")
      .notNull()
      .references(() => accidents.id, { onDelete: "cascade" }),
    fileId: uuid("file_id")
      .notNull()
      .references(() => files.id, { onDelete: "restrict" }),
    category: text("category").notNull().default("PHOTO"),
    uploadedBy: uuid("uploaded_by").references(() => users.id, { onDelete: "set null" }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index("accident_attachments_idx").on(t.accidentId)],
);

export const violations = pgTable(
  "violations",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    organizationId: uuid("organization_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "restrict" }),
    vehicleId: uuid("vehicle_id")
      .notNull()
      .references(() => vehicles.id, { onDelete: "restrict" }),
    projectId: uuid("project_id").references(() => projects.id, { onDelete: "restrict" }),
    driverId: uuid("driver_id").references(() => drivers.id, { onDelete: "set null" }),
    violationNumber: text("violation_number"),
    violationDate: date("violation_date").notNull(),
    type: text("type").notNull(),
    amount: numeric("amount", { precision: 14, scale: 2 }).notNull(),
    authority: text("authority"),
    status: violationStatus("status").notNull().default("OPEN"),
    paymentDate: date("payment_date"),
    disputeReason: text("dispute_reason"),
    fileId: uuid("file_id").references(() => files.id, { onDelete: "set null" }),
    notes: text("notes"),
    createdBy: uuid("created_by")
      .notNull()
      .references(() => users.id, { onDelete: "restrict" }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    index("violations_org_status_idx").on(t.organizationId, t.status),
    index("violations_project_idx").on(t.projectId, t.violationDate),
    index("violations_vehicle_idx").on(t.vehicleId),
    index("violations_driver_idx").on(t.driverId),
    uniqueIndex("violations_org_number_uq").on(t.organizationId, t.violationNumber).where(sql`${t.violationNumber} is not null`),
    check("violations_amount_ck", sql`${t.amount} >= 0`),
    check("violations_paid_ck", sql`${t.status} <> 'PAID' or ${t.paymentDate} is not null`),
  ],
);

export const employeeDocuments = pgTable(
  "employee_documents",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    organizationId: uuid("organization_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "restrict" }),
    employeeId: uuid("employee_id")
      .notNull()
      .references(() => employees.id, { onDelete: "restrict" }),
    documentType: employeeDocumentType("document_type").notNull(),
    documentNumber: text("document_number"),
    issueDate: date("issue_date"),
    expiryDate: date("expiry_date"),
    fileId: uuid("file_id").references(() => files.id, { onDelete: "set null" }),
    notes: text("notes"),
    deletedAt: timestamp("deleted_at", { withTimezone: true }),
    deletedBy: uuid("deleted_by").references(() => users.id, { onDelete: "set null" }),
    createdBy: uuid("created_by").references(() => users.id, { onDelete: "set null" }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    index("employee_documents_employee_idx").on(t.employeeId),
    index("employee_documents_expiry_idx").on(t.organizationId, t.expiryDate),
    check("employee_documents_dates_ck", sql`${t.expiryDate} is null or ${t.issueDate} is null or ${t.expiryDate} >= ${t.issueDate}`),
  ],
);
