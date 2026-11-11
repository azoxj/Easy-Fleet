# New production database — initialization without demo or test data

Scope: the NEW AWS database `easyfleet_production`. Render (database and files) is the legacy environment: nothing here
connects to it, reads it, changes it or copies anything from it.

## 1. What was found (measured on throwaway local databases, not on Render or AWS)

| | after `migrate` + `bootstrap` | after `db:seed:demo` |
|---|---|---|
| tables | 54 (+ the migration ledger, 11 rows) | the same |
| rows in the catalog tables (`organizations` 1, `permissions` 94, `roles` 7, `role_permissions` 256) | **358** | the same |
| rows in the 50 other tables (users, projects, vehicles, drivers, employees, maintenance, insurance, registrations/documents, accidents, violations, handovers and photos, fuel, invoices/expenses, notifications, trips/GPS, files, audit log …) | **0** | **915** (users 14, vehicles 17, projects 4, employees 18, drivers 11, maintenance requests 17 / events 72, handovers 5 / photos 40, files 66, audit logs 172, …) |
| organization row | `Easy Fleet` | renamed `Easy Fleet Demo Company` with a demo legal name, address and e-mail |

Consequences:
- **A database created by `migrate` + `bootstrap` is clean by construction.** `bootstrap` writes the catalog (re-synced from code on every start) and, only if you ask, one administrator. It writes no audit row, no notification, no file.
- **The demo seed is the only source of demo data** and it is only ever run by hand (`npm run db:seed:demo[:render]`). Nothing in `render.yaml`, `start:render`, `preDeployCommand`, the deploy scripts or CI calls it (checked by a test). In production it refuses without `ALLOW_DEMO_SEED=true` **and** `DEMO_PASSWORD`; additionally it now **always refuses on a database named `easyfleet_production`** (or any name in `EF_PRODUCTION_DB_NAMES`) and whenever `EF_FORBID_DEMO_SEED=true` (set in the AWS environment template).
- **There are no hard-coded accounts or passwords** in the code. The first administrator comes from `BOOTSTRAP_ADMIN_EMAIL` + a password read from a secret file; it must change its password at the first login (`mustChangePassword`), and the password policy applies.
- **A test run on the production database cannot be undone.** `audit_logs` and `maintenance_events` are append-only (a database trigger rejects UPDATE, DELETE and TRUNCATE, and the schema must not be touched). Any login, handover or action in that database leaves rows there for good. So the order is: **rehearse on a separate database, then initialize production once.**

## 2. The plan

1. **Rehearsal database** `easyfleet_staging` (same RDS instance or a scratch one): run the whole AWS smoke test and the demo data there if you want to. It is disposable: drop and recreate it at will.
2. **Production database** `easyfleet_production`: created empty, migrated, bootstrapped — and *never* used for tests. No cleaning is needed because nothing is ever put there.
3. **Certify** it with the report below (`CLEAN CHECK: PASS`, all demo markers 0) before the administrator logs in for the first time and again before real data is entered.
4. If, against the plan, test rows reach it: use the tool (section 4) when they are only in the operational tables; if they reached the append-only tables, **drop and recreate the database** (nothing real exists yet, so nothing is lost).

## 3. Creating the database (manual, by the database owner)

On RDS, as the master user (never put the passwords in shell history or in the repository; use `\password`, and Secrets Manager for the value):
```sql
CREATE ROLE easyfleet_app LOGIN;            -- then:  \password easyfleet_app
GRANT easyfleet_app TO <master user>;       -- RDS requires membership to create a database owned by another role
CREATE DATABASE easyfleet_production OWNER easyfleet_app ENCODING 'UTF8' TEMPLATE template0;
REVOKE ALL ON DATABASE easyfleet_production FROM PUBLIC;
-- rehearsal database, same way:
CREATE DATABASE easyfleet_staging OWNER easyfleet_app ENCODING 'UTF8' TEMPLATE template0;
```
Then, in Secrets Manager (`easy-fleet/prod`): `DATABASE_URL = postgres://easyfleet_app:<url-encoded password>@<rds endpoint>:5432/easyfleet_production`. The first `deploy.sh release` applies the migrations (`migrate.js`); the catalog sync (`bootstrap.js`) runs only when the release is started with `EF_RUN_BOOTSTRAP=yes`, which the first release on an empty database needs.

