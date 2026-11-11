CREATE TABLE "driver_portal_links" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid NOT NULL,
	"driver_id" uuid NOT NULL,
	"token_hash" text NOT NULL,
	"status" "handover_link_status" DEFAULT 'ACTIVE' NOT NULL,
	"created_by" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"rotated_at" timestamp with time zone,
	"rotated_by" uuid,
	"revoked_at" timestamp with time zone,
	"revoked_by" uuid,
	"last_access_at" timestamp with time zone,
	"access_count" integer DEFAULT 0 NOT NULL,
	CONSTRAINT "driver_portal_links_token_hash_unique" UNIQUE("token_hash")
);
--> statement-breakpoint
ALTER TABLE "handover_sessions" ADD COLUMN "via_portal" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "driver_portal_links" ADD CONSTRAINT "driver_portal_links_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "driver_portal_links" ADD CONSTRAINT "driver_portal_links_driver_id_drivers_id_fk" FOREIGN KEY ("driver_id") REFERENCES "public"."drivers"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "driver_portal_links" ADD CONSTRAINT "driver_portal_links_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "driver_portal_links" ADD CONSTRAINT "driver_portal_links_rotated_by_users_id_fk" FOREIGN KEY ("rotated_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "driver_portal_links" ADD CONSTRAINT "driver_portal_links_revoked_by_users_id_fk" FOREIGN KEY ("revoked_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "driver_portal_links_driver_uq" ON "driver_portal_links" USING btree ("driver_id");--> statement-breakpoint
CREATE INDEX "driver_portal_links_org_idx" ON "driver_portal_links" USING btree ("organization_id");