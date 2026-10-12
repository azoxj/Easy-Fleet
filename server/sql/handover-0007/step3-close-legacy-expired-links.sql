-- ============================================================================
-- STEP 3 — AFTER Migration 0007 — closes legacy links that were already expired
-- ============================================================================
-- Run ONCE, right after the deploy that applied Migration 0007, in the SAME
-- database session as the SET below. Set the cutoff first (UTC, the value you
-- wrote down in step 1a — the moment before the migration was applied):
--
--   SET migration0007.cutoff = '2026-10-13 09:00:00+00';
--
-- If the cutoff is not set the script stops with an error and changes nothing
-- (current_setting() without a default fails).
--
-- It closes ONLY sessions that satisfy ALL of these:
--   * status IN ('PENDING_HANDOVER', 'RETURN_PENDING')        (still active)
--   * expires_at IS NOT NULL AND expires_at < cutoff           (was expired at the cutoff)
--   * link_status = 'ACTIVE'                                   (not already closed → idempotent)
--   * link_created_at IS NULL AND link_rotated_at IS NULL      (a LEGACY link: every link
--     created, renewed or reopened after 0007 sets one of these, so new links are never touched)
--
-- It changes ONLY link_status and link_revoked_at on those rows. It does not touch
-- token_hash, vehicle_id, driver_id, status, expires_at, updated_at, photos, odometers
-- or any completed/cancelled/closed session.
--
-- link_revoked_by stays NULL: the column is a user id (foreign key) and there is no user
-- for a migration. Who closed the link is recorded in the append-only audit trail instead
-- (action HANDOVER_LINK_REVOKED, no user, metadata.source = 'migration-0007-legacy-expired').
--
-- Running it again closes nothing (0 rows). The single statement is atomic: the updates
-- and their audit rows commit together or not at all. The result is the number of links
-- it closed.
WITH params AS (
  SELECT current_setting('migration0007.cutoff')::timestamptz AS cutoff
),
closed AS (
  UPDATE handover_sessions s
  SET link_status = 'REVOKED',
      link_revoked_at = now()
  FROM params p
  WHERE s.status IN ('PENDING_HANDOVER', 'RETURN_PENDING')
    AND s.expires_at IS NOT NULL
    AND s.expires_at < p.cutoff
    AND s.link_status = 'ACTIVE'
    AND s.link_created_at IS NULL
    AND s.link_rotated_at IS NULL
  RETURNING s.id, s.organization_id, s.project_id, s.vehicle_id, s.status, s.expires_at
),
logged AS (
  INSERT INTO audit_logs (organization_id, user_id, action, entity, entity_id, project_id, vehicle_id, metadata, old_value, new_value)
  SELECT c.organization_id, NULL, 'HANDOVER_LINK_REVOKED', 'handover', c.id::text, c.project_id, c.vehicle_id,
         jsonb_build_object('source', 'migration-0007-legacy-expired', 'sessionStatus', c.status, 'legacyExpiresAt', c.expires_at, 'cutoff', (SELECT cutoff FROM params)),
         jsonb_build_object('linkStatus', 'ACTIVE'),
         jsonb_build_object('linkStatus', 'REVOKED')
  FROM closed c
  RETURNING 1
)
SELECT (SELECT count(*) FROM closed) AS links_closed,
       (SELECT count(*) FROM logged) AS audit_rows_written;
