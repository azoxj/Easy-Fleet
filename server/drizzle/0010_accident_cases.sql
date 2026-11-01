CREATE TYPE "public"."accident_assignment_mode" AS ENUM('AUTO', 'MANUAL', 'QUEUE');--> statement-breakpoint
CREATE TYPE "public"."accident_claim_status" AS ENUM('PREPARING', 'FILED', 'PROCESSING', 'APPROVED', 'REJECTED', 'COMPENSATION_RECEIVED');--> statement-breakpoint
CREATE TYPE "public"."accident_officer_stage" AS ENUM('TECHNICAL', 'INSURANCE');--> statement-breakpoint
CREATE TYPE "public"."accident_repair_decision" AS ENUM('REPAIR', 'NOT_REPAIRABLE', 'NOT_NEEDED');--> statement-breakpoint
CREATE TYPE "public"."accident_workflow_stage" AS ENUM('DRAFT', 'AWAITING_TECHNICAL', 'AWAITING_ESTIMATES', 'AWAITING_INSURANCE', 'CLAIM_IN_PROGRESS', 'AWAITING_COMPENSATION_PROOF', 'AWAITING_FINAL_CLOSURE', 'CLOSED', 'RETURNED');--> statement-breakpoint
CREATE TABLE "accident_assignments" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid NOT NULL,
	"accident_id" uuid NOT NULL,
	"stage" "accident_workflow_stage" NOT NULL,
	"assigned_to" uuid,
	"assigned_by" uuid,
	"mode" "accident_assignment_mode" NOT NULL,
	"reason" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "accident_claims" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid NOT NULL,
	"accident_id" uuid NOT NULL,
	"status" "accident_claim_status" DEFAULT 'PREPARING' NOT NULL,
	"claim_number" text,
	"insurer_name" text,
	"claimed_amount" numeric(14, 2),
	"approved_amount" numeric(14, 2),
	"received_amount" numeric(14, 2),
	"rejection_reason" text,
	"filed_at" timestamp with time zone,
	"decided_at" timestamp with time zone,
	"received_at" timestamp with time zone,
	"created_by" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "accident_claims_amounts_ck" CHECK (("accident_claims"."claimed_amount" is null or "accident_claims"."claimed_amount" >= 0) and ("accident_claims"."approved_amount" is null or "accident_claims"."approved_amount" >= 0) and ("accident_claims"."received_amount" is null or "accident_claims"."received_amount" >= 0))
);
--> statement-breakpoint
CREATE TABLE "accident_estimates" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid NOT NULL,
	"accident_id" uuid NOT NULL,
	"vendor_name" text NOT NULL,
	"amount" numeric(14, 2) NOT NULL,
	"notes" text,
	"attachment_id" uuid,
	"selected" boolean DEFAULT false NOT NULL,
	"created_by" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "accident_estimates_amount_ck" CHECK ("accident_estimates"."amount" >= 0)
);
--> statement-breakpoint
CREATE TABLE "accident_settings" (
	"organization_id" uuid PRIMARY KEY NOT NULL,
	"sla_technical_days" integer DEFAULT 3 NOT NULL,
	"sla_estimates_days" integer DEFAULT 5 NOT NULL,
	"sla_insurance_days" integer DEFAULT 7 NOT NULL,
	"sla_closure_days" integer DEFAULT 3 NOT NULL,
	"updated_by" uuid,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "accident_stage_officers" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid NOT NULL,
	"project_id" uuid,
	"stage" "accident_officer_stage" NOT NULL,
	"user_id" uuid NOT NULL,
	"created_by" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "accident_transitions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid NOT NULL,
	"accident_id" uuid NOT NULL,
	"from_stage" "accident_workflow_stage",
	"to_stage" "accident_workflow_stage" NOT NULL,
	"actor_id" uuid,
	"reason" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "accident_attachments" ADD COLUMN "stage" "accident_workflow_stage";--> statement-breakpoint
ALTER TABLE "accident_attachments" ADD COLUMN "superseded_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "accidents" ADD COLUMN "workflow_stage" "accident_workflow_stage";--> statement-breakpoint
ALTER TABLE "accidents" ADD COLUMN "assigned_to" uuid;--> statement-breakpoint
ALTER TABLE "accidents" ADD COLUMN "assigned_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "accidents" ADD COLUMN "assignment_mode" "accident_assignment_mode";--> statement-breakpoint
ALTER TABLE "accidents" ADD COLUMN "reported_by" uuid;--> statement-breakpoint
ALTER TABLE "accidents" ADD COLUMN "returned_to_stage" "accident_workflow_stage";--> statement-breakpoint
ALTER TABLE "accidents" ADD COLUMN "returned_reason" text;--> statement-breakpoint
ALTER TABLE "accidents" ADD COLUMN "returned_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "accidents" ADD COLUMN "returned_by" uuid;--> statement-breakpoint
ALTER TABLE "accidents" ADD COLUMN "repair_decision" "accident_repair_decision";--> statement-breakpoint
ALTER TABLE "accidents" ADD COLUMN "repairable" boolean;--> statement-breakpoint
ALTER TABLE "accidents" ADD COLUMN "damage_description" text;--> statement-breakpoint
ALTER TABLE "accidents" ADD COLUMN "technical_notes" text;--> statement-breakpoint
ALTER TABLE "accidents" ADD COLUMN "stage_entered_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "accidents" ADD COLUMN "closed_by" uuid;--> statement-breakpoint
ALTER TABLE "accident_assignments" ADD CONSTRAINT "accident_assignments_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "accident_assignments" ADD CONSTRAINT "accident_assignments_accident_id_accidents_id_fk" FOREIGN KEY ("accident_id") REFERENCES "public"."accidents"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "accident_assignments" ADD CONSTRAINT "accident_assignments_assigned_to_users_id_fk" FOREIGN KEY ("assigned_to") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "accident_assignments" ADD CONSTRAINT "accident_assignments_assigned_by_users_id_fk" FOREIGN KEY ("assigned_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "accident_claims" ADD CONSTRAINT "accident_claims_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "accident_claims" ADD CONSTRAINT "accident_claims_accident_id_accidents_id_fk" FOREIGN KEY ("accident_id") REFERENCES "public"."accidents"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "accident_claims" ADD CONSTRAINT "accident_claims_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "accident_estimates" ADD CONSTRAINT "accident_estimates_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "accident_estimates" ADD CONSTRAINT "accident_estimates_accident_id_accidents_id_fk" FOREIGN KEY ("accident_id") REFERENCES "public"."accidents"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "accident_estimates" ADD CONSTRAINT "accident_estimates_attachment_id_accident_attachments_id_fk" FOREIGN KEY ("attachment_id") REFERENCES "public"."accident_attachments"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "accident_estimates" ADD CONSTRAINT "accident_estimates_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "accident_settings" ADD CONSTRAINT "accident_settings_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "accident_settings" ADD CONSTRAINT "accident_settings_updated_by_users_id_fk" FOREIGN KEY ("updated_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "accident_stage_officers" ADD CONSTRAINT "accident_stage_officers_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "accident_stage_officers" ADD CONSTRAINT "accident_stage_officers_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "accident_stage_officers" ADD CONSTRAINT "accident_stage_officers_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "accident_stage_officers" ADD CONSTRAINT "accident_stage_officers_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "accident_transitions" ADD CONSTRAINT "accident_transitions_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "accident_transitions" ADD CONSTRAINT "accident_transitions_accident_id_accidents_id_fk" FOREIGN KEY ("accident_id") REFERENCES "public"."accidents"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "accident_transitions" ADD CONSTRAINT "accident_transitions_actor_id_users_id_fk" FOREIGN KEY ("actor_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "accident_assignments_idx" ON "accident_assignments" USING btree ("accident_id","created_at");--> statement-breakpoint
CREATE INDEX "accident_assignments_user_idx" ON "accident_assignments" USING btree ("assigned_to");--> statement-breakpoint
CREATE UNIQUE INDEX "accident_claims_accident_uq" ON "accident_claims" USING btree ("accident_id");--> statement-breakpoint
CREATE INDEX "accident_estimates_idx" ON "accident_estimates" USING btree ("accident_id");--> statement-breakpoint
CREATE UNIQUE INDEX "accident_estimates_one_selected_uq" ON "accident_estimates" USING btree ("accident_id") WHERE "accident_estimates"."selected";--> statement-breakpoint
CREATE UNIQUE INDEX "accident_stage_officers_uq" ON "accident_stage_officers" USING btree ("organization_id",coalesce("project_id", '00000000-0000-0000-0000-000000000000'::uuid),"stage","user_id");--> statement-breakpoint
CREATE INDEX "accident_stage_officers_lookup_idx" ON "accident_stage_officers" USING btree ("organization_id","stage");--> statement-breakpoint
CREATE INDEX "accident_transitions_idx" ON "accident_transitions" USING btree ("accident_id","created_at");--> statement-breakpoint
ALTER TABLE "accidents" ADD CONSTRAINT "accidents_assigned_to_users_id_fk" FOREIGN KEY ("assigned_to") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "accidents" ADD CONSTRAINT "accidents_reported_by_users_id_fk" FOREIGN KEY ("reported_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "accidents" ADD CONSTRAINT "accidents_returned_by_users_id_fk" FOREIGN KEY ("returned_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "accidents" ADD CONSTRAINT "accidents_closed_by_users_id_fk" FOREIGN KEY ("closed_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "accidents_workflow_idx" ON "accidents" USING btree ("organization_id","workflow_stage");--> statement-breakpoint
CREATE INDEX "accidents_assigned_idx" ON "accidents" USING btree ("assigned_to");