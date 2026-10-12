-- Persistent handover links (self-contained rollout).
--
-- 1. Adds link_status (ACTIVE/REVOKED) and who/when created, renewed or revoked the link.
-- 2. expires_at stays for history but becomes nullable: links no longer expire by time and the
--    application no longer reads it to validate a link.
-- 3. Legacy links that were ALREADY expired while their session was still active
--    (status PENDING_HANDOVER / RETURN_PENDING, expires_at < now()) are closed here:
--    link_status = 'REVOKED', link_revoked_at = now(). They never come back to life.
--    Every other session keeps/gets link_status = 'ACTIVE' (permanent from now on).
-- 4. One audit row per closed link (action HANDOVER_LINK_REVOKED, no user,
--    metadata.source = 'migration-0007-legacy-expired'). link_revoked_by stays NULL (it is a user id).
--
-- Never touched: token_hash, vehicle_id, driver_id, status, expires_at, photos, completed or
-- cancelled sessions, vehicles. Nothing is deleted or recreated.
--
-- Atomic: the whole block is one statement inside the migrator's transaction. A failing step or a
-- failing self-check at the end raises an exception and everything is rolled back (no half state).
-- Idempotent: if link_status already exists the block does nothing.
DO $migration$
DECLARE
  expected integer;
  closed integer;
BEGIN
  IF EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = current_schema() AND table_name = 'handover_sessions' AND column_name = 'link_status'
  ) THEN
    RAISE NOTICE 'migration 0007: already applied, nothing to do';
    RETURN;
  END IF;

  CREATE TYPE "public"."handover_link_status" AS ENUM('ACTIVE', 'REVOKED');
  ALTER TABLE "handover_sessions" ALTER COLUMN "expires_at" DROP NOT NULL;
  ALTER TABLE "handover_sessions" ADD COLUMN "link_status" "handover_link_status" DEFAULT 'ACTIVE' NOT NULL;
  ALTER TABLE "handover_sessions" ADD COLUMN "link_created_at" timestamp with time zone;
  ALTER TABLE "handover_sessions" ADD COLUMN "link_rotated_at" timestamp with time zone;
  ALTER TABLE "handover_sessions" ADD COLUMN "link_rotated_by" uuid;
  ALTER TABLE "handover_sessions" ADD COLUMN "link_revoked_at" timestamp with time zone;
  ALTER TABLE "handover_sessions" ADD COLUMN "link_revoked_by" uuid;
  ALTER TABLE "handover_sessions" ADD CONSTRAINT "handover_sessions_link_rotated_by_users_id_fk" FOREIGN KEY ("link_rotated_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;
  ALTER TABLE "handover_sessions" ADD CONSTRAINT "handover_sessions_link_revoked_by_users_id_fk" FOREIGN KEY ("link_revoked_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;

  -- Links that were expired and still usable by an active session (now() is fixed for the whole transaction).
  SELECT count(*) INTO expected
  FROM handover_sessions
  WHERE status IN ('PENDING_HANDOVER', 'RETURN_PENDING') AND expires_at IS NOT NULL AND expires_at < now();

  WITH closed_links AS (
    UPDATE handover_sessions
    SET link_status = 'REVOKED', link_revoked_at = now()
    WHERE status IN ('PENDING_HANDOVER', 'RETURN_PENDING') AND expires_at IS NOT NULL AND expires_at < now()
    RETURNING id, organization_id, project_id, vehicle_id, status, expires_at
  )
  INSERT INTO audit_logs (organization_id, user_id, action, entity, entity_id, project_id, vehicle_id, metadata, old_value, new_value)
  SELECT c.organization_id, NULL, 'HANDOVER_LINK_REVOKED', 'handover', c.id::text, c.project_id, c.vehicle_id,
         jsonb_build_object('source', 'migration-0007-legacy-expired', 'sessionStatus', c.status, 'legacyExpiresAt', c.expires_at),
         jsonb_build_object('linkStatus', 'ACTIVE'),
         jsonb_build_object('linkStatus', 'REVOKED')
  FROM closed_links c;
  GET DIAGNOSTICS closed = ROW_COUNT;

  -- Self-check: any failure aborts the migration and rolls everything back.
  IF closed <> expected THEN
    RAISE EXCEPTION 'migration 0007 self-check failed: closed % link(s), expected %', closed, expected;
  END IF;
  IF EXISTS (SELECT 1 FROM handover_sessions WHERE status IN ('PENDING_HANDOVER', 'RETURN_PENDING') AND expires_at IS NOT NULL AND expires_at < now() AND link_status <> 'REVOKED') THEN
    RAISE EXCEPTION 'migration 0007 self-check failed: an expired legacy link is still active';
  END IF;
  IF EXISTS (SELECT 1 FROM handover_sessions WHERE link_status = 'REVOKED' AND NOT (status IN ('PENDING_HANDOVER', 'RETURN_PENDING') AND expires_at IS NOT NULL AND expires_at < now())) THEN
    RAISE EXCEPTION 'migration 0007 self-check failed: a link that was not expired (or a finished session) was closed';
  END IF;
  IF (SELECT count(*) FROM handover_sessions WHERE link_status = 'REVOKED') <> closed THEN
    RAISE EXCEPTION 'migration 0007 self-check failed: revoked count does not match';
  END IF;

  RAISE NOTICE 'migration 0007: % expired legacy handover link(s) closed', closed;
END
$migration$;
