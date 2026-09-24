import { date, index, pgTable, text, timestamp, unique, uuid } from "drizzle-orm/pg-core";
import { users } from "./auth.js";
import { driverStatus, employeeStatus } from "./enums.js";
import { organizations } from "./organizations.js";
import { projects } from "./projects.js";

/**
 * Employees are HR records and are NOT necessarily system users.
 * user_id links an employee to a login account only when one exists.
 * (CRUD for employees/drivers is scheduled after Sprint 1; the tables exist now
 * so vehicles can reference drivers with a real foreign key.)
 */
export const employees = pgTable(
  "employees",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    organizationId: uuid("organization_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "restrict" }),
    employeeNumber: text("employee_number").notNull(),
    name: text("name").notNull(),
    phone: text("phone"),
    jobTitle: text("job_title"),
    projectId: uuid("project_id").references(() => projects.id, { onDelete: "set null" }),
    status: employeeStatus("status").notNull().default("ACTIVE"),
    startDate: date("start_date"),
    userId: uuid("user_id")
      .unique()
      .references(() => users.id, { onDelete: "set null" }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    unique("employees_org_number_uq").on(t.organizationId, t.employeeNumber),
    index("employees_project_idx").on(t.projectId),
  ],
);

export const drivers = pgTable(
  "drivers",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    organizationId: uuid("organization_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "restrict" }),
    employeeId: uuid("employee_id")
      .notNull()
      .unique()
      .references(() => employees.id, { onDelete: "restrict" }),
    licenseNumber: text("license_number"),
    licenseExpiry: date("license_expiry"),
    status: driverStatus("status").notNull().default("ACTIVE"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index("drivers_org_idx").on(t.organizationId)],
);
