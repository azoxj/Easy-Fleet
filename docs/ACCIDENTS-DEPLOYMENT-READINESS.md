# Accident workflow — deployment readiness

Status: **not deployed, not committed.** Everything below was verified on a local database only. Nothing was run on AWS, Render or Production.

## What would be released
- Migration `0010_accident_cases` (additive): 5 new enum types, 6 new tables (`accident_stage_officers`, `accident_transitions`, `accident_assignments`, `accident_estimates`, `accident_claims`,
  `accident_settings`), 17 nullable/defaulted columns on `accidents` / `accident_attachments`. No DROP, no UPDATE, no ALTER TYPE; legacy rows are untouched
  (`tests/accident-0010-migration.test.ts` proves it on legacy data). The new tables are empty; adding the foreign keys to `accidents` takes a short lock.
- API `/api/accident-cases/*` (dark behind `ACCIDENT_WORKFLOW_ENABLED`), `/api/accidents/features|stats`, list `?view=`, officers and delay-limit management.
- Screens inside the existing Accidents section (`/accidents`, `/accidents/new`, `/accidents/:id`, `/accidents/settings`): no new sidebar entry.
- Two roles (`ACCIDENT_MANAGER`, `INSURANCE_OFFICER`) and **seven** permissions, **dormant until the targeted sync below**. `accidents.settings.manage` (editing the delay limits) is independent of `accidents.assign` (officers/assignment) and is held by SUPER_ADMIN only; the sync plan adds SUPER_ADMIN's `ALL` grants for the accident permissions (insert-only, scope-guarded) because production runs without the general bootstrap.
- `deploy.sh`: bootstrap only with `EF_RUN_BOOTSTRAP=yes`.

## Verification (local)
See `ACCIDENTS-RELEASE-REVIEW.md` for the final figures (server and web tests, typecheck, build, browser checks) (`web/e2e/run.sh`: workflow off, workflow on, acceptance incl. reopening, English, phone downloads, every role).

## Order of a release (each step needs your explicit approval; none was done)
1. Take an RDS snapshot; check the migration ledger of the real database read-only (`npm run db:verify-aws -w server`) so you know which migrations the release will apply:
   `migrate.js` applies **every** migration not yet recorded (0010, and 0006–0009 too if they were never applied there).
