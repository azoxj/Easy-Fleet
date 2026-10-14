# AWS — resources to create (in order) and the first read-only verification

Nothing here is created by the code. You create the resources by hand; the repository only verifies them.
Render is never contacted. No data is copied from Render. Real data enters `easyfleet_production` only after every step below passes.

## Ordered list of AWS resources

| # | Resource | Requirement |
|---|---|---|
| 1 | Region and account | Pick one region (for example `me-central-1` or `eu-west-1`). Use it for everything below. MFA on the root and admin users. |
| 2 | VPC, subnets, security groups | Two private subnets in different AZs for RDS, one public subnet for EC2. `sg-app` (EC2): inbound 80/443 from the internet, SSH only from your IP or SSM. `sg-db` (RDS): inbound 5432 **only from `sg-app`**. |
| 3 | KMS key (optional) | Customer key for RDS, S3 and Secrets Manager. The AWS-managed keys are also acceptable. |
| 4 | RDS PostgreSQL 16 | Single instance first (Multi-AZ later). Not publicly accessible. Encrypted. Automated backups at least 7 days, deletion protection on. Master user is for DBA work only. |
| 5 | Databases and role | As the master user run the SQL in `docs/PRODUCTION-INITIALIZATION.md` section "DBA SQL": role `easyfleet_app`, databases `easyfleet_production` and `easyfleet_staging`, `REVOKE ALL … FROM PUBLIC`. Do not run migrations or seeds there yourself. |
| 6 | S3 bucket for production | New, private, empty. Block Public Access on (all four), default encryption, versioning on, bucket-owner-enforced, TLS-only policy. Name for example `easyfleet-production-files-<account-id>`. |
| 7 | S3 bucket for staging | Same settings, separate bucket, for example `easyfleet-staging-files-<account-id>`. Never share one bucket between staging and production. |
| 8 | IAM role for EC2 | Instance profile. Allows `s3:ListBucket` on both buckets' ARNs, `s3:GetObject/PutObject/DeleteObject` on `<bucket>/*`, `secretsmanager:GetSecretValue` on the Easy Fleet secrets only, and `kms:Decrypt` if you use a customer key. Nothing else. No access keys on the server. |
| 9 | Secrets Manager | One secret per value: production DATABASE_URL, staging DATABASE_URL, `SESSION_SECRET` / signing secrets listed in `deploy/aws/easy-fleet.env.example`, SMTP password, and later the bootstrap admin password (create it only in the first-admin step). |
| 10 | EC2 instance | Amazon Linux 2023 or Ubuntu LTS, in the public subnet with `sg-app` and the role from step 8, Elastic IP attached. Node 22, systemd unit and Caddy from `deploy/aws/`. First use it for staging only. |
| 11 | DNS | Records for the staging name (for example `staging.<domain>`) and the production name pointing to the Elastic IP. Production can stay unpointed until the end. |
| 12 | Caddy | Install it with the supplied `Caddyfile`; TLS is issued automatically once DNS resolves. |
| 13 | Backups and restore test | Take an RDS snapshot, restore it into a throw-away instance, and confirm the restored `easyfleet_staging` opens. Delete the throw-away instance. |
| 14 | Monitoring | CloudWatch alarms for RDS CPU, storage and connections, EC2 status, and a ping on `/healthz`. Billing alarm. |

Stop after steps 1–9 and send me the output of the verification below. Steps 10–14 and the production deployment wait for your go-ahead.

## First verification (read only)

Run it twice, once per database, from a machine that can reach RDS (the EC2 instance, or a temporary SSM session). Use the migrated staging database for the schema check and the empty production database for the "nothing in it" check.

1. Staging: set the environment of the staging database (`DATABASE_URL` read from its secret, `STORAGE_PROVIDER=s3`, `S3_BUCKET` of the staging bucket, `EF_FORBID_DEMO_SEED=true`), then run `npm run db:migrate -w server` (the only write: it creates the schema and the catalog, and nothing else).
2. Staging: `npm run db:verify-aws -w server`.
3. Production: set `DATABASE_URL` of `easyfleet_production`, the production bucket, `EF_FORBID_DEMO_SEED=true`, then run only `npm run db:verify-aws -w server`. The database is still unmigrated, so expect `FAIL` on the migration line and the missing tables. That is correct: production is migrated by the deployment, with the first start. If you prefer to see it fully green first, the migration is idempotent and writes no business rows.

`db:verify-aws` opens a READ ONLY transaction that is always rolled back, lists the bucket (it never reads or writes objects), and prints:
endpoint, the databases visible on the server, row count per table, migrations applied versus the code, PASS/FAIL for host not Render, host is RDS, migrations complete, no operational or demo data, demo markers zero, seed protection (production database), `ALLOW_DEMO_SEED`/`DEMO_PASSWORD` absent, bucket reachable, bucket and files table empty. The exit code is non-zero on any FAIL.

Render confirmation: the tool opens exactly one database connection (`DATABASE_URL`) and one S3 client. It refuses to run against a Render host, and no Render address exists in this repository's configuration.

## After the verification passes

1. Create the real SUPER_ADMIN once (`docs/PRODUCTION-INITIALIZATION.md`, "first administrator"): bootstrap with the password from a secret file, then remove the bootstrap settings. No demo users, no seed.
2. Finish steps 10–14 and the staging smoke tests (login, browser, handover link, upload to the staging bucket, migration check).
3. Only then deploy production and begin real data entry.