First administrator (once): put `BOOTSTRAP_ADMIN_EMAIL` and `BOOTSTRAP_ADMIN_NAME` in the env file and the password in the secret `BOOTSTRAP_ADMIN_PASSWORD` (a strong one chosen by the person who will use it), run the release, log in, **change the password**, then delete the three `BOOTSTRAP_*` settings and the secret key. The system role `SUPER_ADMIN` is the only role it receives; other users are created from the application.

## 4. The initialization tool

`npm run db:init-production -w server` (compiled: `node dist/scripts/init-production-db.js`), driven only by `DATABASE_URL`.

**Default = report only. It changes nothing.** It prints: database name, host, environment, designation status, the organization, every table with its row count and what would happen to it (kept catalog / will be emptied / protected append-only), the administrators (masked), the uploaded files (count, size, provider), the demo-marker counts, `CLEAN CHECK: PASS|FAIL` and a **PLAN HASH**. Credentials are never printed.

`--apply` runs only when **all** guards pass (the report lists each one):

| Guard | Meaning |
|---|---|
| `target-database` | `--target-db=<name>` **and** `EF_INIT_TARGET_DB=<name>` both equal the actual database name |
| `host-not-render` | never a Render host (`*.render.com`, `onrender.com`, `dpg-…`) |
| `host-allowed` | host must end with `.rds.amazonaws.com` (override `EF_INIT_ALLOWED_HOST_SUFFIXES` — only for rehearsals) |
| `designated` | the database owner has set `COMMENT ON DATABASE easyfleet_production IS 'easy-fleet:allow-init'`; the tool **removes the comment when it finishes**, so it cannot run twice by accident |
| `plan-hash` | `--plan-hash=<hash of the report you approved>`: if anything changed since, it refuses |
| `protected-tables-empty` | `audit_logs` and `maintenance_events` hold no rows; otherwise: recreate the database |
| `files-confirmed` | if uploaded-file rows exist, `--delete-files` is required |
| `kept-admin-valid` | `--keep-admin=<email>` (optional) must be an existing SUPER_ADMIN |

What an apply does, in **one transaction** (any failure rolls everything back): deletes the rows of every operational table, children before parents (no `DROP`, no `ALTER`, no `TRUNCATE`, constraints/indexes/triggers/permissions untouched); resets their counters; keeps the one administrator named by `--keep-admin` (if any); resets a demo-looking organization (name, legal name, address, e-mail) or sets `--org-name`; verifies that every cleaned table is empty and every constraint valid. Afterwards it re-syncs the catalog from code, deletes the file objects **listed in the `files` table** (never lists or sweeps a bucket) and clears the designation. Not touched: the catalog (`organizations`, `permissions`, `roles`, `role_permissions`), the append-only tables, the migration ledger, everything outside schema `public`.

## 5. Files

A new AWS environment starts with a new, empty, private S3 bucket: nothing is copied from Render, so there are no demo photos or documents. The tool only deletes objects whose keys are in the `files` table of the database it runs on. The Render disk is never read or modified.

## 6. Optional: is there demo data on Render? (read-only, you run it)

I did not connect to Render. If you want to know, run this on the Render database in a read-only transaction (it only counts):
```sql
BEGIN READ ONLY;
SELECT (SELECT count(*) FROM users WHERE email ILIKE '%@example.com' OR name LIKE '%(تجريبي)%') AS demo_users,
       (SELECT count(*) FROM vehicles WHERE plate_number ILIKE 'DEMO-%') AS demo_vehicles,
       (SELECT count(*) FROM projects WHERE code ILIKE 'DEMO%' OR name LIKE '%تجريبي%') AS demo_projects,
       (SELECT count(*) FROM organizations WHERE name ILIKE '%demo%') AS demo_organizations;
ROLLBACK;
```
Render stays as it is (Backup/Legacy) until the move to AWS is finished.

## 7. Final verification (after the database exists)

1. `db:init-production` report on `easyfleet_production` → `CLEAN CHECK: PASS`, every demo marker `0`, organization not demo, `uploaded files: 0`.
2. `SELECT count(*) FROM drizzle.__drizzle_migrations` = number of migration files.
3. `SELECT count(*) FROM pg_constraint WHERE NOT convalidated` = 0 (foreign keys valid).
4. `grep -r "ALLOW_DEMO_SEED\|DEMO_PASSWORD" /etc/easy-fleet` → nothing; `EF_FORBID_DEMO_SEED=true` present.
5. Tests, typecheck, build in CI (they include the guards above).
