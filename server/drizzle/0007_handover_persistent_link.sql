-- Persistent handover links: link_status (ACTIVE/REVOKED) and who/when created, renewed or revoked the link.
-- expires_at stays (history) but becomes nullable: links no longer expire by time.
-- No row is rewritten or removed; existing sessions default to ACTIVE.
CREATE TYPE "public"."handover_link_status" AS ENUM('ACTIVE', 'REVOKED');--> statement-breakpoint
ALTER TABLE "handover_sessions" ALTER COLUMN "expires_at" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "handover_sessions" ADD COLUMN "link_status" "handover_link_status" DEFAULT 'ACTIVE' NOT NULL;--> statement-breakpoint
ALTER TABLE "handover_sessions" ADD COLUMN "link_created_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "handover_sessions" ADD COLUMN "link_rotated_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "handover_sessions" ADD COLUMN "link_rotated_by" uuid;--> statement-breakpoint
ALTER TABLE "handover_sessions" ADD COLUMN "link_revoked_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "handover_sessions" ADD COLUMN "link_revoked_by" uuid;--> statement-breakpoint
ALTER TABLE "handover_sessions" ADD CONSTRAINT "handover_sessions_link_rotated_by_users_id_fk" FOREIGN KEY ("link_rotated_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "handover_sessions" ADD CONSTRAINT "handover_sessions_link_revoked_by_users_id_fk" FOREIGN KEY ("link_revoked_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;