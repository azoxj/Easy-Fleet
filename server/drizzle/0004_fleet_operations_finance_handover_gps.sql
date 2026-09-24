-- Full operations: invoices/transfers, expenses, fuel, accidents, violations, employee documents,
-- vehicle handover/return (secure links + photos), GPS trips/pings, notification categories/preferences,
-- shared rate-limit counters, audit old/new values, company profile and extra vehicle/vendor fields.
-- Additive only: no existing column, table or migration is changed or dropped.
CREATE TYPE "public"."accident_responsibility" AS ENUM('DRIVER', 'THIRD_PARTY', 'SHARED', 'UNKNOWN');--> statement-breakpoint
CREATE TYPE "public"."accident_severity" AS ENUM('MINOR', 'MODERATE', 'SEVERE', 'CRITICAL');--> statement-breakpoint
CREATE TYPE "public"."accident_status" AS ENUM('OPEN', 'UNDER_REVIEW', 'INSURANCE', 'REPAIR', 'CLOSED');--> statement-breakpoint
CREATE TYPE "public"."employee_document_type" AS ENUM('NATIONAL_ID', 'IQAMA', 'PASSPORT', 'CONTRACT', 'DRIVING_LICENSE', 'OTHER');--> statement-breakpoint
CREATE TYPE "public"."expense_category" AS ENUM('FUEL', 'MAINTENANCE', 'INSURANCE', 'REGISTRATION', 'ACCIDENT', 'VIOLATION', 'OTHER');--> statement-breakpoint
CREATE TYPE "public"."expense_status" AS ENUM('SUBMITTED', 'APPROVED', 'REJECTED');--> statement-breakpoint
CREATE TYPE "public"."handover_phase" AS ENUM('HANDOVER', 'RETURN');--> statement-breakpoint
CREATE TYPE "public"."handover_photo_category" AS ENUM('FRONT', 'REAR', 'LEFT', 'RIGHT', 'INTERIOR', 'ODOMETER', 'TIRES', 'OTHER', 'SIGNATURE');--> statement-breakpoint
CREATE TYPE "public"."handover_status" AS ENUM('PENDING_HANDOVER', 'RETURN_PENDING', 'RETURN_COMPLETED', 'CLOSED', 'CANCELLED');--> statement-breakpoint
CREATE TYPE "public"."invoice_status" AS ENUM('DRAFT', 'SUBMITTED', 'UNDER_REVIEW', 'APPROVED', 'REJECTED', 'TRANSFER_PENDING', 'TRANSFERRED', 'PAID', 'CANCELLED');--> statement-breakpoint
CREATE TYPE "public"."notification_category" AS ENUM('MAINTENANCE', 'FINANCE', 'ASSIGNMENT', 'DOCUMENT_EXPIRY', 'ACCIDENT', 'VIOLATION', 'HANDOVER', 'SYSTEM');--> statement-breakpoint
CREATE TYPE "public"."tracking_source" AS ENUM('WEB', 'NATIVE');--> statement-breakpoint
CREATE TYPE "public"."trip_status" AS ENUM('ACTIVE', 'ENDED');--> statement-breakpoint
CREATE TYPE "public"."violation_status" AS ENUM('OPEN', 'PAID', 'DISPUTED', 'CANCELLED');--> statement-breakpoint
ALTER TYPE "public"."assignment_type" ADD VALUE 'VIOLATION';--> statement-breakpoint
ALTER TYPE "public"."assignment_type" ADD VALUE 'REGISTRATION';--> statement-breakpoint
ALTER TYPE "public"."assignment_type" ADD VALUE 'INSURANCE';--> statement-breakpoint
CREATE TABLE "notification_preferences" (
	"user_id" uuid NOT NULL,
	"category" "notification_category" NOT NULL,
	"enabled" boolean DEFAULT true NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "notification_preferences_user_id_category_pk" PRIMARY KEY("user_id","category")
);
--> statement-breakpoint
CREATE TABLE "rate_limits" (
	"key" text PRIMARY KEY NOT NULL,
	"window_start" timestamp with time zone NOT NULL,
	"count" integer NOT NULL
);
--> statement-breakpoint
CREATE TABLE "expenses" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid NOT NULL,
	"project_id" uuid NOT NULL,
	"vehicle_id" uuid,
	"category" "expense_category" NOT NULL,
	"amount" numeric(14, 2) NOT NULL,
	"expense_date" date NOT NULL,
	"vendor_id" uuid,
	"invoice_id" uuid,
	"description" text,
	"receipt_file_id" uuid,
	"status" "expense_status" DEFAULT 'SUBMITTED' NOT NULL,
	"created_by" uuid NOT NULL,
	"reviewed_by" uuid,
	"reviewed_at" timestamp with time zone,
	"review_reason" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "expenses_amount_ck" CHECK ("expenses"."amount" > 0)
);
--> statement-breakpoint
CREATE TABLE "invoice_transfers" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid NOT NULL,
	"invoice_id" uuid NOT NULL,
	"transfer_date" date NOT NULL,
	"amount" numeric(14, 2) NOT NULL,
	"bank" text NOT NULL,
	"reference" text NOT NULL,
	"receipt_file_id" uuid NOT NULL,
	"notes" text,
	"created_by" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "invoice_transfers_invoice_id_unique" UNIQUE("invoice_id"),
	CONSTRAINT "invoice_transfers_amount_ck" CHECK ("invoice_transfers"."amount" > 0)
);
--> statement-breakpoint
CREATE TABLE "invoices" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"number" bigserial NOT NULL,
	"organization_id" uuid NOT NULL,
	"project_id" uuid NOT NULL,
	"maintenance_request_id" uuid,
	"vehicle_id" uuid,
	"vendor_id" uuid,
	"invoice_number" text,
	"description" text,
	"amount" numeric(14, 2) NOT NULL,
	"tax" numeric(14, 2) DEFAULT '0' NOT NULL,
	"total" numeric(14, 2) NOT NULL,
	"invoice_date" date NOT NULL,
	"due_date" date,
	"status" "invoice_status" DEFAULT 'DRAFT' NOT NULL,
	"file_id" uuid,
	"created_by" uuid NOT NULL,
	"submitted_at" timestamp with time zone,
	"review_started_by" uuid,
	"approved_by" uuid,
	"approved_at" timestamp with time zone,
	"rejected_by" uuid,
	"rejected_at" timestamp with time zone,
	"rejection_reason" text,
	"cancelled_at" timestamp with time zone,
	"paid_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "invoices_number_unique" UNIQUE("number"),
	CONSTRAINT "invoices_amount_ck" CHECK ("invoices"."amount" >= 0 and "invoices"."tax" >= 0),
	CONSTRAINT "invoices_total_ck" CHECK ("invoices"."total" = "invoices"."amount" + "invoices"."tax"),
	CONSTRAINT "invoices_dates_ck" CHECK ("invoices"."due_date" is null or "invoices"."due_date" >= "invoices"."invoice_date")
);
--> statement-breakpoint
CREATE TABLE "accident_attachments" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid NOT NULL,
	"accident_id" uuid NOT NULL,
	"file_id" uuid NOT NULL,
	"category" text DEFAULT 'PHOTO' NOT NULL,
	"uploaded_by" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "accidents" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"number" bigserial NOT NULL,
	"organization_id" uuid NOT NULL,
	"vehicle_id" uuid NOT NULL,
	"project_id" uuid,
	"driver_id" uuid,
	"occurred_at" timestamp with time zone NOT NULL,
	"location" text,
	"latitude" numeric(9, 6),
	"longitude" numeric(9, 6),
	"description" text NOT NULL,
	"severity" "accident_severity" NOT NULL,
	"responsibility" "accident_responsibility" DEFAULT 'UNKNOWN' NOT NULL,
	"police_report_number" text,
	"insurance_claim_number" text,
	"repair_cost" numeric(14, 2),
	"status" "accident_status" DEFAULT 'OPEN' NOT NULL,
	"resolution" text,
	"vehicle_status_before" "vehicle_status",
	"maintenance_request_id" uuid,
	"created_by" uuid NOT NULL,
	"closed_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "accidents_number_unique" UNIQUE("number"),
	CONSTRAINT "accidents_cost_ck" CHECK ("accidents"."repair_cost" is null or "accidents"."repair_cost" >= 0),
	CONSTRAINT "accidents_geo_ck" CHECK (("accidents"."latitude" is null or "accidents"."latitude" between -90 and 90) and ("accidents"."longitude" is null or "accidents"."longitude" between -180 and 180))
);
--> statement-breakpoint
CREATE TABLE "employee_documents" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid NOT NULL,
	"employee_id" uuid NOT NULL,
	"document_type" "employee_document_type" NOT NULL,
	"document_number" text,
	"issue_date" date,
	"expiry_date" date,
	"file_id" uuid,
	"notes" text,
	"deleted_at" timestamp with time zone,
	"deleted_by" uuid,
	"created_by" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "employee_documents_dates_ck" CHECK ("employee_documents"."expiry_date" is null or "employee_documents"."issue_date" is null or "employee_documents"."expiry_date" >= "employee_documents"."issue_date")
);
--> statement-breakpoint
CREATE TABLE "fuel_transactions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid NOT NULL,
	"vehicle_id" uuid NOT NULL,
	"driver_id" uuid,
	"project_id" uuid,
	"fueled_at" timestamp with time zone NOT NULL,
	"liters" numeric(10, 2) NOT NULL,
	"price_per_liter" numeric(10, 3) NOT NULL,
	"total" numeric(14, 2) NOT NULL,
	"station" text,
	"odometer" integer,
	"receipt_file_id" uuid,
	"notes" text,
	"created_by" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "fuel_liters_ck" CHECK ("fuel_transactions"."liters" > 0),
	CONSTRAINT "fuel_price_ck" CHECK ("fuel_transactions"."price_per_liter" >= 0),
	CONSTRAINT "fuel_total_ck" CHECK ("fuel_transactions"."total" = round("fuel_transactions"."liters" * "fuel_transactions"."price_per_liter", 2)),
	CONSTRAINT "fuel_odometer_ck" CHECK ("fuel_transactions"."odometer" is null or "fuel_transactions"."odometer" >= 0)
);
--> statement-breakpoint
CREATE TABLE "violations" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid NOT NULL,
	"vehicle_id" uuid NOT NULL,
	"project_id" uuid,
	"driver_id" uuid,
	"violation_number" text,
	"violation_date" date NOT NULL,
	"type" text NOT NULL,
	"amount" numeric(14, 2) NOT NULL,
	"authority" text,
	"status" "violation_status" DEFAULT 'OPEN' NOT NULL,
	"payment_date" date,
	"dispute_reason" text,
	"file_id" uuid,
	"notes" text,
	"created_by" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "violations_amount_ck" CHECK ("violations"."amount" >= 0),
	CONSTRAINT "violations_paid_ck" CHECK ("violations"."status" <> 'PAID' or "violations"."payment_date" is not null)
);
--> statement-breakpoint
CREATE TABLE "handover_photos" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid NOT NULL,
	"session_id" uuid NOT NULL,
	"phase" "handover_phase" NOT NULL,
	"category" "handover_photo_category" NOT NULL,
	"file_id" uuid NOT NULL,
	"notes" text,
	"damage" boolean DEFAULT false NOT NULL,
	"latitude" numeric(9, 6),
	"longitude" numeric(9, 6),
	"accuracy" numeric(10, 2),
	"captured_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "handover_sessions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid NOT NULL,
	"vehicle_id" uuid NOT NULL,
	"driver_id" uuid NOT NULL,
	"project_id" uuid,
	"created_by" uuid NOT NULL,
	"token_hash" text NOT NULL,
	"status" "handover_status" DEFAULT 'PENDING_HANDOVER' NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"last_access_at" timestamp with time zone,
	"access_count" integer DEFAULT 0 NOT NULL,
	"handover_at" timestamp with time zone,
	"handover_odometer" integer,
	"handover_notes" text,
	"return_at" timestamp with time zone,
	"return_odometer" integer,
	"return_notes" text,
	"closed_at" timestamp with time zone,
	"closed_by" uuid,
	"review_notes" text,
	"cancelled_at" timestamp with time zone,
	"cancel_reason" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "handover_sessions_token_hash_unique" UNIQUE("token_hash"),
	CONSTRAINT "handover_odometers_ck" CHECK ("handover_sessions"."return_odometer" is null or "handover_sessions"."handover_odometer" is null or "handover_sessions"."return_odometer" >= "handover_sessions"."handover_odometer")
);
--> statement-breakpoint
CREATE TABLE "location_pings" (
	"id" bigserial PRIMARY KEY NOT NULL,
	"organization_id" uuid NOT NULL,
	"trip_id" uuid NOT NULL,
	"driver_id" uuid NOT NULL,
	"vehicle_id" uuid NOT NULL,
	"project_id" uuid,
	"latitude" numeric(9, 6) NOT NULL,
	"longitude" numeric(9, 6) NOT NULL,
	"accuracy" numeric(10, 2),
	"speed" numeric(8, 2),
	"heading" numeric(6, 2),
	"recorded_at" timestamp with time zone NOT NULL,
	"received_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "pings_geo_ck" CHECK ("location_pings"."latitude" between -90 and 90 and "location_pings"."longitude" between -180 and 180)
);
--> statement-breakpoint
CREATE TABLE "trips" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid NOT NULL,
	"driver_id" uuid NOT NULL,
	"vehicle_id" uuid NOT NULL,
	"project_id" uuid,
	"user_id" uuid NOT NULL,
	"source" "tracking_source" DEFAULT 'WEB' NOT NULL,
	"status" "trip_status" DEFAULT 'ACTIVE' NOT NULL,
	"started_at" timestamp with time zone DEFAULT now() NOT NULL,
	"ended_at" timestamp with time zone,
	"distance_meters" numeric(12, 1) DEFAULT '0' NOT NULL,
	"point_count" integer DEFAULT 0 NOT NULL,
	"last_point_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "vehicle_locations" (
	"vehicle_id" uuid PRIMARY KEY NOT NULL,
	"organization_id" uuid NOT NULL,
	"driver_id" uuid,
	"trip_id" uuid,
	"latitude" numeric(9, 6) NOT NULL,
	"longitude" numeric(9, 6) NOT NULL,
	"accuracy" numeric(10, 2),
	"speed" numeric(8, 2),
	"heading" numeric(6, 2),
	"recorded_at" timestamp with time zone NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "organizations" ADD COLUMN "legal_name" text;--> statement-breakpoint
