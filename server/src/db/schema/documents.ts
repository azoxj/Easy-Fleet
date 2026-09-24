import { sql } from "drizzle-orm";
import { check, date, index, integer, numeric, pgTable, text, timestamp, uniqueIndex, uuid } from "drizzle-orm/pg-core";
import { users } from "./auth.js";
import { coverageType, documentType } from "./enums.js";
import { organizations } from "./organizations.js";
import { drivers } from "./people.js";
import { vehicles } from "./vehicles.js";

/**
 * Uploaded file metadata. The bytes live in private storage under
 * storage_key (server-generated, never exposed to clients); access is only
 * through endpoints that authorize the owning record.
 */
export const files = pgTable(
  "files",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    organizationId: uuid("organization_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "restrict" }),
    storageKey: text("storage_key").notNull().unique(),
    originalName: text("original_name").notNull(),
    mimeType: text("mime_type").notNull(),
    sizeBytes: integer("size_bytes").notNull(),
    sha256: text("sha256").notNull(),
    uploadedBy: uuid("uploaded_by").references(() => users.id, { onDelete: "set null" }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index("files_org_idx").on(t.organizationId), check("files_size_ck", sql`${t.sizeBytes} > 0`)],
);

/**
 * Generic vehicle documents. Status (ACTIVE / EXPIRING_SOON / EXPIRED) is NOT
 * stored — it is always computed from expiry_date on the server.
 * A registration is a document of type REGISTRATION; renewing one marks the
 * previous row superseded, and a partial unique index guarantees at most one
 * current registration per vehicle.
 */
export const vehicleDocuments = pgTable(
  "vehicle_documents",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    organizationId: uuid("organization_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "restrict" }),
    vehicleId: uuid("vehicle_id")
      .notNull()
      .references(() => vehicles.id, { onDelete: "restrict" }),
    documentType: documentType("document_type").notNull(),
    documentNumber: text("document_number"),
    issueDate: date("issue_date"),
    expiryDate: date("expiry_date"),
    issuer: text("issuer"),
    fileId: uuid("file_id").references(() => files.id, { onDelete: "set null" }),
    notes: text("notes"),
    supersededAt: timestamp("superseded_at", { withTimezone: true }),
    deletedAt: timestamp("deleted_at", { withTimezone: true }),
    deletedBy: uuid("deleted_by").references(() => users.id, { onDelete: "set null" }),
    createdBy: uuid("created_by").references(() => users.id, { onDelete: "set null" }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    index("vehicle_documents_vehicle_type_idx").on(t.vehicleId, t.documentType),
    index("vehicle_documents_org_expiry_idx").on(t.organizationId, t.expiryDate),
    uniqueIndex("vehicle_documents_one_current_registration_uq")
      .on(t.vehicleId)
      .where(sql`${t.documentType} = 'REGISTRATION' and ${t.supersededAt} is null and ${t.deletedAt} is null`),
    check("vehicle_documents_dates_ck", sql`${t.expiryDate} is null or ${t.issueDate} is null or ${t.expiryDate} >= ${t.issueDate}`),
  ],
);

/** Insurance policies. Status is computed from expiry_date; one current policy per vehicle. */
export const insurancePolicies = pgTable(
  "insurance_policies",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    organizationId: uuid("organization_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "restrict" }),
    vehicleId: uuid("vehicle_id")
      .notNull()
      .references(() => vehicles.id, { onDelete: "restrict" }),
    provider: text("provider").notNull(),
    policyNumber: text("policy_number").notNull(),
    issueDate: date("issue_date"),
    expiryDate: date("expiry_date").notNull(),
    premiumAmount: numeric("premium_amount", { precision: 14, scale: 2 }),
    coverageType: coverageType("coverage_type").notNull(),
    fileId: uuid("file_id").references(() => files.id, { onDelete: "set null" }),
    notes: text("notes"),
    supersededAt: timestamp("superseded_at", { withTimezone: true }),
    createdBy: uuid("created_by").references(() => users.id, { onDelete: "set null" }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    index("insurance_vehicle_idx").on(t.vehicleId),
    index("insurance_org_expiry_idx").on(t.organizationId, t.expiryDate),
    uniqueIndex("insurance_org_provider_policy_uq").on(t.organizationId, t.provider, t.policyNumber),
    uniqueIndex("insurance_one_current_per_vehicle_uq").on(t.vehicleId).where(sql`${t.supersededAt} is null`),
    check("insurance_dates_ck", sql`${t.issueDate} is null or ${t.expiryDate} >= ${t.issueDate}`),
    check("insurance_premium_ck", sql`${t.premiumAmount} is null or ${t.premiumAmount} >= 0`),
  ],
);

/**
 * History of which driver held which vehicle. vehicles.assigned_driver_id is the
 * "current" pointer; this table keeps the full history. Partial unique indexes
 * ensure a vehicle has one current driver and a driver has one current vehicle.
 */
export const vehicleDriverHistory = pgTable(
  "vehicle_driver_history",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    organizationId: uuid("organization_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "restrict" }),
    vehicleId: uuid("vehicle_id")
      .notNull()
      .references(() => vehicles.id, { onDelete: "restrict" }),
    driverId: uuid("driver_id")
      .notNull()
      .references(() => drivers.id, { onDelete: "restrict" }),
    assignedBy: uuid("assigned_by").references(() => users.id, { onDelete: "set null" }),
    assignedAt: timestamp("assigned_at", { withTimezone: true }).notNull().defaultNow(),
    unassignedBy: uuid("unassigned_by").references(() => users.id, { onDelete: "set null" }),
    unassignedAt: timestamp("unassigned_at", { withTimezone: true }),
  },
  (t) => [
    index("vdh_driver_idx").on(t.driverId, t.assignedAt),
    index("vdh_vehicle_idx").on(t.vehicleId, t.assignedAt),
    uniqueIndex("vdh_one_current_per_vehicle_uq").on(t.vehicleId).where(sql`${t.unassignedAt} is null`),
    uniqueIndex("vdh_one_current_per_driver_uq").on(t.driverId).where(sql`${t.unassignedAt} is null`),
  ],
);
