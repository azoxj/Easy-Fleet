-- Email notifications + password reset: password_reset_tokens (hashed, single-use, expiring), email_log
-- (outbox + delivery log, no secrets), email_settings (per organization, encrypted SMTP password),
-- notification_preferences.email_enabled and the vehicle service schedule (next service / oil change).
-- Additive only: no existing column, table, constraint or data is changed or dropped.
CREATE TYPE "public"."email_status" AS ENUM('QUEUED', 'SENDING', 'SENT', 'FAILED', 'SKIPPED');--> statement-breakpoint
CREATE TYPE "public"."smtp_security" AS ENUM('TLS', 'STARTTLS', 'NONE');--> statement-breakpoint
CREATE TABLE "email_log" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid,
	"user_id" uuid,
	"recipient" text NOT NULL,
	"type" text NOT NULL,
	"category" "notification_category",
	"subject" text NOT NULL,
	"status" "email_status" DEFAULT 'QUEUED' NOT NULL,
	"payload" jsonb,
	"attempts" integer DEFAULT 0 NOT NULL,
	"next_attempt_at" timestamp with time zone DEFAULT now() NOT NULL,
	"failure_reason" text,
	"provider_message_id" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"sent_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "email_settings" (
	"organization_id" uuid PRIMARY KEY NOT NULL,
	"smtp_host" text,
	"smtp_port" integer,
	"smtp_user" text,
	"smtp_password_enc" text,
	"smtp_security" "smtp_security",
	"from_name" text,
	"from_email" text,
	"support_email" text,
	"notifications_enabled" boolean DEFAULT true NOT NULL,
	"categories" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"updated_by" uuid,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "email_settings_port_ck" CHECK ("email_settings"."smtp_port" is null or ("email_settings"."smtp_port" between 1 and 65535))
);
--> statement-breakpoint
CREATE TABLE "password_reset_tokens" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid NOT NULL,
	"token_hash" text NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"used_at" timestamp with time zone,
	"requested_ip" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "password_reset_tokens_token_hash_unique" UNIQUE("token_hash")
);
--> statement-breakpoint
ALTER TABLE "vehicles" ADD COLUMN "next_service_date" date;--> statement-breakpoint
ALTER TABLE "vehicles" ADD COLUMN "next_service_odometer" integer;--> statement-breakpoint
ALTER TABLE "vehicles" ADD COLUMN "next_oil_change_date" date;--> statement-breakpoint
ALTER TABLE "vehicles" ADD COLUMN "next_oil_change_odometer" integer;--> statement-breakpoint
ALTER TABLE "notification_preferences" ADD COLUMN "email_enabled" boolean DEFAULT true NOT NULL;--> statement-breakpoint
ALTER TABLE "email_log" ADD CONSTRAINT "email_log_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "email_log" ADD CONSTRAINT "email_log_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "email_settings" ADD CONSTRAINT "email_settings_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "email_settings" ADD CONSTRAINT "email_settings_updated_by_users_id_fk" FOREIGN KEY ("updated_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "password_reset_tokens" ADD CONSTRAINT "password_reset_tokens_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "email_log_org_created_idx" ON "email_log" USING btree ("organization_id","created_at");--> statement-breakpoint
CREATE INDEX "email_log_queue_idx" ON "email_log" USING btree ("status","next_attempt_at");--> statement-breakpoint
CREATE INDEX "password_reset_tokens_user_idx" ON "password_reset_tokens" USING btree ("user_id");--> statement-breakpoint
ALTER TABLE "vehicles" ADD CONSTRAINT "vehicles_service_odo_ck" CHECK (("vehicles"."next_service_odometer" is null or "vehicles"."next_service_odometer" >= 0) and ("vehicles"."next_oil_change_odometer" is null or "vehicles"."next_oil_change_odometer" >= 0));