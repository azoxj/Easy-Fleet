-- OPTIONAL, READ ONLY — run it before the push only if you want to know in advance how many links
-- Migration 0007 will close. It changes nothing, reads no tokens, and is not part of the rollout.
--
--   BEGIN READ ONLY;  <paste this file>  ROLLBACK;
--
-- Active sessions whose link is already expired: Migration 0007 closes exactly these (status
-- stays as it is, the link just stops working for good).
SELECT s.id, s.status, v.plate_number, s.expires_at, s.last_access_at, s.access_count
FROM handover_sessions s
JOIN vehicles v ON v.id = s.vehicle_id
WHERE s.status IN ('PENDING_HANDOVER', 'RETURN_PENDING')
  AND s.expires_at IS NOT NULL
  AND s.expires_at < now()
ORDER BY s.expires_at;
