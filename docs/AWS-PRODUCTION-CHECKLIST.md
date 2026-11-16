# AWS production checklist — Easy Fleet

Companion of `docs/AWS-DEPLOYMENT.md`. Tick every box before the DNS cutover; keep the completed copy with the change record.
Render remains the live environment until section F is done.

## A. Done in the repository (no AWS account needed)
- [x] Storage abstraction: `STORAGE_PROVIDER=local|s3`; local provider unchanged for Render/dev; private S3 provider (instance role, SSE, no public access, no URLs or credentials to the browser); keys validated before every call (`<uuid>/<uuid>`); `sendStoredFile` now also checks the organization.
- [x] Copy tool for existing files: `storage:migrate-to-s3` (dry run by default, same keys, idempotent, never deletes).
- [x] PostgreSQL reliability: pool error handler, connection timeout (5 s), `statement_timeout` (30 s), `idle_in_transaction_session_timeout` (60 s), TLS modes for RDS (`DB_SSL`, CA bundle), connection failures answered as 503 + `Retry-After`; no automatic query retry (it could duplicate a write).
- [x] Graceful shutdown (readiness 503 first, drain, pool close), process-level handlers, restart through systemd.
- [x] `/api/healthz` (alive) and `/api/readyz` (not draining + DB + migrations (cached) + storage + free disk).
- [x] `TRUST_PROXY` defaults to 1 in production; explicit values honoured; warning when forced to 0.
- [x] Structured logging with request IDs and error IDs; tokens, credentials, cookies, headers, bodies, query strings never logged; handover paths redacted.
- [x] SMTP host guard (loopback, link-local/metadata, odd IP spellings) on the admin setting.
- [x] Secrets from files (`*_FILE`) for Secrets Manager/systemd; Bright Washing env variables supported (server-side only).
- [x] Migration 0008: five foreign-key indexes (additive, `IF NOT EXISTS`).
- [x] Opt-in orphan file cleanup (`ORPHAN_FILE_CLEANUP=true`): only files no foreign key references, older than `ORPHAN_FILE_DAYS`.
- [x] `deploy/aws`: systemd unit, Caddy (A) and ALB (B) configs with token redaction, env template, secrets fetcher, release/rollback script, release packager. CI workflow (no secrets) and a manual-approval deploy template.
- [ ] *(not tested here)* `caddy validate`, the systemd unit and `deploy.sh` on a real Ubuntu host.

## B. Manual, in the AWS console (not done — nothing was created)
- [ ] Account hygiene: MFA on root and admins, billing alarm, CloudTrail on, a region chosen (`eu-central-1` is where Render runs today).
- [ ] VPC: 2 private subnets (RDS), 1 public subnet (EC2), S3 gateway endpoint, security groups per `AWS-DEPLOYMENT.md` §3 (no 22, no 4000, 5432 only from the app group).
- [ ] RDS PostgreSQL 16, `db.t4g.medium`, gp3 50 GB (autoscaling 200), encrypted, private, deletion protection, backup retention ≥ 14 days, Performance Insights, CloudWatch log export, parameter group (`rds.force_ssl=1`).
- [ ] S3 bucket: Block Public Access (4/4), versioning, default encryption, deny-non-TLS policy, lifecycle (non-current 90 days, abort multipart 7 days).
- [ ] Secrets Manager secret `easy-fleet/prod` with the six keys (§4 of the deployment guide); `EMAIL_SETTINGS_KEY` **copied from Render**.
- [ ] IAM instance role (least-privilege policy in the guide) + SSM + CloudWatch agent policies; EC2 with IMDSv2 required, encrypted gp3 30–40 GB, Elastic IP.
- [ ] DNS for your own domain (low TTL); the same domain already added on Render so handover links survive the switch.
- [ ] SES: domain verified (DKIM/SPF), production access requested, SMTP credentials stored in Secrets Manager.
- [ ] CloudWatch agent (memory, disk), alarms from the monitoring table, an external probe on `/api/readyz`, SNS topic to the on-call address.

