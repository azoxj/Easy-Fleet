# Accidents & insurance claims — Phase 1 (foundation)

Status: developed and tested on a local database only. Not committed, not deployed, migration 0010 not run anywhere
but disposable test databases. No HTTP routes or UI belong to this phase (the API is Phase 2: `docs/ACCIDENTS-API.md`).

## What Phase 1 contains
- Migration `0010_accident_cases` (additive only): four new enum types, five new tables, nullable columns on `accidents`
  and `accident_attachments`. `accident_estimates.selected` is `boolean not null default false` with a partial unique
  index (one selected estimate per accident).
- Permissions `accidents.review.technical|claims.manage|assign|close|reopen|documents.sensitive`; roles
  `INSURANCE_OFFICER`, `ACCIDENT_MANAGER`; two additive grants for TECHNICAL, one for PROJECT_MANAGER (see below).
- Pure modules: workflow state machine + legacy status mirror, assignment engine, attachments policy, SLA helpers.
- Legacy routes (`PATCH`, `…/status`, `…/attachments`) refuse workflow cases (409 `WORKFLOW_CASE`), checked in the SQL
  statement itself (`workflow_stage IS NULL`) and re-checked under a row lock for uploads.
- Drafts are not accidents for statistics: excluded from open lists/counters, the dashboard, the accident and driver
  reports and the cost ledger.

## Putting the permissions in production WITHOUT the pending PROJECT_MANAGER changes
`db:bootstrap` / `syncCatalog` rewrites every system role from code. Do **not** use it for this. Use the dedicated tool:

```
npm run db:sync-accident-catalog -w server                      # preview (READ ONLY transaction), prints PLAN HASH
npm run db:sync-accident-catalog -w server -- --include-technical   # preview including TECHNICAL's two grants
EF_CONFIRM_ACCIDENT_CATALOG=yes npm run db:sync-accident-catalog -w server -- --apply --plan-hash=<hash> [--include-technical]
```
- Default is preview; nothing is written. `--apply` additionally needs the hash of the reviewed plan and
  `EF_CONFIRM_ACCIDENT_CATALOG=yes`; Render hosts are refused.
- Insert-only: creates the six permissions, the two roles and their grants. It never deletes or changes a grant and
  never touches PROJECT_MANAGER or any role other than the two new ones (TECHNICAL only with `--include-technical`, and only
  its two accident grants). After writing, the transaction proves that the catalog equals "before + the plan" and rolls
  back otherwise.
- PROJECT_MANAGER's `accidents.documents.sensitive` exists in code but is NOT applied unless asked: the explicit flag
  `--include-project-manager-sensitive` adds that one grant (PROJECT scope) and nothing else of that role (its pending differences from the code
  stay as they are). Without the flag, PROJECT_MANAGER is never named in the plan. The general bootstrap would add it too, together with all the
  pending PROJECT_MANAGER changes, which is why it is not used.
- `deploy.sh` runs bootstrap only with `EF_RUN_BOOTSTRAP=yes`; preview first with `npm run db:preview-catalog -w server`.

## Sensitive documents: expected access change (NOT applied yet)
> Phase 2 update: the policy is now enforced on every route that lists or serves accident files (see `docs/ACCIDENTS-API.md`),
> for workflow cases always and for legacy cases only while `ACCIDENT_WORKFLOW_ENABLED` is on. The table below is the access change that
> switch makes for legacy cases. Where this section says "no route calls them in Phase 1" it describes Phase 1 only.

Sensitive categories: `DRIVER_ID, DRIVER_LICENSE, VEHICLE_REGISTRATION, CLAIM_FORM, INSURER_DECISION,
COMPENSATION_PROOF` and, new in this review, the legacy `POLICE_REPORT` and `INSURANCE`. The policy functions exist and are
tested, but **no route calls them in Phase 1**: today every user with `accidents.read` in scope can still list and download
these files, exactly as before (a test pins this). Enforcing the policy (Phase 2) changes access as follows:

| Role | Today | After enforcement |
|---|---|---|
| SUPER_ADMIN | all | all (holds the permission; participant rule satisfied as manager) |
| ACCIDENT_MANAGER, INSURANCE_OFFICER | read of all accidents | still see them (permission ALL; manager / assigned) |
| PROJECT_MANAGER | project accidents | still, once it holds `documents.sensitive` (pending, see above) and only for cases it created/handled |
| TECHNICAL | project accidents | only cases it is assigned to / handled |
| FINANCE, USER, VIEWER | read | **lose** these two categories (and the new sensitive ones) |
| DRIVER (reporter) | own accident | **loses** police/insurance files unless the rule is widened to "the reporter sees what they uploaded" — decision needed before Phase 2 |

Legacy accidents are not blocked from existing; only the listed categories are filtered for users without the permission.
Photos, repair invoices, "other" and the Najm report stay visible as before.

## Rolling the application back after 0010
- Database: nothing to undo. 0010 is additive; the previous release ignores the new columns/tables, and data written by the
  new release (workflow cases, claims, estimates) stays in the database. `deploy.sh rollback` switches code only.
- Remaining limits when an OLDER release runs against a database that already holds workflow cases:
  1. the old code has no guard: its legacy routes can edit/close a workflow case and so bypass the stages;
  2. it counts drafts as open accidents;
  3. if the old release's bootstrap were run it would delete the new permissions from the catalog and with them the new
     roles' grants (bootstrap is opt-in; never run it during a rollback).
- Operating plan: the Phase 2 routes ship behind a switch that is **off** by default, so no workflow case exists until the new
  release is confirmed healthy. Before the first workflow case exists, a code rollback is clean. After it, treat problems
  as roll-forward (hotfix) and do not roll back; if a rollback is unavoidable, first stop users from using the legacy
  accident routes (maintenance window) and do not run bootstrap. No database trigger is added in 0011 for now (decision recorded);
  it remains an option if the exposure becomes unacceptable.

## Test-database safety
Destructive tests (`drop schema`, `create/drop database`) run only against a local, test-named database:
`tests/support/db-guard.ts` runs in `vitest.config.ts`, `global-setup` and `setup` before any connection and refuses
RDS/AWS/Render/other cloud or `prod*` hosts, non-local hosts (CI hosts via `EF_TEST_DB_ALLOWED_HOSTS`, never a cloud name),
databases not named `*test*` or named like production, `NODE_ENV=production`, a production-like `DATABASE_URL`, and a connected
database carrying the production designation comment — a "test" in the name alone is not enough.
