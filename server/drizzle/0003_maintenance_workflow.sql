-- Sprint 2 / Part 2: maintenance workflow — vendors, maintenance requests, parts, labor,
-- quotes, attachments and the append-only maintenance_events history.
-- Additive only: no existing table or migration is modified.
CREATE TYPE "public"."maintenance_attachment_category" AS ENUM('DAMAGE_PHOTO', 'INSPECTION_REPORT', 'QUOTE', 'INVOICE', 'REPAIR_PHOTO', 'OTHER');--> statement-breakpoint
CREATE TYPE "public"."maintenance_priority" AS ENUM('LOW', 'MEDIUM', 'HIGH', 'CRITICAL');--> statement-breakpoint
CREATE TYPE "public"."maintenance_status" AS ENUM('REQUESTED', 'INSPECTION', 'QUOTE_PENDING', 'PENDING_APPROVAL', 'APPROVED', 'IN_REPAIR', 'READY_FOR_HANDOVER', 'ACCEPTED', 'REJECTED', 'CLOSED');--> statement-breakpoint
CREATE TYPE "public"."maintenance_quote_status" AS ENUM('DRAFT', 'SUBMITTED', 'UNDER_REVIEW', 'APPROVED', 'REJECTED');--> statement-breakpoint
CREATE TYPE "public"."vendor_status" AS ENUM('ACTIVE', 'INACTIVE');--> statement-breakpoint
CREATE TABLE "maintenance_attachments" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid NOT NULL,
	"maintenance_request_id" uuid NOT NULL,
	"file_id" uuid NOT NULL,
	"category" "maintenance_attachment_category" DEFAULT 'OTHER' NOT NULL,
	"notes" text,
	"uploaded_by" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "maintenance_events" (
	"id" bigserial PRIMARY KEY NOT NULL,
	"organization_id" uuid NOT NULL,
	"maintenance_request_id" uuid NOT NULL,
	"type" text NOT NULL,
	"from_status" "maintenance_status",
	"to_status" "maintenance_status",
	"actor_id" uuid,
	"reason" text,
	"metadata" jsonb,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "maintenance_labor" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid NOT NULL,
	"maintenance_request_id" uuid NOT NULL,
	"description" text NOT NULL,
	"hours" numeric(8, 2) NOT NULL,
	"hourly_rate" numeric(14, 2) NOT NULL,
	"total" numeric(16, 2) NOT NULL,
	"created_by" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "mlabor_hours_ck" CHECK ("maintenance_labor"."hours" > 0),
	CONSTRAINT "mlabor_rate_ck" CHECK ("maintenance_labor"."hourly_rate" >= 0),
	CONSTRAINT "mlabor_total_ck" CHECK ("maintenance_labor"."total" = round("maintenance_labor"."hours" * "maintenance_labor"."hourly_rate", 2))
);
--> statement-breakpoint
CREATE TABLE "maintenance_parts" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid NOT NULL,
	"maintenance_request_id" uuid NOT NULL,
	"part_name" text NOT NULL,
	"part_number" text,
	"quantity" numeric(10, 2) NOT NULL,
	"unit_price" numeric(14, 2) NOT NULL,
	"total" numeric(16, 2) NOT NULL,
	"vendor_id" uuid,
	"notes" text,
	"created_by" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "mparts_quantity_ck" CHECK ("maintenance_parts"."quantity" > 0),
	CONSTRAINT "mparts_price_ck" CHECK ("maintenance_parts"."unit_price" >= 0),
	CONSTRAINT "mparts_total_ck" CHECK ("maintenance_parts"."total" = round("maintenance_parts"."quantity" * "maintenance_parts"."unit_price", 2))
);
--> statement-breakpoint
CREATE TABLE "maintenance_quotes" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid NOT NULL,
	"maintenance_request_id" uuid NOT NULL,
	"vendor_id" uuid,
	"quote_number" text,
	"amount" numeric(14, 2) NOT NULL,
	"valid_until" date,
	"attachment_file_id" uuid,
	"notes" text,
	"status" "maintenance_quote_status" DEFAULT 'DRAFT' NOT NULL,
	"created_by" uuid NOT NULL,
	"submitted_at" timestamp with time zone,
	"reviewed_by" uuid,
	"reviewed_at" timestamp with time zone,
	"review_reason" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "mquotes_amount_ck" CHECK ("maintenance_quotes"."amount" >= 0)
);
--> statement-breakpoint
CREATE TABLE "maintenance_requests" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"number" bigserial NOT NULL,
	"organization_id" uuid NOT NULL,
	"vehicle_id" uuid NOT NULL,
	"project_id" uuid,
	"requested_by" uuid NOT NULL,
	"assigned_to" uuid,
	"issue" text NOT NULL,
	"description" text,
	"priority" "maintenance_priority" DEFAULT 'MEDIUM' NOT NULL,
	"status" "maintenance_status" DEFAULT 'REQUESTED' NOT NULL,
	"odometer" integer,
	"diagnosis" text,
	"work_performed" text,
	"notes" text,
	"rejection_reason" text,
	"handover_rejections" integer DEFAULT 0 NOT NULL,
	"vehicle_status_before" "vehicle_status",
	"assigned_at" timestamp with time zone,
	"inspection_started_at" timestamp with time zone,
	"approved_at" timestamp with time zone,
	"started_at" timestamp with time zone,
	"ready_at" timestamp with time zone,
	"completed_at" timestamp with time zone,
	"closed_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "maintenance_requests_number_unique" UNIQUE("number"),
	CONSTRAINT "mr_odometer_ck" CHECK ("maintenance_requests"."odometer" is null or "maintenance_requests"."odometer" >= 0)
);
--> statement-breakpoint
CREATE TABLE "vendors" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid NOT NULL,
	"name" text NOT NULL,
	"phone" text,
	"email" text,
	"status" "vendor_status" DEFAULT 'ACTIVE' NOT NULL,
	"notes" text,
	"created_by" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "vendors_org_name_uq" UNIQUE("organization_id","name")
);
--> statement-breakpoint
ALTER TABLE "maintenance_attachments" ADD CONSTRAINT "maintenance_attachments_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "maintenance_attachments" ADD CONSTRAINT "maintenance_attachments_maintenance_request_id_maintenance_requests_id_fk" FOREIGN KEY ("maintenance_request_id") REFERENCES "public"."maintenance_requests"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "maintenance_attachments" ADD CONSTRAINT "maintenance_attachments_file_id_files_id_fk" FOREIGN KEY ("file_id") REFERENCES "public"."files"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "maintenance_attachments" ADD CONSTRAINT "maintenance_attachments_uploaded_by_users_id_fk" FOREIGN KEY ("uploaded_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "maintenance_events" ADD CONSTRAINT "maintenance_events_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "maintenance_events" ADD CONSTRAINT "maintenance_events_maintenance_request_id_maintenance_requests_id_fk" FOREIGN KEY ("maintenance_request_id") REFERENCES "public"."maintenance_requests"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "maintenance_events" ADD CONSTRAINT "maintenance_events_actor_id_users_id_fk" FOREIGN KEY ("actor_id") REFERENCES "public"."users"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "maintenance_labor" ADD CONSTRAINT "maintenance_labor_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "maintenance_labor" ADD CONSTRAINT "maintenance_labor_maintenance_request_id_maintenance_requests_id_fk" FOREIGN KEY ("maintenance_request_id") REFERENCES "public"."maintenance_requests"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "maintenance_labor" ADD CONSTRAINT "maintenance_labor_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "maintenance_parts" ADD CONSTRAINT "maintenance_parts_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "maintenance_parts" ADD CONSTRAINT "maintenance_parts_maintenance_request_id_maintenance_requests_id_fk" FOREIGN KEY ("maintenance_request_id") REFERENCES "public"."maintenance_requests"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "maintenance_parts" ADD CONSTRAINT "maintenance_parts_vendor_id_vendors_id_fk" FOREIGN KEY ("vendor_id") REFERENCES "public"."vendors"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "maintenance_parts" ADD CONSTRAINT "maintenance_parts_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "maintenance_quotes" ADD CONSTRAINT "maintenance_quotes_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "maintenance_quotes" ADD CONSTRAINT "maintenance_quotes_maintenance_request_id_maintenance_requests_id_fk" FOREIGN KEY ("maintenance_request_id") REFERENCES "public"."maintenance_requests"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "maintenance_quotes" ADD CONSTRAINT "maintenance_quotes_vendor_id_vendors_id_fk" FOREIGN KEY ("vendor_id") REFERENCES "public"."vendors"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "maintenance_quotes" ADD CONSTRAINT "maintenance_quotes_attachment_file_id_files_id_fk" FOREIGN KEY ("attachment_file_id") REFERENCES "public"."files"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "maintenance_quotes" ADD CONSTRAINT "maintenance_quotes_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "maintenance_quotes" ADD CONSTRAINT "maintenance_quotes_reviewed_by_users_id_fk" FOREIGN KEY ("reviewed_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "maintenance_requests" ADD CONSTRAINT "maintenance_requests_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "maintenance_requests" ADD CONSTRAINT "maintenance_requests_vehicle_id_vehicles_id_fk" FOREIGN KEY ("vehicle_id") REFERENCES "public"."vehicles"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "maintenance_requests" ADD CONSTRAINT "maintenance_requests_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "maintenance_requests" ADD CONSTRAINT "maintenance_requests_requested_by_users_id_fk" FOREIGN KEY ("requested_by") REFERENCES "public"."users"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "maintenance_requests" ADD CONSTRAINT "maintenance_requests_assigned_to_users_id_fk" FOREIGN KEY ("assigned_to") REFERENCES "public"."users"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "vendors" ADD CONSTRAINT "vendors_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "vendors" ADD CONSTRAINT "vendors_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "mattach_request_idx" ON "maintenance_attachments" USING btree ("maintenance_request_id");--> statement-breakpoint
CREATE INDEX "mevents_request_idx" ON "maintenance_events" USING btree ("maintenance_request_id","created_at");--> statement-breakpoint
CREATE INDEX "mlabor_request_idx" ON "maintenance_labor" USING btree ("maintenance_request_id");--> statement-breakpoint
CREATE INDEX "mparts_request_idx" ON "maintenance_parts" USING btree ("maintenance_request_id");--> statement-breakpoint
CREATE INDEX "mquotes_request_idx" ON "maintenance_quotes" USING btree ("maintenance_request_id","status");--> statement-breakpoint
CREATE UNIQUE INDEX "mquotes_one_approved_uq" ON "maintenance_quotes" USING btree ("maintenance_request_id") WHERE "maintenance_quotes"."status" = 'APPROVED';--> statement-breakpoint
CREATE INDEX "mr_org_status_idx" ON "maintenance_requests" USING btree ("organization_id","status");--> statement-breakpoint
CREATE INDEX "mr_project_idx" ON "maintenance_requests" USING btree ("project_id");--> statement-breakpoint
CREATE INDEX "mr_vehicle_idx" ON "maintenance_requests" USING btree ("vehicle_id","created_at");--> statement-breakpoint
CREATE INDEX "mr_assigned_idx" ON "maintenance_requests" USING btree ("assigned_to");--> statement-breakpoint
CREATE INDEX "mr_created_idx" ON "maintenance_requests" USING btree ("organization_id","created_at");--> statement-breakpoint
-- maintenance_events is append-only, like audit_logs (reuses the function from 0001).
CREATE TRIGGER maintenance_events_no_update_delete
  BEFORE UPDATE OR DELETE ON "maintenance_events"
  FOR EACH ROW EXECUTE FUNCTION audit_logs_block_mutation();
--> statement-breakpoint
CREATE TRIGGER maintenance_events_no_truncate
  BEFORE TRUNCATE ON "maintenance_events"
  FOR EACH STATEMENT EXECUTE FUNCTION audit_logs_block_mutation();