ALTER TABLE "organizations" ADD COLUMN "tax_number" text;--> statement-breakpoint
ALTER TABLE "organizations" ADD COLUMN "cr_number" text;--> statement-breakpoint
ALTER TABLE "organizations" ADD COLUMN "address" text;--> statement-breakpoint
ALTER TABLE "organizations" ADD COLUMN "phone" text;--> statement-breakpoint
ALTER TABLE "organizations" ADD COLUMN "email" text;--> statement-breakpoint
ALTER TABLE "organizations" ADD COLUMN "settings" jsonb;--> statement-breakpoint
ALTER TABLE "projects" ADD COLUMN "contract_value" numeric(14, 2);--> statement-breakpoint
ALTER TABLE "vehicles" ADD COLUMN "plate_arabic" text;--> statement-breakpoint
ALTER TABLE "vehicles" ADD COLUMN "plate_english" text;--> statement-breakpoint
ALTER TABLE "vehicles" ADD COLUMN "serial_number" text;--> statement-breakpoint
ALTER TABLE "vehicles" ADD COLUMN "qr_token" text;--> statement-breakpoint
ALTER TABLE "vehicle_documents" ADD COLUMN "fee" numeric(14, 2);--> statement-breakpoint
ALTER TABLE "vendors" ADD COLUMN "tax_number" text;--> statement-breakpoint
ALTER TABLE "vendors" ADD COLUMN "address" text;--> statement-breakpoint
ALTER TABLE "audit_logs" ADD COLUMN "old_value" jsonb;--> statement-breakpoint
ALTER TABLE "audit_logs" ADD COLUMN "new_value" jsonb;--> statement-breakpoint
ALTER TABLE "notifications" ADD COLUMN "category" "notification_category" DEFAULT 'SYSTEM' NOT NULL;--> statement-breakpoint
ALTER TABLE "notifications" ADD COLUMN "dedupe_key" text;--> statement-breakpoint
ALTER TABLE "notification_preferences" ADD CONSTRAINT "notification_preferences_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "expenses" ADD CONSTRAINT "expenses_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "expenses" ADD CONSTRAINT "expenses_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "expenses" ADD CONSTRAINT "expenses_vehicle_id_vehicles_id_fk" FOREIGN KEY ("vehicle_id") REFERENCES "public"."vehicles"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "expenses" ADD CONSTRAINT "expenses_vendor_id_vendors_id_fk" FOREIGN KEY ("vendor_id") REFERENCES "public"."vendors"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "expenses" ADD CONSTRAINT "expenses_invoice_id_invoices_id_fk" FOREIGN KEY ("invoice_id") REFERENCES "public"."invoices"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "expenses" ADD CONSTRAINT "expenses_receipt_file_id_files_id_fk" FOREIGN KEY ("receipt_file_id") REFERENCES "public"."files"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "expenses" ADD CONSTRAINT "expenses_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "expenses" ADD CONSTRAINT "expenses_reviewed_by_users_id_fk" FOREIGN KEY ("reviewed_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "invoice_transfers" ADD CONSTRAINT "invoice_transfers_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "invoice_transfers" ADD CONSTRAINT "invoice_transfers_invoice_id_invoices_id_fk" FOREIGN KEY ("invoice_id") REFERENCES "public"."invoices"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "invoice_transfers" ADD CONSTRAINT "invoice_transfers_receipt_file_id_files_id_fk" FOREIGN KEY ("receipt_file_id") REFERENCES "public"."files"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "invoice_transfers" ADD CONSTRAINT "invoice_transfers_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "invoices" ADD CONSTRAINT "invoices_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "invoices" ADD CONSTRAINT "invoices_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "invoices" ADD CONSTRAINT "invoices_maintenance_request_id_maintenance_requests_id_fk" FOREIGN KEY ("maintenance_request_id") REFERENCES "public"."maintenance_requests"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "invoices" ADD CONSTRAINT "invoices_vehicle_id_vehicles_id_fk" FOREIGN KEY ("vehicle_id") REFERENCES "public"."vehicles"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "invoices" ADD CONSTRAINT "invoices_vendor_id_vendors_id_fk" FOREIGN KEY ("vendor_id") REFERENCES "public"."vendors"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "invoices" ADD CONSTRAINT "invoices_file_id_files_id_fk" FOREIGN KEY ("file_id") REFERENCES "public"."files"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "invoices" ADD CONSTRAINT "invoices_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "invoices" ADD CONSTRAINT "invoices_review_started_by_users_id_fk" FOREIGN KEY ("review_started_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "invoices" ADD CONSTRAINT "invoices_approved_by_users_id_fk" FOREIGN KEY ("approved_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "invoices" ADD CONSTRAINT "invoices_rejected_by_users_id_fk" FOREIGN KEY ("rejected_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "accident_attachments" ADD CONSTRAINT "accident_attachments_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "accident_attachments" ADD CONSTRAINT "accident_attachments_accident_id_accidents_id_fk" FOREIGN KEY ("accident_id") REFERENCES "public"."accidents"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "accident_attachments" ADD CONSTRAINT "accident_attachments_file_id_files_id_fk" FOREIGN KEY ("file_id") REFERENCES "public"."files"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "accident_attachments" ADD CONSTRAINT "accident_attachments_uploaded_by_users_id_fk" FOREIGN KEY ("uploaded_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "accidents" ADD CONSTRAINT "accidents_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "accidents" ADD CONSTRAINT "accidents_vehicle_id_vehicles_id_fk" FOREIGN KEY ("vehicle_id") REFERENCES "public"."vehicles"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "accidents" ADD CONSTRAINT "accidents_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "accidents" ADD CONSTRAINT "accidents_driver_id_drivers_id_fk" FOREIGN KEY ("driver_id") REFERENCES "public"."drivers"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "accidents" ADD CONSTRAINT "accidents_maintenance_request_id_maintenance_requests_id_fk" FOREIGN KEY ("maintenance_request_id") REFERENCES "public"."maintenance_requests"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "accidents" ADD CONSTRAINT "accidents_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "employee_documents" ADD CONSTRAINT "employee_documents_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "employee_documents" ADD CONSTRAINT "employee_documents_employee_id_employees_id_fk" FOREIGN KEY ("employee_id") REFERENCES "public"."employees"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "employee_documents" ADD CONSTRAINT "employee_documents_file_id_files_id_fk" FOREIGN KEY ("file_id") REFERENCES "public"."files"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "employee_documents" ADD CONSTRAINT "employee_documents_deleted_by_users_id_fk" FOREIGN KEY ("deleted_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "employee_documents" ADD CONSTRAINT "employee_documents_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "fuel_transactions" ADD CONSTRAINT "fuel_transactions_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "fuel_transactions" ADD CONSTRAINT "fuel_transactions_vehicle_id_vehicles_id_fk" FOREIGN KEY ("vehicle_id") REFERENCES "public"."vehicles"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "fuel_transactions" ADD CONSTRAINT "fuel_transactions_driver_id_drivers_id_fk" FOREIGN KEY ("driver_id") REFERENCES "public"."drivers"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "fuel_transactions" ADD CONSTRAINT "fuel_transactions_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "fuel_transactions" ADD CONSTRAINT "fuel_transactions_receipt_file_id_files_id_fk" FOREIGN KEY ("receipt_file_id") REFERENCES "public"."files"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "fuel_transactions" ADD CONSTRAINT "fuel_transactions_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "violations" ADD CONSTRAINT "violations_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "violations" ADD CONSTRAINT "violations_vehicle_id_vehicles_id_fk" FOREIGN KEY ("vehicle_id") REFERENCES "public"."vehicles"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "violations" ADD CONSTRAINT "violations_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "violations" ADD CONSTRAINT "violations_driver_id_drivers_id_fk" FOREIGN KEY ("driver_id") REFERENCES "public"."drivers"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "violations" ADD CONSTRAINT "violations_file_id_files_id_fk" FOREIGN KEY ("file_id") REFERENCES "public"."files"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "violations" ADD CONSTRAINT "violations_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "handover_photos" ADD CONSTRAINT "handover_photos_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "handover_photos" ADD CONSTRAINT "handover_photos_session_id_handover_sessions_id_fk" FOREIGN KEY ("session_id") REFERENCES "public"."handover_sessions"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "handover_photos" ADD CONSTRAINT "handover_photos_file_id_files_id_fk" FOREIGN KEY ("file_id") REFERENCES "public"."files"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "handover_sessions" ADD CONSTRAINT "handover_sessions_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "handover_sessions" ADD CONSTRAINT "handover_sessions_vehicle_id_vehicles_id_fk" FOREIGN KEY ("vehicle_id") REFERENCES "public"."vehicles"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "handover_sessions" ADD CONSTRAINT "handover_sessions_driver_id_drivers_id_fk" FOREIGN KEY ("driver_id") REFERENCES "public"."drivers"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "handover_sessions" ADD CONSTRAINT "handover_sessions_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "handover_sessions" ADD CONSTRAINT "handover_sessions_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "handover_sessions" ADD CONSTRAINT "handover_sessions_closed_by_users_id_fk" FOREIGN KEY ("closed_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "location_pings" ADD CONSTRAINT "location_pings_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "location_pings" ADD CONSTRAINT "location_pings_trip_id_trips_id_fk" FOREIGN KEY ("trip_id") REFERENCES "public"."trips"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "trips" ADD CONSTRAINT "trips_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "trips" ADD CONSTRAINT "trips_driver_id_drivers_id_fk" FOREIGN KEY ("driver_id") REFERENCES "public"."drivers"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "trips" ADD CONSTRAINT "trips_vehicle_id_vehicles_id_fk" FOREIGN KEY ("vehicle_id") REFERENCES "public"."vehicles"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "trips" ADD CONSTRAINT "trips_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "trips" ADD CONSTRAINT "trips_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "vehicle_locations" ADD CONSTRAINT "vehicle_locations_vehicle_id_vehicles_id_fk" FOREIGN KEY ("vehicle_id") REFERENCES "public"."vehicles"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "vehicle_locations" ADD CONSTRAINT "vehicle_locations_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "rate_limits_window_idx" ON "rate_limits" USING btree ("window_start");--> statement-breakpoint
CREATE INDEX "expenses_project_date_idx" ON "expenses" USING btree ("project_id","expense_date");--> statement-breakpoint
CREATE INDEX "expenses_org_status_idx" ON "expenses" USING btree ("organization_id","status");--> statement-breakpoint
CREATE INDEX "expenses_vehicle_idx" ON "expenses" USING btree ("vehicle_id");--> statement-breakpoint
CREATE INDEX "invoices_org_status_idx" ON "invoices" USING btree ("organization_id","status");--> statement-breakpoint
CREATE INDEX "invoices_project_idx" ON "invoices" USING btree ("project_id","invoice_date");--> statement-breakpoint
CREATE INDEX "invoices_created_by_idx" ON "invoices" USING btree ("created_by");--> statement-breakpoint
CREATE INDEX "invoices_maintenance_idx" ON "invoices" USING btree ("maintenance_request_id");--> statement-breakpoint
CREATE UNIQUE INDEX "invoices_vendor_number_uq" ON "invoices" USING btree ("organization_id","vendor_id","invoice_number") WHERE "invoices"."invoice_number" is not null and "invoices"."vendor_id" is not null;--> statement-breakpoint
CREATE INDEX "accident_attachments_idx" ON "accident_attachments" USING btree ("accident_id");--> statement-breakpoint
CREATE INDEX "accidents_org_status_idx" ON "accidents" USING btree ("organization_id","status");--> statement-breakpoint
CREATE INDEX "accidents_project_idx" ON "accidents" USING btree ("project_id","occurred_at");--> statement-breakpoint
CREATE INDEX "accidents_vehicle_idx" ON "accidents" USING btree ("vehicle_id","occurred_at");--> statement-breakpoint
CREATE INDEX "employee_documents_employee_idx" ON "employee_documents" USING btree ("employee_id");--> statement-breakpoint
CREATE INDEX "employee_documents_expiry_idx" ON "employee_documents" USING btree ("organization_id","expiry_date");--> statement-breakpoint
CREATE INDEX "fuel_vehicle_idx" ON "fuel_transactions" USING btree ("vehicle_id","fueled_at");--> statement-breakpoint
CREATE INDEX "fuel_project_idx" ON "fuel_transactions" USING btree ("project_id","fueled_at");--> statement-breakpoint
CREATE INDEX "violations_org_status_idx" ON "violations" USING btree ("organization_id","status");--> statement-breakpoint
CREATE INDEX "violations_project_idx" ON "violations" USING btree ("project_id","violation_date");--> statement-breakpoint
CREATE INDEX "violations_vehicle_idx" ON "violations" USING btree ("vehicle_id");--> statement-breakpoint
CREATE INDEX "violations_driver_idx" ON "violations" USING btree ("driver_id");--> statement-breakpoint
CREATE UNIQUE INDEX "violations_org_number_uq" ON "violations" USING btree ("organization_id","violation_number") WHERE "violations"."violation_number" is not null;--> statement-breakpoint
CREATE INDEX "handover_photos_session_idx" ON "handover_photos" USING btree ("session_id","phase");--> statement-breakpoint
CREATE UNIQUE INDEX "handover_photos_slot_uq" ON "handover_photos" USING btree ("session_id","phase","category") WHERE "handover_photos"."category" <> 'OTHER';--> statement-breakpoint
CREATE INDEX "handover_org_status_idx" ON "handover_sessions" USING btree ("organization_id","status");--> statement-breakpoint
CREATE INDEX "handover_vehicle_idx" ON "handover_sessions" USING btree ("vehicle_id","created_at");--> statement-breakpoint
CREATE INDEX "handover_driver_idx" ON "handover_sessions" USING btree ("driver_id");--> statement-breakpoint
CREATE UNIQUE INDEX "handover_one_active_per_vehicle_uq" ON "handover_sessions" USING btree ("vehicle_id") WHERE "handover_sessions"."status" in ('PENDING_HANDOVER', 'RETURN_PENDING');--> statement-breakpoint
CREATE UNIQUE INDEX "handover_one_active_per_driver_uq" ON "handover_sessions" USING btree ("driver_id") WHERE "handover_sessions"."status" in ('PENDING_HANDOVER', 'RETURN_PENDING');--> statement-breakpoint
CREATE INDEX "pings_trip_idx" ON "location_pings" USING btree ("trip_id","recorded_at");--> statement-breakpoint
CREATE INDEX "pings_vehicle_idx" ON "location_pings" USING btree ("vehicle_id","recorded_at");--> statement-breakpoint
CREATE INDEX "trips_vehicle_idx" ON "trips" USING btree ("vehicle_id","started_at");--> statement-breakpoint
CREATE INDEX "trips_driver_idx" ON "trips" USING btree ("driver_id","started_at");--> statement-breakpoint
CREATE UNIQUE INDEX "trips_one_active_per_driver_uq" ON "trips" USING btree ("driver_id") WHERE "trips"."status" = 'ACTIVE';--> statement-breakpoint
CREATE UNIQUE INDEX "trips_one_active_per_vehicle_uq" ON "trips" USING btree ("vehicle_id") WHERE "trips"."status" = 'ACTIVE';--> statement-breakpoint
CREATE UNIQUE INDEX "notifications_user_dedupe_uq" ON "notifications" USING btree ("user_id","dedupe_key") WHERE "notifications"."dedupe_key" is not null;--> statement-breakpoint
ALTER TABLE "vehicles" ADD CONSTRAINT "vehicles_qr_token_unique" UNIQUE("qr_token");--> statement-breakpoint
-- Backfill categories of notifications created before this migration.
UPDATE "notifications" SET "category" = (CASE
  WHEN "type" LIKE 'MAINTENANCE%' THEN 'MAINTENANCE'
  WHEN "type" LIKE 'ASSIGNMENT%' THEN 'ASSIGNMENT'
  WHEN "type" LIKE 'VEHICLE_DRIVER%' THEN 'HANDOVER'
  ELSE 'SYSTEM' END)::"public"."notification_category";
