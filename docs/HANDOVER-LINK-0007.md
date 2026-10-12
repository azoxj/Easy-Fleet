# Handover links: rollout of Migration 0007

Migration `0007_handover_persistent_link` makes handover links permanent (no expiry). Links that had **already expired** while their session was still active would come back to life at that moment. This runbook closes exactly those, once, right after the migration.

Nothing here runs by itself: the migration is applied by the normal deploy (`start:render`), and the SQL files are run **by you**. All files are in `server/sql/handover-0007/`. Tested against a disposable test database (`server/tests/handover-0007-legacy-links.test.ts`), never against production.

## Order

| # | When | What | Writes? |
|---|---|---|---|
| 0 | before | Take a database backup/snapshot (Render Postgres). | — |
| 1 | before deploy | Run `step1-before-migration-readonly.sql` inside `BEGIN READ ONLY; … ROLLBACK;`. **Write down the first result (`cutoff_utc`)** and save the lists (1b: expired + active = will be closed; 1c: expiring within 24 h = decide by hand). | no |
| 2 | deploy | Deploy: Migration 0007 is applied automatically (additive; `expires_at` only loses NOT NULL). | schema only |
| 3 | right after step 2 | In one SQL session: `SET migration0007.cutoff = '<cutoff from step 1>';` then run `step3-close-legacy-expired-links.sql`. The result row shows `links_closed`. | yes (see below) |
| 4 | after step 3 | Same session/cutoff: run `step4-verify.sql` inside `BEGIN READ ONLY; … ROLLBACK;`. | no |

Between step 2 and step 3 the previously expired legacy links work again (the new code no longer checks expiry). Run step 3 as soon as the deploy is live.

## What step 3 changes

Only rows that match **all** of: active session (`PENDING_HANDOVER` / `RETURN_PENDING`), `expires_at IS NOT NULL AND expires_at < cutoff`, `link_status = 'ACTIVE'`, and a *legacy* link (`link_created_at IS NULL AND link_rotated_at IS NULL` — every link created, renewed or reopened after 0007 sets one of them).

On those rows it sets `link_status = 'REVOKED'` and `link_revoked_at = now()`. Nothing else: not `token_hash`, `vehicle_id`, `driver_id`, `status`, `expires_at`, `updated_at`, photos or odometers. Completed, closed and cancelled sessions are never touched. Links that were still valid at the cutoff stay active. Links created or renewed after the migration are never touched.

- **`link_revoked_by`** stays NULL: it is a user id (foreign key) and a migration is not a user. The system action is recorded in the append-only audit trail: one `HANDOVER_LINK_REVOKED` row per closed link, no user, `metadata.source = 'migration-0007-legacy-expired'` (no token anywhere).
- **Idempotent:** a second run matches nothing (`link_status` is no longer ACTIVE) and writes nothing.
- **Fail-safe:** without `SET migration0007.cutoff` the script stops with an error and changes nothing.
- Atomic: the updates and their audit rows are one statement.

## Reading the verification (step 4)

| Column | Expected |
|---|---|
| `legacy_expired_still_open` | **0** after step 3 (before step 3 = how many it will close) |
| `closed_by_script` / `closed_and_revoked` | equal, and equal to `links_closed` |
| `new_links_touched` | **0** |
| `not_expired_but_closed` | **0** |
| `finished_sessions_touched` | **0** |
| `legacy_not_expired_left_open` | links intentionally left open (not expired at the cutoff) |

A link that expires between the cutoff and the migration is left open on purpose (it was alive at the cutoff). Step 1c lists such candidates; close them by hand from the handover list ("إغلاق الرابط") if needed.