## C. Manual, on the host
- [ ] Host setup commands (`AWS-DEPLOYMENT.md` §5), env file edited, `caddy validate`, journald limits.
- [ ] First release with `deploy.sh` on an **empty** database, run with `EF_RUN_BOOTSTRAP=yes` (bootstrap is skipped by default; see "Permission catalog" in `docs/SECURITY.md`); administrator created through `BOOTSTRAP_*`, then the bootstrap lines/variables removed.
- [ ] `/etc/easy-fleet/easy-fleet.env` contains no secret (`grep -iE 'password|secret|key' … ` shows only `*_FILE` paths and non-secret names).

## D. Smoke test — on the REHEARSAL database `easyfleet_staging`, never on `easyfleet_production` (`AWS-DEPLOYMENT.md` §12)
The append-only audit trail means test activity can never be removed from a database. Production is created empty and certified clean (`docs/PRODUCTION-INITIALIZATION.md`).
- [ ] health + ready · real client IP in the audit log · handover photo lands in S3 and downloads · close/open/renew link behaviour · permissions (viewer cannot manage links) · Bright Washing card shows "بانتظار إعداد API" · no token in Caddy/app logs · stop/start shows 503-then-exit-then-recover · migration count matches.
- [ ] A forced failure is survived: stop PostgreSQL access (security group) for a minute → API answers 503, `/api/readyz` 503, the process stays up and recovers when access returns.

## D2. New production database
- [ ] `easyfleet_production` created empty (owner role, no PUBLIC access), `DATABASE_URL` in Secrets Manager points to it, first release applied (migrations + catalog), first administrator created through `BOOTSTRAP_*` and the password changed, `BOOTSTRAP_*` removed.
- [ ] `db:init-production` report: `CLEAN CHECK: PASS`, all demo markers 0, 0 files; `EF_FORBID_DEMO_SEED=true`; no `ALLOW_DEMO_SEED`/`DEMO_PASSWORD` anywhere on the host.
- [ ] Empty private S3 bucket (nothing copied from Render).

## E. Backup and restore proven
- [ ] Manual RDS snapshot taken and **restored once** into a scratch instance; the app opened against it.
- [ ] An S3 object version deleted and restored.
- [ ] A copy of `EMAIL_SETTINGS_KEY` in the company password vault, outside AWS.

## F. Cutover from Render (only after A–E)
- [ ] Render database backup taken (and a second one right before the window); Render left untouched.
- [ ] Maintenance window announced; writes stopped on Render; final `pg_dump`; `pg_restore` to RDS; files copied (`storage:migrate-to-s3 --apply`, then run again → everything "alreadyInS3"); release applied (only migrations not yet recorded run).
- [ ] Smoke test (§D) against the restored data; DNS switched; Render kept for the agreed days; decision date to retire it.

## G. After go-live
- [ ] Alarms verified by a test notification; first week: daily look at 5xx, auth failures, readiness history, RDS connections/storage.
- [ ] Optionally turn on `ORPHAN_FILE_CLEANUP=true` after the first weeks: it only removes uploads that no record references (the foreign keys are the source of truth) and logs `orphan file cleanup` with the counts.
- [ ] Quarterly: restore test, secret rotation review (SMTP, Bright Washing), dependency audit (`npm audit --omit=dev` runs in CI).

## Remaining P0 items (what is NOT solved by the repository)
1. The AWS resources and their settings (section B), and the host setup (C) — nothing exists yet.
2. A **restore actually performed** (E): a backup that has never been restored is not a backup.
3. The **first real run** of `deploy.sh`, Caddy and the systemd unit (untested here).
4. Render → AWS cutover plan executed with a custom domain, same `EMAIL_SETTINGS_KEY`, and the data copied (F).
5. Monitoring and alerting created (B) and proven (G).

Not P0 but worth scheduling: a load test of the deployed instance (capacity figures in the audit are estimates), account/MFA hardening for admins, moving the rate limiter and jobs out of the process before a second instance, SES reputation/sandbox exit before relying on password-reset e-mail.