2. Rehearse on a restored copy of the production snapshot: `migrate.js`, then the app against it. (Not done: no copy is available here.)
3. Release with `CONFIRM_BACKUP=yes` and **without** `EF_RUN_BOOTSTRAP` (flags off). Existing accidents, dashboards and files behave as before.
4. Targeted permission sync, in this order, each as preview → review → apply with the plan hash (`EF_CONFIRM_ACCIDENT_CATALOG=yes`):
   - `npm run db:sync-accident-catalog -w server` (7 permissions, 2 roles, their grants, SUPER_ADMIN's ALL grants for the accident permissions);
   - add `--include-technical` to also give TECHNICAL its 2 accident grants (decision);
   - add `--include-project-manager-sensitive` to give PROJECT_MANAGER the one document grant (decision). The pending PROJECT_MANAGER differences stay pending (the tool proves it).
   `db:preview-catalog` shows the whole difference to the code at any time. Never use the general bootstrap for this.
5. Create the accident users (ACCIDENT_MANAGER, INSURANCE_OFFICER, technicians), then designate officers on `/accidents/settings` (without designated officers every case waits in the queue).
6. Set `ACCIDENT_WORKFLOW_ENABLED=true` (env file / Secrets), restart. Try with one project. `ACCIDENT_LEGACY_SENSITIVE_ENFORCEMENT` stays `false` until its own decision
   (it hides legacy police/insurance files from finance, viewers and users).

## Owner's decisions (recorded, nothing applied)
1. `accidents.settings.manage` belongs to `SUPER_ADMIN` only; no other role gets it.
2. `PROJECT_MANAGER` may receive `accidents.documents.sensitive` with scope PROJECT only, through the targeted tool: `npm run db:sync-accident-catalog -w server -- --include-project-manager-sensitive` (preview), then `--apply --include-project-manager-sensitive --plan-hash=<hash>` with `EF_CONFIRM_ACCIDENT_CATALOG=yes`. It adds one grant; the rest of the role is untouched (the tool proves it, and refuses any other change).
3. `TECHNICAL` may receive its two accident grants (`--include-technical`, same preview → apply sequence). Nothing else changes for that role.
4. `ACCIDENT_LEGACY_SENSITIVE_ENFORCEMENT` stays `false` until further notice.
5. Applying 2 and 3 to Production is **not** approved yet: it needs its own approval, after the rehearsal.

## Scope of the workflow flag
`ACCIDENT_WORKFLOW_ENABLED` is **global**: one environment variable for the whole deployment (all organisations/projects of that server). It is not per project. A gradual start is possible only by organisational means (designate officers and create the accident users for one project first, tell only its users); the screens and the API are available to everyone holding the permissions as soon as the flag is on. A per-project switch would be a new feature and was **not** added; it needs your decision.

## Feature flags
| Flag | Default | Effect |
|---|---|---|
| `ACCIDENT_WORKFLOW_ENABLED` | false | `/api/accident-cases/*` answer 404; the Accidents screens behave like the legacy ones |
| `ACCIDENT_LEGACY_SENSITIVE_ENFORCEMENT` | false | the sensitive-document rule for LEGACY accidents (workflow cases are always protected) |
Both are in `.env.example` and `deploy/aws/easy-fleet.env.example`, false.

## Turning the workflow flag off after workflow cases exist
- Legacy routes (`/api/accidents/:id` PATCH, `/status`, `/attachments`) refuse workflow cases (409 `WORKFLOW_CASE`, SQL guarded by `workflow_stage IS NULL`), so the flag being off never opens them for editing. Drafts stay hidden from users who may not see them.
- `/api/accident-cases/*` answer 404; no data is changed or deleted. Proven by `tests/accident-flag-off-persistence.test.ts` (draft, technical, final-closure cases; every role; data byte-identical after the flag returns).
- To restore access: set `ACCIDENT_WORKFLOW_ENABLED=true`, restart. Nothing else is needed. Meanwhile the cases remain readable (read-only, mirror status) on `/accidents`.

## Backup and rollback
- Before release: RDS snapshot (`CONFIRM_BACKUP=yes` enforces the habit). PITR is on.
- Code rollback (`deploy.sh rollback`) is safe for the database: 0010 is additive and the previous release ignores the new objects.
- Before the first workflow case exists: rolling back is clean. Turning `ACCIDENT_WORKFLOW_ENABLED` off is the fastest "undo" (routes go dark; existing workflow cases remain protected on the legacy routes).
- After workflow cases exist: prefer rolling forward. An older release has no guards: its legacy routes could edit or close a workflow case and it counts drafts as open. If a
  rollback is unavoidable, stop users using the legacy accident screens first and never run bootstrap during it (an older bootstrap would delete the new permissions).
- The targeted permission tool is insert-only; to take a grant back, remove that one `role_permissions` row (nothing else depends on it).
- A restore of the snapshot discards everything entered since; that is the only way back from a bad data event.

## What blocks a production release today
1. **Nothing is committed or reviewed as code**: 38 modified and 31 new entries (90 files) are in one working tree on top of `9771a39`. A reviewed commit/PR and CI run come first.
2. **Decisions pending** from you: PROJECT_MANAGER document grant; TECHNICAL grants; when to enable the legacy-file rule; who, besides SUPER_ADMIN, should hold `accidents.settings.manage` (default: nobody; `accidents.assign` no longer edits the limits).
3. **No rehearsal on production-sized data** and no staging run on AWS (S3 storage, RDS, Caddy): only local PostgreSQL/Chromium were used.
4. **Unknown production state**: which migrations (0006–0009) and which PROJECT_MANAGER differences are already there must be checked read-only before anything.
5. **Operational set-up not yet done**: accident users and designated officers, and the notification routes (e-mail) for the new notification types have not been exercised on the real mail configuration.
6. Known limits: Chromium only; no automated accessibility audit; legacy `/accidents` rows of workflow cases show the mirror status (by design).
