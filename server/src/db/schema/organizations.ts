import { pgTable, text, timestamp, uuid } from "drizzle-orm/pg-core";
import { organizationStatus } from "./enums.js";

/**
 * Tenant root. Phase 1 runs a single organization, but every tenant-owned row
 * already carries organization_id so the system can become multi-tenant later
 * without a data migration of the core model.
 */
export const organizations = pgTable("organizations", {
  id: uuid("id").primaryKey().defaultRandom(),
  name: text("name").notNull(),
  slug: text("slug").notNull().unique(),
  status: organizationStatus("status").notNull().default("ACTIVE"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
});
