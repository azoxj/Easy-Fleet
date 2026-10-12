# Handover links: rollout of Migration 0007

Migration `0007_handover_persistent_link` makes handover links permanent (no expiry) and is **self-contained**: it closes the legacy links that had already expired, audits them, and verifies itself. **No SQL is run by hand, before or after the deployment.**

## Runbook

1. **Backup** — take a database backup/snapshot of the Render PostgreSQL (the free plan has none: use a manual `pg_dump` or a paid plan first).
2. **Push** — pushing `claude/easy-fleet-sprint-1` triggers Render's auto-deploy (`render.yaml`: `autoDeploy: true`). Everything not yet on that branch (e.g. migration 0006) deploys with it.
3. **Render deploy** — build, then `start:render` runs the migrator (advisory lock, one transaction for all pending migrations), then bootstrap, then the server.
4. **Migration 0007** — applied by the migrator. Nothing else to run.
5. **Migration self-check** — built into the migration (see below). If it fails the deployment fails and nothing is applied; the previous version keeps serving.
6. **Health check** — `/api/readyz` (the Render health check) and `/api/healthz` must be green; the logs show `migration 0007: N expired legacy handover link(s) closed`.
7. **Browser smoke test** — create a link, open it, complete a handover, close the link (closed link shows "هذا الرابط غير فعال"), reopen/renew (old link dead, new link works), check a non-admin cannot close or renew.

Optional read-only helpers (not part of the rollout): `server/sql/handover-0007/optional-preview-read-only.sql` (before: which links will be closed), `optional-verify-read-only.sql` (after: counts). `OBSOLETE-step3-close-legacy-expired-links.sql` is **obsolete and not to be used**: it only raises an error.

## What the migration does

- Adds `handover_link_status` (`ACTIVE`/`REVOKED`) and `link_status`, `link_created_at`, `link_rotated_at/by`, `link_revoked_at/by`. `expires_at` stays for history and becomes nullable; **the application no longer reads it** to validate a link.
- Every session starts `ACTIVE` (permanent). Sessions with `status IN ('PENDING_HANDOVER','RETURN_PENDING') AND expires_at IS NOT NULL AND expires_at < now()` become `REVOKED` with `link_revoked_at = now()` — they never work again. (`now()` is fixed for the migration's transaction.)
- One audit row per closed link: action `HANDOVER_LINK_REVOKED`, no user, `metadata.source = 'migration-0007-legacy-expired'`. `link_revoked_by` stays NULL (it is a user id).
- **Never touched:** `token_hash`, `vehicle_id`, `driver_id`, `status`, `expires_at`, photos, completed/cancelled sessions' data, vehicles. Nothing is deleted or recreated.

## Why expired links cannot come back

- They are `REVOKED` in the same transaction that makes expiry irrelevant, before the new code serves a single request.
- The new code only accepts a token whose session has `link_status = 'ACTIVE'` and an active session status, checked in the database on every public request. `REVOKED` only changes through "renew/open", which issues a **new token** (the old hash is replaced), never reactivating an old one.
- The old instance, still serving during the deploy overlap, only validates by `expires_at`, so an expired link is rejected there too.

## Atomic and idempotent

- All pending migrations run in one transaction (drizzle's migrator; the repair path also uses one). 0007 is a single `DO` block: any failing step or failing self-check raises and **everything rolls back** — no half-applied state, and the migration is not recorded, so the next deploy retries cleanly.
- Self-check inside the migration: closed count = expected count; no expired legacy link left active; nothing that was not expired (or any finished session) was closed; revoked total = closed total.
- Idempotent: if `link_status` already exists the block does nothing (running it again never closes a link that is still permanent, even after its old `expires_at` has passed).

Tests: `server/tests/handover-0007-migration.test.ts` runs the real migration on a database migrated to 0006 with sessions in every state, and also covers atomic rollback, idempotency and the post-upgrade create / renew / reopen / close behavior.
