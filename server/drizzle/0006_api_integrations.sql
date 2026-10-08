-- API integrations (Bright Washing, extensible): integration_settings (per organization + provider, encrypted secrets),
-- integration_sync_runs (sync log) and integration_review_queue (unmatched / ambiguous plates).
-- Additive only: no existing column, table, constraint or data is changed or dropped.
CREATE TYPE "public"."integration_review_reason" AS ENUM('NO_MATCH', 'AMBIGUOUS');--> statement-breakpoint
CREATE TYPE "public"."integration_review_status" AS ENUM('PENDING', 'RESOLVED', 'DISMISSED');--> statement-breakpoint
CREATE TYPE "public"."integration_sync_status" AS ENUM('STARTED', 'COMPLETED', 'FAILED', 'WAITING_FOR_API');--> statement-breakpoint
CREATE TABLE "integration_review_queue" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid NOT NULL,
	"provider" text NOT NULL,
	"sync_run_id" uuid,
	"external_id" text NOT NULL,
	"plate_raw" text,
	"reason" "integration_review_reason" NOT NULL,
	"candidate_vehicle_ids" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"payload" jsonb,
	"status" "integration_review_status" DEFAULT 'PENDING' NOT NULL,
	"resolved_vehicle_id" uuid,
	"resolved_by" uuid,
	"resolved_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "integration_settings" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid NOT NULL,
	"provider" text NOT NULL,
	"enabled" boolean DEFAULT false NOT NULL,
	"base_url" text,
	"client_id" text,
	"api_key_enc" text,
	"client_secret_enc" text,
	"last_test_at" timestamp with time zone,
	"last_test_status" text,
	"last_test_message" text,
	"last_sync_at" timestamp with time zone,
	"updated_by" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "integration_settings_org_provider_uq" UNIQUE("organization_id","provider")
);
--> statement-breakpoint
CREATE TABLE "integration_sync_runs" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid NOT NULL,
	"provider" text NOT NULL,
	"status" "integration_sync_status" DEFAULT 'STARTED' NOT NULL,
	"trigger" text DEFAULT 'MANUAL' NOT NULL,
	"reason_code" text,
	"started_at" timestamp with time zone DEFAULT now() NOT NULL,
	"completed_at" timestamp with time zone,
	"records_processed" integer DEFAULT 0 NOT NULL,
	"records_created" integer DEFAULT 0 NOT NULL,
	"records_updated" integer DEFAULT 0 NOT NULL,
	"records_skipped" integer DEFAULT 0 NOT NULL,
	"error_summary" text,
	"triggered_by" uuid,
	CONSTRAINT "integration_sync_runs_counts_ck" CHECK ("integration_sync_runs"."records_processed" >= 0 and "integration_sync_runs"."records_created" >= 0 and "integration_sync_runs"."records_updated" >= 0 and "integration_sync_runs"."records_skipped" >= 0)
);
--> statement-breakpoint
ALTER TABLE "integration_review_queue" ADD CONSTRAINT "integration_review_queue_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "integration_review_queue" ADD CONSTRAINT "integration_review_queue_sync_run_id_integration_sync_runs_id_fk" FOREIGN KEY ("sync_run_id") REFERENCES "public"."integration_sync_runs"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "integration_review_queue" ADD CONSTRAINT "integration_review_queue_resolved_vehicle_id_vehicles_id_fk" FOREIGN KEY ("resolved_vehicle_id") REFERENCES "public"."vehicles"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "integration_review_queue" ADD CONSTRAINT "integration_review_queue_resolved_by_users_id_fk" FOREIGN KEY ("resolved_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "integration_settings" ADD CONSTRAINT "integration_settings_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "integration_settings" ADD CONSTRAINT "integration_settings_updated_by_users_id_fk" FOREIGN KEY ("updated_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "integration_sync_runs" ADD CONSTRAINT "integration_sync_runs_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "integration_sync_runs" ADD CONSTRAINT "integration_sync_runs_triggered_by_users_id_fk" FOREIGN KEY ("triggered_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "integration_review_org_status_idx" ON "integration_review_queue" USING btree ("organization_id","provider","status","created_at");--> statement-breakpoint
CREATE UNIQUE INDEX "integration_review_pending_uq" ON "integration_review_queue" USING btree ("organization_id","provider","external_id") WHERE "integration_review_queue"."status" = 'PENDING';--> statement-breakpoint
CREATE INDEX "integration_sync_runs_org_started_idx" ON "integration_sync_runs" USING btree ("organization_id","provider","started_at");