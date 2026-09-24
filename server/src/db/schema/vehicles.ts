import { sql } from "drizzle-orm";
import {
  check,
  date,
  index,
  integer,
  numeric,
  pgTable,
  text,
  timestamp,
  unique,
  uuid,
} from "drizzle-orm/pg-core";
import { users } from "./auth.js";
import { vehicleStatus } from "./enums.js";
import { organizations } from "./organizations.js";
import { drivers } from "./people.js";
import { projects } from "./projects.js";

export const vehicles = pgTable(
  "vehicles",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    organizationId: uuid("organization_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "restrict" }),
    plateNumber: text("plate_number").notNull(),
    vehicleNumber: text("vehicle_number"),
    make: text("make").notNull(),
    model: text("model").notNull(),
    year: integer("year"),
    color: text("color"),
    vin: text("vin"),
    currentOdometer: integer("current_odometer").notNull().default(0),
    status: vehicleStatus("status").notNull().default("AVAILABLE"),
    projectId: uuid("project_id").references(() => projects.id, { onDelete: "set null" }),
    assignedDriverId: uuid("assigned_driver_id").references(() => drivers.id, {
      onDelete: "set null",
    }),
    purchaseDate: date("purchase_date"),
    purchasePrice: numeric("purchase_price", { precision: 14, scale: 2 }),
    warrantyStart: date("warranty_start"),
    warrantyEnd: date("warranty_end"),
    notes: text("notes"),
    archivedAt: timestamp("archived_at", { withTimezone: true }),
    createdBy: uuid("created_by").references(() => users.id, { onDelete: "set null" }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    unique("vehicles_org_plate_uq").on(t.organizationId, t.plateNumber),
    unique("vehicles_org_number_uq").on(t.organizationId, t.vehicleNumber),
    unique("vehicles_org_vin_uq").on(t.organizationId, t.vin),
    index("vehicles_org_status_idx").on(t.organizationId, t.status),
    index("vehicles_project_idx").on(t.projectId),
    index("vehicles_driver_idx").on(t.assignedDriverId),
    check("vehicles_odometer_ck", sql`${t.currentOdometer} >= 0`),
    check("vehicles_price_ck", sql`${t.purchasePrice} is null or ${t.purchasePrice} >= 0`),
    check("vehicles_warranty_ck", sql`${t.warrantyEnd} is null or ${t.warrantyStart} is null or ${t.warrantyEnd} >= ${t.warrantyStart}`),
  ],
);
