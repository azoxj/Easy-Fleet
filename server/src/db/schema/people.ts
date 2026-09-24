import { sql } from "drizzle-orm";
import { check, date, index, pgTable, text, timestamp, unique, uniqueIndex, uuid } from "drizzle-orm/pg-core";
import { users } from "./auth.js";
import { driverStatus, employeeStatus, licenseType } from "./enums.js";
import { organizations } from "./organizations.js";
import { projects } from "./projects.js";

/**
 * Employees are HR records and are NOT necessarily system users.
 * user_id links an employee to a login account only when one exists.
 */
export const employees = pgTable(
  "employees",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    organizationId: uuid("organization_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "restrict" }),
    employeeNumber: text("employee_number").notNull(),
    fullName: text("full_name").notNull(),
    /** National ID / Iqama. Sensitive: never returned by list/search endpoints. */
    nationalId: text("national_id"),
    phone: text("phone"),
    email: text("email"),
    jobTitle: text("job_title"),
    projectId: uuid("project_id").references(() => projects.id, { onDelete: "set null" }),
    status: employeeStatus("status").notNull().default("ACTIVE"),
    hireDate: date("hire_date"),
    notes: text("notes"),
    userId: uuid("user_id")
      .unique()
      .references(() => users.id, { onDelete: "set null" }),
    createdBy: uuid("created_by").references(() => users.id, { onDelete: "set null" }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    unique("employees_org_number_uq").on(t.organizationId, t.employeeNumber),
    unique("employees_org_national_id_uq").on(t.organizationId, t.nationalId),
    index("employees_project_idx").on(t.projectId),
    index("employees_org_status_idx").on(t.organizationId, t.status),
  ],
);

/** A driver profile always belongs to exactly one employee (never the reverse). */
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
    licenseType: licenseType("license_type"),
    licenseIssueDate: date("license_issue_date"),
    licenseExpiryDate: date("license_expiry_date"),
    status: driverStatus("status").notNull().default("ACTIVE"),
    notes: text("notes"),
    archivedAt: timestamp("archived_at", { withTimezone: true }),
    createdBy: uuid("created_by").references(() => users.id, { onDelete: "set null" }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    index("drivers_org_idx").on(t.organizationId),
    uniqueIndex("drivers_org_license_uq").on(t.organizationId, t.licenseNumber).where(sql`${t.licenseNumber} is not null`),
    index("drivers_license_expiry_idx").on(t.organizationId, t.licenseExpiryDate),
    check(
      "drivers_license_dates_ck",
      sql`${t.licenseExpiryDate} is null or ${t.licenseIssueDate} is null or ${t.licenseExpiryDate} >= ${t.licenseIssueDate}`,
    ),
  ],
);
