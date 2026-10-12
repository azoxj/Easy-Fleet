-- ============================================================================
-- STEP 4 — VERIFY — READ ONLY. Run after step 3 (it is also a dry run if you run it
-- BEFORE step 3: legacy_expired_still_open then shows how many links step 3 will close).
-- ============================================================================
-- Needs the same cutoff:   SET migration0007.cutoff = '2026-10-13 09:00:00+00';
-- Run it in a read-only transaction:  BEGIN READ ONLY; <this file>; ROLLBACK;
WITH params AS (
  SELECT current_setting('migration0007.cutoff')::timestamptz AS cutoff
),
script_audit AS (
  SELECT a.entity_id::uuid AS session_id
  FROM audit_logs a
  WHERE a.action = 'HANDOVER_LINK_REVOKED' AND a.metadata ->> 'source' = 'migration-0007-legacy-expired'
)
SELECT
  -- EXPECTED 0 after step 3: legacy links that were expired at the cutoff and are still open
  count(*) FILTER (WHERE s.status IN ('PENDING_HANDOVER', 'RETURN_PENDING') AND s.expires_at < p.cutoff
                     AND s.link_status = 'ACTIVE' AND s.link_created_at IS NULL AND s.link_rotated_at IS NULL) AS legacy_expired_still_open,
  -- links closed by the script (audit rows with the script's source marker)
  (SELECT count(*) FROM script_audit) AS closed_by_script,
  -- of those, how many are really REVOKED now (should equal closed_by_script)
  count(*) FILTER (WHERE s.id IN (SELECT session_id FROM script_audit) AND s.link_status = 'REVOKED') AS closed_and_revoked,
  -- EXPECTED 0: new links (created/renewed after 0007) touched by the script
  count(*) FILTER (WHERE s.id IN (SELECT session_id FROM script_audit) AND (s.link_created_at IS NOT NULL OR s.link_rotated_at IS NOT NULL)) AS new_links_touched,
  -- EXPECTED 0: legacy links that were NOT expired at the cutoff but were closed by the script
  count(*) FILTER (WHERE s.id IN (SELECT session_id FROM script_audit) AND (s.expires_at IS NULL OR s.expires_at >= p.cutoff)) AS not_expired_but_closed,
  -- EXPECTED 0: finished sessions touched by the script
  count(*) FILTER (WHERE s.id IN (SELECT session_id FROM script_audit) AND s.status NOT IN ('PENDING_HANDOVER', 'RETURN_PENDING')) AS finished_sessions_touched,
  -- legacy links left open ON PURPOSE (not expired at the cutoff, still active session)
  count(*) FILTER (WHERE s.status IN ('PENDING_HANDOVER', 'RETURN_PENDING') AND s.link_status = 'ACTIVE' AND s.link_created_at IS NULL
                     AND s.link_rotated_at IS NULL AND s.expires_at >= p.cutoff) AS legacy_not_expired_left_open
FROM handover_sessions s CROSS JOIN params p;
