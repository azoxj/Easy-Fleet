import { date, index, pgTable, text, timestamp, uuid } from "drizzle-orm/pg-core";
import { users } from "./auth.js";
import { assignmentStatus, assignmentType, priority } from "./enums.js";
import { organizations } from "./organizations.js";
import { projects } from "./projects.js";
import { vehicles } from "./vehicles.js";

/**
 * A unit of work handed to a user. An assignment NEVER grants a permission by
 * itself: it only widens the *record set* of a permission the user's role
 * already holds with scope ASSIGNED, and only while the referenced record is
 * still inside the assignment's project.
 */
export const assignments = pgTable(
  "assignments",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    organizationId: uuid("organization_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "restrict" }),
    type: assignmentType("type").notNull(),
    assignedTo: uuid("assigned_to")
      .notNull()
      .references(() => users.id, { onDelete: "restrict" }),
    assignedBy: uuid("assigned_by")
      .notNull()
      .references(() => users.id, { onDelete: "restrict" }),
    projectId: uuid("project_id").references(() => projects.id, { onDelete: "restrict" }),
    vehicleId: uuid("vehicle_id").references(() => vehicles.id, { onDelete: "restrict" }),
    /** Id of the referenced entity (project, vehicle, maintenance request, ...). */
    referenceId: uuid("reference_id"),
    title: text("title").notNull(),
    description: text("description"),
    priority: priority("priority").notNull().default("MEDIUM"),
    status: assignmentStatus("status").notNull().default("PENDING"),
    dueDate: date("due_date"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
    completedAt: timestamp("completed_at", { withTimezone: true }),
  },
  (t) => [
    index("assignments_assignee_status_idx").on(t.assignedTo, t.status),
    index("assignments_type_ref_idx").on(t.type, t.referenceId),
    index("assignments_project_idx").on(t.projectId),
    index("assignments_vehicle_idx").on(t.vehicleId),
    index("assignments_org_idx").on(t.organizationId),
  ],
);
