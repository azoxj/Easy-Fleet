import { sql } from "drizzle-orm";
import { bigserial, check, date, index, numeric, pgTable, text, timestamp, uniqueIndex, uuid } from "drizzle-orm/pg-core";
import { users } from "./auth.js";
import { files } from "./documents.js";
import { expenseCategory, expenseStatus, invoiceStatus } from "./enums.js";
import { maintenanceRequests, vendors } from "./maintenance.js";
import { organizations } from "./organizations.js";
import { projects } from "./projects.js";
import { vehicles } from "./vehicles.js";

/**
 * Supplier invoices. total = amount + tax (CHECK). Status is driven only by the
 * server-side invoice state machine (modules/finance/invoice-workflow.ts).
 */
export const invoices = pgTable(
  "invoices",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    number: bigserial("number", { mode: "number" }).notNull().unique(),
    organizationId: uuid("organization_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "restrict" }),
    projectId: uuid("project_id")
      .notNull()
      .references(() => projects.id, { onDelete: "restrict" }),
    maintenanceRequestId: uuid("maintenance_request_id").references(() => maintenanceRequests.id, { onDelete: "restrict" }),
    vehicleId: uuid("vehicle_id").references(() => vehicles.id, { onDelete: "restrict" }),
    vendorId: uuid("vendor_id").references(() => vendors.id, { onDelete: "restrict" }),
    invoiceNumber: text("invoice_number"),
    description: text("description"),
    amount: numeric("amount", { precision: 14, scale: 2 }).notNull(),
    tax: numeric("tax", { precision: 14, scale: 2 }).notNull().default("0"),
    total: numeric("total", { precision: 14, scale: 2 }).notNull(),
    invoiceDate: date("invoice_date").notNull(),
    dueDate: date("due_date"),
    status: invoiceStatus("status").notNull().default("DRAFT"),
    fileId: uuid("file_id").references(() => files.id, { onDelete: "set null" }),
    createdBy: uuid("created_by")
      .notNull()
      .references(() => users.id, { onDelete: "restrict" }),
    submittedAt: timestamp("submitted_at", { withTimezone: true }),
    reviewStartedBy: uuid("review_started_by").references(() => users.id, { onDelete: "set null" }),
    approvedBy: uuid("approved_by").references(() => users.id, { onDelete: "set null" }),
    approvedAt: timestamp("approved_at", { withTimezone: true }),
    rejectedBy: uuid("rejected_by").references(() => users.id, { onDelete: "set null" }),
    rejectedAt: timestamp("rejected_at", { withTimezone: true }),
    rejectionReason: text("rejection_reason"),
    cancelledAt: timestamp("cancelled_at", { withTimezone: true }),
    paidAt: timestamp("paid_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    index("invoices_org_status_idx").on(t.organizationId, t.status),
    index("invoices_project_idx").on(t.projectId, t.invoiceDate),
    index("invoices_created_by_idx").on(t.createdBy),
    index("invoices_maintenance_idx").on(t.maintenanceRequestId),
    uniqueIndex("invoices_vendor_number_uq").on(t.organizationId, t.vendorId, t.invoiceNumber).where(sql`${t.invoiceNumber} is not null and ${t.vendorId} is not null`),
    check("invoices_amount_ck", sql`${t.amount} >= 0 and ${t.tax} >= 0`),
    check("invoices_total_ck", sql`${t.total} = ${t.amount} + ${t.tax}`),
    check("invoices_dates_ck", sql`${t.dueDate} is null or ${t.dueDate} >= ${t.invoiceDate}`),
  ],
);

/** Bank transfer recorded by finance; exactly one per invoice, receipt mandatory. */
export const invoiceTransfers = pgTable(
  "invoice_transfers",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    organizationId: uuid("organization_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "restrict" }),
    invoiceId: uuid("invoice_id")
      .notNull()
      .unique()
      .references(() => invoices.id, { onDelete: "restrict" }),
    transferDate: date("transfer_date").notNull(),
    amount: numeric("amount", { precision: 14, scale: 2 }).notNull(),
    bank: text("bank").notNull(),
    reference: text("reference").notNull(),
    receiptFileId: uuid("receipt_file_id")
      .notNull()
      .references(() => files.id, { onDelete: "restrict" }),
    notes: text("notes"),
    createdBy: uuid("created_by")
      .notNull()
      .references(() => users.id, { onDelete: "restrict" }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [check("invoice_transfers_amount_ck", sql`${t.amount} > 0`)],
);

/** Manual project/vehicle expenses (costs not captured by fuel/maintenance/etc.), with approval. */
export const expenses = pgTable(
  "expenses",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    organizationId: uuid("organization_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "restrict" }),
    projectId: uuid("project_id")
      .notNull()
      .references(() => projects.id, { onDelete: "restrict" }),
    vehicleId: uuid("vehicle_id").references(() => vehicles.id, { onDelete: "restrict" }),
    category: expenseCategory("category").notNull(),
    amount: numeric("amount", { precision: 14, scale: 2 }).notNull(),
    expenseDate: date("expense_date").notNull(),
    vendorId: uuid("vendor_id").references(() => vendors.id, { onDelete: "set null" }),
    invoiceId: uuid("invoice_id").references(() => invoices.id, { onDelete: "set null" }),
    description: text("description"),
    receiptFileId: uuid("receipt_file_id").references(() => files.id, { onDelete: "set null" }),
    status: expenseStatus("status").notNull().default("SUBMITTED"),
    createdBy: uuid("created_by")
      .notNull()
      .references(() => users.id, { onDelete: "restrict" }),
    reviewedBy: uuid("reviewed_by").references(() => users.id, { onDelete: "set null" }),
    reviewedAt: timestamp("reviewed_at", { withTimezone: true }),
    reviewReason: text("review_reason"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    index("expenses_project_date_idx").on(t.projectId, t.expenseDate),
    index("expenses_org_status_idx").on(t.organizationId, t.status),
    index("expenses_vehicle_idx").on(t.vehicleId),
    check("expenses_amount_ck", sql`${t.amount} > 0`),
  ],
);
