# Plan: isolated rehearsal on a copy of the production RDS snapshot

**Plan only. No AWS resource has been created, no snapshot touched.** Each step below needs the owner's explicit approval before it is run.

Purpose: apply migration `0010` and run the release against production-sized data, measure the migration time and verify legacy accidents are unchanged — without any way to reach production data, users or the outside world.

## 1. Isolation
- **Separate network:** a new VPC (new CIDR, no peering, no transit gateway, no VPN) with private subnets only. No internet gateway and **no NAT gateway**, so nothing in it can reach the Internet. This alone makes real e-mail, map-tile fetches and third-party integrations impossible, whatever the data says.
- **Access:** SSM Session Manager through VPC interface endpoints (`ssm`, `ssmmessages`, `ec2messages`) and an S3 gateway endpoint (free) for the release package. No SSH, no public IPs, no load balancer; browser checks use SSM port-forwarding to `localhost`.
- **Security groups:** the database accepts 5432 only from the rehearsal app instance's group; the app instance has no inbound rules and outbound only to the database and the VPC endpoints.
- **Accounts/permissions:** a dedicated IAM role for the app instance that cannot read `easy-fleet/prod` secrets or the production S3 bucket (explicit deny); a permission boundary restricting the operator's rehearsal actions to resources tagged `purpose=ef-rehearsal`. Prefer a separate AWS account if one exists.
- **Tags on everything:** `purpose=ef-rehearsal`, `owner`, `delete-after=<date>`.

## 2. Data protection
- The copy contains real personal data (drivers' ID numbers, phones, e-mails): treat it as production data. Copy the snapshot **within the same region**, re-encrypting it with a **new KMS key** created for the rehearsal (the key policy names the operator role only); restore from that copy with a **new instance identifier, a new master password** (generated, never written to a file in the repository, stored only in the rehearsal's own Secrets Manager entry) and `rds.force_ssl=1`.
- No public access, no cross-account share, no export to S3/CSV, no `pg_dump` off the instance, no screenshots with real data in tickets/PRs.
- Access limited to named people; CloudWatch/SSM session logs on; everything deleted at the end (section 6).
- Application files: do **not** attach the production bucket. Use a local empty storage directory on the instance (attachments of old records simply 404). If real files are needed for one check, copy a handful of specific objects into a rehearsal bucket created for it.

## 3. No real notifications (defence in depth)
1. Network: no route out (section 1).
2. Configuration: the rehearsal env file has **no** `SMTP_*`, no `EMAIL_SETTINGS_KEY` (the SMTP password saved from the admin page cannot be decrypted), map tiles unconfigured, `PUBLIC_APP_URL` pointing at the rehearsal address.
3. Data, **before the application is started for the first time** (run over SSM on the copy only, after confirming the endpoint name is the rehearsal's): cancel queued mail (`update email_log set status = <non-send status> where status = 'QUEUED'`), delete `email_settings` rows, disable `integration_settings` rows, delete `password_reset_tokens`, clear `sessions` and `rate_limits`. The exact statements are written and reviewed with the owner in the approval step; they are not part of this PR.
4. Verification: after startup, `select status, count(*) from email_log group by 1` shows nothing queued/sent; the application log shows no outbound attempts.
5. Logins: create a rehearsal administrator with the existing `db:reset-admin-password` tool on the copy; real users' passwords are never used or reset.

## 4. Test sequence (on the copy)
1. Read-only: `db:verify-aws` (ledger, which migrations are unapplied), row counts and a checksum of `accidents` / `accident_attachments`.
2. `time node dist/scripts/migrate.js`; re-run the checksum (legacy rows must be identical); `\d accidents` shows the 17 new nullable columns.
3. Start the release with **both flags false**; open the legacy accident screens, dashboards, reports.
4. `db:preview-catalog`, then `db:sync-accident-catalog` preview → apply (with `--include-technical` and `--include-project-manager-sensitive`, after the owner approves those on the copy).
5. Flip `ACCIDENT_WORKFLOW_ENABLED=true` **on the copy only**; walk a case from draft to closed; flip it off and check the legacy routes cannot edit it; restart.
6. Lock behaviour: run the migration while a long transaction holds `accidents` open in a second session, to see the wait (`pg_stat_activity`).

## 5. Estimated cost (rough; confirm with the AWS Pricing Calculator for the actual region, eu-central-1 assumed)
| Item | Basis | ~Cost |
|---|---|---|
| RDS `db.t4g.medium` | ≈ $0.07–0.09 / hour | ≈ $2 / day |
| RDS storage gp3 (size of production, 50 GB assumed) | ≈ $0.12 / GB-month | ≈ $0.20 / day |
| App instance `t4g.small` + 20 GB gp3 | ≈ $0.02 / hour | ≈ $0.6 / day |
| VPC interface endpoints (3 × 1 AZ) | ≈ $0.01 / hour each | ≈ $0.7 / day |
| Snapshot copy storage | ≈ $0.05–0.10 / GB-month | cents per day |
| KMS key | $1 / month (prorated), requests negligible | ≈ $1 |
| Data transfer | inside the VPC / endpoints | ≈ $0 |
| **A one- to two-day rehearsal** | | **≈ $5–10 total** |
No NAT gateway (≈ $1+/day) and no Multi-AZ are used. Set an AWS Budget alert at $20 for the `purpose=ef-rehearsal` tag.

## 6. Deleting everything afterwards
1. Stop the app, end SSM sessions.
2. Delete the rehearsal RDS instance **by its rehearsal identifier** (check it is not the production identifier first) with no final snapshot; delete automated backups of it.
3. Delete the copied snapshot (and any manual snapshot taken during the test).
4. Terminate the app instance and its volume; delete its instance profile/role and the operator permission boundary.
5. Delete the VPC endpoints, security groups, subnets, route tables, the VPC.
6. Schedule deletion of the rehearsal KMS key (minimum waiting period 7 days; the data is unreadable once it goes) and delete the rehearsal secret(s) and bucket (if one was created).
7. Delete rehearsal log groups.
8. Verify: list resources by tag `purpose=ef-rehearsal` in the Resource Groups Tagging API (empty), check the next day's Cost Explorer for that tag, and confirm production (instance, snapshot schedule, bucket) is unchanged.
