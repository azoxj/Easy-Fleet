# Accident workflow — final security review and release plan

Status: **not committed, not deployed.** Everything here was checked on local, throw-away databases. Nothing was run on AWS, Render or Production.

## 1. Delay limits have their own permission
- New permission `accidents.settings.manage`. It is held by SUPER_ADMIN only (through the general `settings.manage`/`ALL` model); `ACCIDENT_MANAGER` and every other role do **not** have it.
- `PUT /api/accident-cases/settings` requires `accidents.settings.manage` with scope ALL (or the general `settings.manage` ALL). `accidents.assign` — even with scope ALL — gets 403.
- `GET /api/accident-cases/settings` is readable with `accidents.assign` or the new permission and returns `canEdit`; the screen shows the limits read-only when `canEdit` is false.
- Officers and assignment stay on `accidents.assign`. Each change is audited (`ACCIDENT_CASE_SETTINGS`, before/after per limit).
- The targeted tool `db:sync-accident-catalog` now covers 7 permissions and also inserts SUPER_ADMIN's ALL grants for them (insert-only; the scope guard refuses any other role/permission/scope; forged plans are tested). Preview is the default; apply needs `--plan-hash` and `EF_CONFIRM_ACCIDENT_CATALOG=yes`.

## 2. Migration `0010_accident_cases`
- **Matches the schema:** `drizzle-kit generate` against the final schema reports "No schema changes"; the snapshot and journal entry are present.
- **Additive only:** 5 `CREATE TYPE`, 6 `CREATE TABLE`, 17 `ALTER TABLE … ADD COLUMN` (all nullable, **no default** → metadata-only, no table rewrite), FK constraints and indexes. No DROP, UPDATE, DELETE, ALTER COLUMN, RENAME, SET NOT NULL, ALTER TYPE. `tests/accident-0010-migration.test.ts` proves legacy accidents and attachments are byte-identical after the migration.
- **Locks:** `migrate.js` takes a session advisory lock (one runner at a time) and applies everything in one transaction. `ADD COLUMN` takes a brief ACCESS EXCLUSIVE lock on `accidents`/`accident_attachments`; the FK additions (about 20) take SHARE ROW EXCLUSIVE on the referenced tables (`users`, `projects`, `accidents`, `accident_attachments`, `organizations`); `CREATE INDEX` (not concurrent) blocks writes to `accidents` for the build time. All of it is short on a table of accident-report size, but run it in a quiet window; a long-running transaction on those tables would make the migration wait (and block newer queries behind it) — check `pg_stat_activity` first.
- **Application lock order (concurrent requests):** every workflow mutation locks the case row first (`lockCase`, `FOR UPDATE`), then the vehicle (`flagVehicle`), then the claim/settings row. No code path locks a vehicle and then a case (handover/portal lock the vehicle only), so there is no lock-order inversion. Legacy writes are guarded in SQL (`workflow_stage IS NULL`) so a case that moves into the workflow while a legacy request is in flight yields 409 instead of a lost update. Concurrency tests (assign race, double transition, selecting two estimates, settings update) pass.
- **Rehearsal plan on an isolated copy (not done here — no production copy exists):**
  1. Restore the latest RDS snapshot into a *separate* instance/database (never the production one), in a private network.
  2. Point a shell at the copy's URL only (`DATABASE_URL`), run `npm run db:verify-aws -w server` (read-only) to list the unapplied migrations.
  3. `time node dist/scripts/migrate.js` — record duration; expect seconds. Run `\d accidents` to confirm the columns, and compare `select count(*), md5(string_agg(id::text||status::text, ',' order by id)) from accidents` before/after (must be identical).
  4. Start the app against the copy with both flags false and open the legacy Accidents screens; then run `db:preview-catalog` and `db:sync-accident-catalog` (preview, then apply) on the copy, enable the workflow flag on the copy only, and walk one case through.
  5. Drop the copy.

## 3. Release integrity review
Reviewed: the 38 modified and the new files (90 files in the working tree).
- **Permissions / project scope:** every route of the three accident routers is in `tests/accident-routes-guard.test.ts` (the test fails if a route is added without being listed). It checks: anonymous → 401; users without roles → 403/404; viewers/finance writes never succeed; a manager of another project gets 403/404 for every read and write; stage permissions are enforced per stage. Case reads are filtered in SQL by `caseVisibility` (project/organisation + draft privacy).
- **Sensitive files:** attachments are served only through the policy check (permission + scope + participant); other-project users get 404; legacy police/insurance documents are protected by their own flag; downloads go through the authenticated route (no static serving).
- **Legacy compatibility:** `workflow_stage IS NULL` = legacy; legacy screens, stats, dashboards and files behave as before; legacy routes refuse workflow cases (409 `WORKFLOW_CASE`); the status mirror keeps legacy lists correct.
- **Flag off after new cases exist:** see `tests/accident-flag-off-persistence.test.ts` — draft, technical and final-closure cases; PM, manager, administrator, insurer, technician: legacy PATCH/status/attachments never succeed (409/404/403), workflow routes 404, unprivileged readers cannot see drafts, data is identical after the flag returns. Restoring access: set `ACCIDENT_WORKFLOW_ENABLED=true` and restart; no data step.
- **Secrets / test data:** a scan of all changed files found no credentials, keys, dumps, images or `.env` files; the only URL-like strings with passwords are fake placeholders in test files. `.env.example` files hold placeholders and both flags `false`. `web/e2e/` and `server/tests/` are not part of the release tarball (`deploy/aws/package-release.sh` packs only `package*.json`, `server/dist`, `server/drizzle`, `web/dist`, `deploy`, `docs`).
- **No new side-menu entries** (checked per role in the browser run).

## 4. Final acceptance (local, isolated databases)
| Check | Result |
|---|---|
| Server `tsc --noEmit` | pass |
| Web `tsc -b` | pass |
| Server tests (60 files) | **577 passed** |
| Web tests (14 files) | **108 passed** |
| Build (server + web) | pass |
| Browser run `web/e2e/run.sh` — workflow off | 7/7 |
| — workflow on | 44/44 |
| — acceptance (SLA permission, legacy continuity, project isolation, sensitive attachments, English, phone, every role) | 87/87 |

## 5. Release plan
See `ACCIDENTS-DEPLOYMENT-READINESS.md` (order of release, backup, rollback, flags). Nothing there has been executed.
