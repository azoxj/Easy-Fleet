import { sql } from "drizzle-orm";
import {
  check,
  date,
  index,
  numeric,
  pgTable,
  primaryKey,
  text,
  timestamp,
  unique,
  uuid,
} from "drizzle-orm/pg-core";
import { users } from "./auth.js";
import { projectStatus } from "./enums.js";
import { organizations } from "./organizations.js";

export const projects = pgTable(
  "projects",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    organizationId: uuid("organization_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "restrict" }),
    name: text("name").notNull(),
    code: text("code").notNull(),
    description: text("description"),
    managerId: uuid("manager_id").references(() => users.id, { onDelete: "set null" }),
    status: projectStatus("status").notNull().default("PLANNED"),
    startDate: date("start_date"),
    endDate: date("end_date"),
    budget: numeric("budget", { precision: 14, scale: 2 }),
    createdBy: uuid("created_by").references(() => users.id, { onDelete: "set null" }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    unique("projects_org_code_uq").on(t.organizationId, t.code),
    index("projects_org_idx").on(t.organizationId),
    index("projects_manager_idx").on(t.managerId),
    check("projects_budget_ck", sql`${t.budget} is null or ${t.budget} >= 0`),
    check("projects_dates_ck", sql`${t.endDate} is null or ${t.startDate} is null or ${t.endDate} >= ${t.startDate}`),
  ],
);

/** Project membership = the user's PROJECT scope. */
export const projectUsers = pgTable(
  "project_users",
  {
    projectId: uuid("project_id")
      .notNull()
      .references(() => projects.id, { onDelete: "cascade" }),
    userId: uuid("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    addedBy: uuid("added_by").references(() => users.id, { onDelete: "set null" }),
    addedAt: timestamp("added_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    primaryKey({ columns: [t.projectId, t.userId] }),
    index("project_users_user_idx").on(t.userId),
  ],
);
