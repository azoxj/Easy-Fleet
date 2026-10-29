import { sql } from "drizzle-orm";
import { boolean, check, index, integer, numeric, pgTable, text, timestamp, uniqueIndex, uuid } from "drizzle-orm/pg-core";
import { users } from "./auth.js";
import { accidentAssignmentMode, accidentClaimStatus, accidentOfficerStage, accidentWorkflowStage } from "./enums.js";
import { accidentAttachments, accidents } from "./operations.js";
import { organizations } from "./organizations.js";
import { projects } from "./projects.js";

/** Designated officer per stage. project_id NULL = organisation-wide; a project row wins over the organisation row. */
export const accidentStageOfficers = pgTable(
  "accident_stage_officers",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    organizationId: uuid("organization_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "restrict" }),
    projectId: uuid("project_id").references(() => projects.id, { onDelete: "cascade" }),
    stage: accidentOfficerStage("stage").notNull(),
    userId: uuid("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    createdBy: uuid("created_by").references(() => users.id, { onDelete: "set null" }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex("accident_stage_officers_uq").on(t.organizationId, sql`coalesce(${t.projectId}, '00000000-0000-0000-0000-000000000000'::uuid)`, t.stage, t.userId),
    index("accident_stage_officers_lookup_idx").on(t.organizationId, t.stage),
  ],
);

/** Append-only history of every workflow move. */
export const accidentTransitions = pgTable(
  "accident_transitions",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    organizationId: uuid("organization_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "restrict" }),
    accidentId: uuid("accident_id")
      .notNull()
      .references(() => accidents.id, { onDelete: "cascade" }),
    fromStage: accidentWorkflowStage("from_stage"),
    toStage: accidentWorkflowStage("to_stage").notNull(),
    actorId: uuid("actor_id").references(() => users.id, { onDelete: "set null" }),
    reason: text("reason"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index("accident_transitions_idx").on(t.accidentId, t.createdAt)],
);

/** Append-only history of every assignment, queueing and reassignment (assigned_by NULL = the system). */
export const accidentAssignments = pgTable(
  "accident_assignments",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    organizationId: uuid("organization_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "restrict" }),
    accidentId: uuid("accident_id")
      .notNull()
      .references(() => accidents.id, { onDelete: "cascade" }),
    stage: accidentWorkflowStage("stage").notNull(),
    /** NULL when the case was put in the queue. */
    assignedTo: uuid("assigned_to").references(() => users.id, { onDelete: "set null" }),
    assignedBy: uuid("assigned_by").references(() => users.id, { onDelete: "set null" }),
    mode: accidentAssignmentMode("mode").notNull(),
    reason: text("reason"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index("accident_assignments_idx").on(t.accidentId, t.createdAt), index("accident_assignments_user_idx").on(t.assignedTo)],
);

/** Repair estimates collected in the estimates stage (several quotes per accident). */
export const accidentEstimates = pgTable(
  "accident_estimates",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    organizationId: uuid("organization_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "restrict" }),
    accidentId: uuid("accident_id")
      .notNull()
      .references(() => accidents.id, { onDelete: "cascade" }),
    vendorName: text("vendor_name").notNull(),
    amount: numeric("amount", { precision: 14, scale: 2 }).notNull(),
    notes: text("notes"),
    /** The estimate report file (an ESTIMATE attachment of the same accident). */
    attachmentId: uuid("attachment_id").references(() => accidentAttachments.id, { onDelete: "restrict" }),
    selected: boolean("selected").notNull().default(false),
    createdBy: uuid("created_by").references(() => users.id, { onDelete: "set null" }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    index("accident_estimates_idx").on(t.accidentId),
    /** At most one chosen estimate per accident. */
    uniqueIndex("accident_estimates_one_selected_uq").on(t.accidentId).where(sql`${t.selected}`),
    check("accident_estimates_amount_ck", sql`${t.amount} >= 0`),
  ],
);

/** The insurance claim of an accident (one per accident). */
export const accidentClaims = pgTable(
  "accident_claims",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    organizationId: uuid("organization_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "restrict" }),
    accidentId: uuid("accident_id")
      .notNull()
      .references(() => accidents.id, { onDelete: "cascade" }),
    status: accidentClaimStatus("status").notNull().default("PREPARING"),
    claimNumber: text("claim_number"),
    insurerName: text("insurer_name"),
    claimedAmount: numeric("claimed_amount", { precision: 14, scale: 2 }),
    approvedAmount: numeric("approved_amount", { precision: 14, scale: 2 }),
    receivedAmount: numeric("received_amount", { precision: 14, scale: 2 }),
    rejectionReason: text("rejection_reason"),
    filedAt: timestamp("filed_at", { withTimezone: true }),
    decidedAt: timestamp("decided_at", { withTimezone: true }),
    receivedAt: timestamp("received_at", { withTimezone: true }),
    createdBy: uuid("created_by").references(() => users.id, { onDelete: "set null" }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex("accident_claims_accident_uq").on(t.accidentId),
    check("accident_claims_amounts_ck", sql`(${t.claimedAmount} is null or ${t.claimedAmount} >= 0) and (${t.approvedAmount} is null or ${t.approvedAmount} >= 0) and (${t.receivedAmount} is null or ${t.receivedAmount} >= 0)`),
  ],
);

/** SLA settings per organisation, in calendar days. */
export const accidentSettings = pgTable("accident_settings", {
  organizationId: uuid("organization_id")
    .primaryKey()
    .references(() => organizations.id, { onDelete: "cascade" }),
  slaTechnicalDays: integer("sla_technical_days").notNull().default(3),
  slaEstimatesDays: integer("sla_estimates_days").notNull().default(5),
  slaInsuranceDays: integer("sla_insurance_days").notNull().default(7),
  slaClosureDays: integer("sla_closure_days").notNull().default(3),
  updatedBy: uuid("updated_by").references(() => users.id, { onDelete: "set null" }),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
});
