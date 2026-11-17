ALTER TYPE "public"."accident_workflow_stage" ADD VALUE 'AWAITING_FINANCE_REVIEW' BEFORE 'AWAITING_FINAL_CLOSURE';--> statement-breakpoint
ALTER TYPE "public"."accident_workflow_stage" ADD VALUE 'AWAITING_TECHNICAL_FINAL' BEFORE 'AWAITING_FINAL_CLOSURE';--> statement-breakpoint
CREATE TABLE "accident_finance_reviews" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid NOT NULL,
	"accident_id" uuid NOT NULL,
	"kind" text NOT NULL,
	"status" text NOT NULL,
	"amount" numeric(14, 2),
	"reference_date" timestamp with time zone,
	"proof_attachment_id" uuid,
	"note" text,
	"reviewed_by" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "accident_finance_reviews_kind_ck" CHECK ("accident_finance_reviews"."kind" in ('REPAIR_INVOICE', 'INSURANCE_TRANSFER')),
	CONSTRAINT "accident_finance_reviews_status_ck" CHECK ("accident_finance_reviews"."status" in ('CONFIRMED', 'RETURNED')),
	CONSTRAINT "accident_finance_reviews_amount_ck" CHECK ("accident_finance_reviews"."amount" is null or "accident_finance_reviews"."amount" >= 0)
);
--> statement-breakpoint
ALTER TABLE "accident_finance_reviews" ADD CONSTRAINT "accident_finance_reviews_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "accident_finance_reviews" ADD CONSTRAINT "accident_finance_reviews_accident_id_accidents_id_fk" FOREIGN KEY ("accident_id") REFERENCES "public"."accidents"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "accident_finance_reviews" ADD CONSTRAINT "accident_finance_reviews_proof_attachment_id_accident_attachments_id_fk" FOREIGN KEY ("proof_attachment_id") REFERENCES "public"."accident_attachments"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "accident_finance_reviews" ADD CONSTRAINT "accident_finance_reviews_reviewed_by_users_id_fk" FOREIGN KEY ("reviewed_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "accident_finance_reviews_idx" ON "accident_finance_reviews" USING btree ("accident_id","created_at");--> statement-breakpoint
CREATE INDEX "accident_finance_reviews_reviewer_idx" ON "accident_finance_reviews" USING btree ("reviewed_by");
