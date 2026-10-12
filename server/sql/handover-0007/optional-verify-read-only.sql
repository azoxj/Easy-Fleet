-- OPTIONAL, READ ONLY — a look at the result of Migration 0007 after the deployment. Not required:
-- the migration verifies itself and aborts (rolling back) if anything is off.
--
--   BEGIN READ ONLY;  <paste this file>  ROLLBACK;
SELECT
  -- links closed by the migration (audit rows with its source marker)
  (SELECT count(*) FROM audit_logs WHERE action = 'HANDOVER_LINK_REVOKED' AND metadata ->> 'source' = 'migration-0007-legacy-expired') AS closed_by_migration,
  -- sessions revoked right now (includes links closed by people afterwards)
  count(*) FILTER (WHERE link_status = 'REVOKED') AS revoked_now,
  -- active links of active sessions (permanent)
  count(*) FILTER (WHERE link_status = 'ACTIVE' AND status IN ('PENDING_HANDOVER', 'RETURN_PENDING')) AS active_links
FROM handover_sessions;
