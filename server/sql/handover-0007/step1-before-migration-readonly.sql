-- ============================================================================
-- STEP 1 — BEFORE Migration 0007 — READ ONLY (changes nothing, reads no tokens)
-- ============================================================================
-- Works on the production schema as it is today (it only uses columns that exist
-- before 0007). Run it in a read-only transaction:
--
--   BEGIN READ ONLY;
--   <paste this file>
--   ROLLBACK;
--
-- 1a) Write down this timestamp: it is the CUTOFF used by step 3. Take it right
--     before you start the deploy that applies Migration 0007.
SELECT now() AS cutoff_utc_write_this_down;

-- 1b) Legacy links that are ALREADY expired while the session is still active
--     (these are the ones step 3 will close, if still unchanged at the cutoff).
SELECT s.id, s.status, v.plate_number, s.expires_at, s.last_access_at, s.access_count
FROM handover_sessions s
JOIN vehicles v ON v.id = s.vehicle_id
WHERE s.status IN ('PENDING_HANDOVER', 'RETURN_PENDING')
  AND s.expires_at IS NOT NULL
  AND s.expires_at < now()
ORDER BY s.expires_at;

-- 1c) Active links that will expire within 24 h of now. If one of them expires
--     between the cutoff and the migration it is NOT closed by step 3 (it was
--     alive at the cutoff) — decide about those by hand.
SELECT s.id, s.status, v.plate_number, s.expires_at
FROM handover_sessions s
JOIN vehicles v ON v.id = s.vehicle_id
WHERE s.status IN ('PENDING_HANDOVER', 'RETURN_PENDING')
  AND s.expires_at >= now()
  AND s.expires_at < now() + interval '24 hours'
ORDER BY s.expires_at;
