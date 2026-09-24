import { sql } from "drizzle-orm";
import {
  bigserial,
  check,
  date,
  index,
  integer,
  jsonb,
  numeric,
  pgTable,
  text,
  timestamp,
  unique,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core";
import { users } from "./auth.js";
import { files } from "./documents.js";
import {
  maintenanceAttachmentCategory,
  maintenancePriority,
  maintenanceStatus,
  quoteStatus,
  vehicleStatus,
  vendorStatus,
} from "./enums.js";
import { organizations } from "./organizations.js";
import { projects } from "./projects.js";
import { vehicles } from "./vehicles.js";

/** Minimal vendor abstraction (workshops / parts suppliers). Org-wide, not project-scoped. */
export const vendors = pgTable(
  "vendors",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    organizationId: uuid("organization_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "restrict" }),
    name: text("name").notNull(),
    phone: text("phone"),
    email: text("email"),
    taxNumber: text("tax_number"),
    address: text("address"),
    status: vendorStatus("status").notNull().default("ACTIVE"),
    notes: text("notes"),
    createdBy: uuid("created_by").references(() => users.id, { onDelete: "set null" }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [unique("vendors_org_name_uq").on(t.organizationId, t.name)],
);

/**
 * Maintenance request. The status is only ever changed by the server-side state
 * machine (modules/maintenance/workflow.ts); project_id is copied from the
 * vehicle at creation and never accepted from the client.
 */
export const maintenanceRequests = pgTable(
  "maintenance_requests",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    /** Human-friendly number shown as MR-<number>. */
    number: bigserial("number", { mode: "number" }).notNull().unique(),
    organizationId: uuid("organization_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "restrict" }),
    vehicleId: uuid("vehicle_id")
      .notNull()
      .references(() => vehicles.id, { onDelete: "restrict" }),
    projectId: uuid("project_id").references(() => projects.id, { onDelete: "restrict" }),
    requestedBy: uuid("requested_by")
      .notNull()
      .references(() => users.id, { onDelete: "restrict" }),
    assignedTo: uuid("assigned_to").references(() => users.id, { onDelete: "restrict" }),
    issue: text("issue").notNull(),
    description: text("description"),
    priority: maintenancePriority("priority").notNull().default("MEDIUM"),
    status: maintenanceStatus("status").notNull().default("REQUESTED"),
    odometer: integer("odometer"),
    diagnosis: text("diagnosis"),
    workPerformed: text("work_performed"),
    notes: text("notes"),
    /** Reason of the last rejection (request rejection or handover rejection). */
    rejectionReason: text("rejection_reason"),
    handoverRejections: integer("handover_rejections").notNull().default(0),
    /** Vehicle status before repair started, used to restore it after handover. */
    vehicleStatusBefore: vehicleStatus("vehicle_status_before"),
    assignedAt: timestamp("assigned_at", { withTimezone: true }),
    inspectionStartedAt: timestamp("inspection_started_at", { withTimezone: true }),
    approvedAt: timestamp("approved_at", { withTimezone: true }),
    startedAt: timestamp("started_at", { withTimezone: true }),
    readyAt: timestamp("ready_at", { withTimezone: true }),
    completedAt: timestamp("completed_at", { withTimezone: true }),
    closedAt: timestamp("closed_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    index("mr_org_status_idx").on(t.organizationId, t.status),
    index("mr_project_idx").on(t.projectId),
    index("mr_vehicle_idx").on(t.vehicleId, t.createdAt),
    index("mr_assigned_idx").on(t.assignedTo),
    index("mr_created_idx").on(t.organizationId, t.createdAt),
    check("mr_odometer_ck", sql`${t.odometer} is null or ${t.odometer} >= 0`),
  ],
);

/** Parts used. total is always computed as round(quantity * unit_price, 2) — enforced by a CHECK. */
export const maintenanceParts = pgTable(
  "maintenance_parts",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    organizationId: uuid("organization_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "restrict" }),
    maintenanceRequestId: uuid("maintenance_request_id")
      .notNull()
      .references(() => maintenanceRequests.id, { onDelete: "cascade" }),
    partName: text("part_name").notNull(),
    partNumber: text("part_number"),
    quantity: numeric("quantity", { precision: 10, scale: 2 }).notNull(),
    unitPrice: numeric("unit_price", { precision: 14, scale: 2 }).notNull(),
    total: numeric("total", { precision: 16, scale: 2 }).notNull(),
    vendorId: uuid("vendor_id").references(() => vendors.id, { onDelete: "set null" }),
    notes: text("notes"),
    createdBy: uuid("created_by").references(() => users.id, { onDelete: "set null" }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    index("mparts_request_idx").on(t.maintenanceRequestId),
    check("mparts_quantity_ck", sql`${t.quantity} > 0`),
    check("mparts_price_ck", sql`${t.unitPrice} >= 0`),
    check("mparts_total_ck", sql`${t.total} = round(${t.quantity} * ${t.unitPrice}, 2)`),
  ],
);

/** Labor. total is always computed as round(hours * hourly_rate, 2) — enforced by a CHECK. */
export const maintenanceLabor = pgTable(
  "maintenance_labor",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    organizationId: uuid("organization_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "restrict" }),
    maintenanceRequestId: uuid("maintenance_request_id")
      .notNull()
      .references(() => maintenanceRequests.id, { onDelete: "cascade" }),
    description: text("description").notNull(),
    hours: numeric("hours", { precision: 8, scale: 2 }).notNull(),
    hourlyRate: numeric("hourly_rate", { precision: 14, scale: 2 }).notNull(),
    total: numeric("total", { precision: 16, scale: 2 }).notNull(),
    createdBy: uuid("created_by").references(() => users.id, { onDelete: "set null" }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    index("mlabor_request_idx").on(t.maintenanceRequestId),
    check("mlabor_hours_ck", sql`${t.hours} > 0`),
    check("mlabor_rate_ck", sql`${t.hourlyRate} >= 0`),
    check("mlabor_total_ck", sql`${t.total} = round(${t.hours} * ${t.hourlyRate}, 2)`),
  ],
);

/** Quotes: DRAFT → SUBMITTED → UNDER_REVIEW → APPROVED / REJECTED. At most one APPROVED per request. */
export const maintenanceQuotes = pgTable(
  "maintenance_quotes",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    organizationId: uuid("organization_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "restrict" }),
    maintenanceRequestId: uuid("maintenance_request_id")
      .notNull()
      .references(() => maintenanceRequests.id, { onDelete: "cascade" }),
    vendorId: uuid("vendor_id").references(() => vendors.id, { onDelete: "set null" }),
    quoteNumber: text("quote_number"),
    amount: numeric("amount", { precision: 14, scale: 2 }).notNull(),
    validUntil: date("valid_until"),
    attachmentFileId: uuid("attachment_file_id").references(() => files.id, { onDelete: "set null" }),
    notes: text("notes"),
    status: quoteStatus("status").notNull().default("DRAFT"),
    createdBy: uuid("created_by")
      .notNull()
      .references(() => users.id, { onDelete: "restrict" }),
    submittedAt: timestamp("submitted_at", { withTimezone: true }),
    reviewedBy: uuid("reviewed_by").references(() => users.id, { onDelete: "set null" }),
    reviewedAt: timestamp("reviewed_at", { withTimezone: true }),
    reviewReason: text("review_reason"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    index("mquotes_request_idx").on(t.maintenanceRequestId, t.status),
    uniqueIndex("mquotes_one_approved_uq").on(t.maintenanceRequestId).where(sql`${t.status} = 'APPROVED'`),
    check("mquotes_amount_ck", sql`${t.amount} >= 0`),
  ],
);

export const maintenanceAttachments = pgTable(
  "maintenance_attachments",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    organizationId: uuid("organization_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "restrict" }),
    maintenanceRequestId: uuid("maintenance_request_id")
      .notNull()
      .references(() => maintenanceRequests.id, { onDelete: "cascade" }),
    fileId: uuid("file_id")
      .notNull()
      .references(() => files.id, { onDelete: "restrict" }),
    category: maintenanceAttachmentCategory("category").notNull().default("OTHER"),
    notes: text("notes"),
    uploadedBy: uuid("uploaded_by").references(() => users.id, { onDelete: "set null" }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index("mattach_request_idx").on(t.maintenanceRequestId)],
);

/**
 * Append-only domain history of a request (status transitions and key actions).
 * Protected by the same trigger as audit_logs (see migration 0003).
 */
export const maintenanceEvents = pgTable(
  "maintenance_events",
  {
    id: bigserial("id", { mode: "number" }).primaryKey(),
    organizationId: uuid("organization_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "restrict" }),
    maintenanceRequestId: uuid("maintenance_request_id")
      .notNull()
      .references(() => maintenanceRequests.id, { onDelete: "restrict" }),
    type: text("type").notNull(),
    fromStatus: maintenanceStatus("from_status"),
    toStatus: maintenanceStatus("to_status"),
    actorId: uuid("actor_id").references(() => users.id, { onDelete: "restrict" }),
    reason: text("reason"),
    metadata: jsonb("metadata").$type<Record<string, unknown>>(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index("mevents_request_idx").on(t.maintenanceRequestId, t.createdAt)],
);
