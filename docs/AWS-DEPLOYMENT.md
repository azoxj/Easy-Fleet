# Easy Fleet on AWS — architecture, setup, release and recovery

Status: **preparation only.** Nothing described here has been created in AWS, no Render setting was touched, and
nothing was deployed. Render stays the live environment (`render.yaml`, `docs/DEPLOYMENT-RENDER.md` are unchanged)
until the AWS environment has passed the smoke test in this document. Items marked *(not tested here)* need to be
validated on the real host the first time (no AWS account, Caddy or systemd was available while preparing).

```
Internet ──HTTPS──▶ Caddy (EC2, Elastic IP, Let's Encrypt)  ──▶ Easy Fleet (Node, 127.0.0.1:4000)
                                                                   ├──TLS──▶ Amazon RDS PostgreSQL 16 (private subnets)
                                                                   └──────▶ Amazon S3 (private bucket, instance role)
```

## 1. Decisions

| Question | Decision |
|---|---|
| Docker? | **No.** One Node process on one EC2 host, with the data in RDS and S3, is simpler and more transparent as a systemd service + a releases directory (atomic switch, instant rollback). Containers would add an image registry, a runtime and a second deployment path without removing a single risk. Revisit when you want ECS/Fargate or more than one instance. |
| PM2? | **No.** systemd does restart, logging (journald), hardening and boot ordering already. |
| Reverse proxy | **Caddy**: automatic certificates, compression, JSON access log with token redaction, 20 lines of config. nginx is equally valid; the redaction rules in `deploy/aws/Caddyfile` would have to be re-expressed. |
| ALB / CloudFront | **Not needed at the start.** An Elastic IP + Caddy gives HTTPS for free. Add an ALB (topology B, `Caddyfile.alb`) when you need ACM-managed certificates, AWS WAF, or more than one instance. CloudFront is not needed (one region, one small web app, API traffic is not cacheable). **Never enable ALB/CloudFront access logs**: they record the full URL, i.e. the `/h/<token>` handover links. |
| Files | **S3 from day one** (`STORAGE_PROVIDER=s3`). The EC2 disk holds only the OS, the application and logs. |
| Database | **RDS PostgreSQL 16**, never PostgreSQL on the EC2 host. |
| Secrets | **AWS Secrets Manager → files under `/run/easy-fleet/secrets` → `NAME_FILE=` variables.** No secret is stored in Git, in the environment file, or in the AMI. |

## 2. Resources

### EC2 (application)
- Ubuntu Server 24.04 LTS (Amazon Linux 2023 works the same way). Node.js 22. **IMDSv2 required** (`HttpTokens=required`, hop limit 1) so a server-side request bug can never read the instance credentials.
- **4 vCPU / 8 GB / 100 GB is more than enough.** Node uses one core for JavaScript; the database and the files are not on this host. Start with `c6i.large` or `m6i.large` (2 vCPU) — or `c6i.xlarge` (4 vCPU / 8 GB) if you want headroom for 5x — and **30–40 GB gp3** (encrypted). 100 GB only makes sense if you want logs kept for a long time on disk.
- One Elastic IP, no SSH: administer through **SSM Session Manager** (instance profile `AmazonSSMManagedInstanceCore`).
- Time sync (chrony, default on AWS images) and unattended security upgrades.

### RDS
- PostgreSQL **16**, `db.t4g.medium` (2 vCPU, 4 GB) to start; scale to `db.m6g.large` when CPU stays above ~60 % or connections approach 80.
- gp3 **50 GB**, storage autoscaling to 200 GB. Encrypted (KMS). Private subnets (2 AZs in the subnet group, public access **off**), deletion protection **on**.
- **Automated backups on, retention 14 days (point-in-time recovery)**, a manual snapshot before each release. Multi-AZ: start single-AZ, move to Multi-AZ when a 15–60 minute outage during an instance failure is unacceptable.
- Parameter group: `rds.force_ssl=1` (default from PostgreSQL 15), `log_min_duration_statement=1000`. Export the `postgresql` log to CloudWatch. Performance Insights on (7 days are free). Enhanced Monitoring 60 s.
- The application connects with `DB_SSL=verify-full` and the AWS CA bundle (`https://truststore.pki.rds.amazonaws.com/global/global-bundle.pem` saved as `/opt/easy-fleet/rds-global-bundle.pem`).
- Application pool: 10 connections (`DB_POOL_MAX`), 5 s wait for a free connection, 30 s per statement, 60 s idle-in-transaction cap. Connections to RDS are well below the instance limit.

### S3
- One **private bucket** (Block Public Access: all four on), default encryption SSE-KMS (or SSE-S3), **versioning on**, bucket owner enforced (no ACLs).
- Lifecycle: delete **non-current versions after 90 days**, abort incomplete multipart uploads after 7 days. Do not expire current objects.
- Bucket policy: deny any request without TLS.
```json
{ "Sid": "DenyInsecureTransport", "Effect": "Deny", "Principal": "*", "Action": "s3:*",
  "Resource": ["arn:aws:s3:::BUCKET", "arn:aws:s3:::BUCKET/*"],
  "Condition": { "Bool": { "aws:SecureTransport": "false" } } }
```
- The browser never talks to S3 and never receives credentials or signed URLs: the server authorizes the record (permissions, project scope, organization) and streams the object. Keys are `<organizationId>/<uuid>` and are validated before every call.

### IAM role of the instance (least privilege)
```json
{ "Version": "2012-10-17", "Statement": [
  { "Sid": "FileObjects", "Effect": "Allow", "Action": ["s3:GetObject", "s3:PutObject", "s3:DeleteObject"], "Resource": "arn:aws:s3:::BUCKET/files/*" },
  { "Sid": "FileBucket",  "Effect": "Allow", "Action": ["s3:ListBucket"], "Resource": "arn:aws:s3:::BUCKET" },
  { "Sid": "Secrets",     "Effect": "Allow", "Action": ["secretsmanager:GetSecretValue"], "Resource": "arn:aws:secretsmanager:REGION:ACCOUNT:secret:easy-fleet/prod-*" },
  { "Sid": "Kms",         "Effect": "Allow", "Action": ["kms:Decrypt", "kms:GenerateDataKey"], "Resource": "arn:aws:kms:REGION:ACCOUNT:key/KEY-ID" }
] }
```
(`s3:ListBucket` is what `HeadBucket` — the readiness check — needs; the `Kms` statement only if you use a customer-managed key.) Attach `AmazonSSMManagedInstanceCore` and `CloudWatchAgentServerPolicy`.

## 3. Network and security groups

| Group | Inbound | Outbound |
|---|---|---|
| `sg-easyfleet-app` (topology A) | 80 and 443 from `0.0.0.0/0` (Caddy: certificate challenge + HTTPS). **Nothing else — not 4000, not 22.** | 443 (AWS APIs, npm, Let's Encrypt), 587 (SES SMTP), 5432 to `sg-easyfleet-db`, DNS |
| `sg-easyfleet-db` | **5432 from `sg-easyfleet-app` only** | none needed |

Topology B: 443 on the ALB's group from the internet, Caddy's 8080 from the ALB group only. VPC: two private subnets for RDS, one public subnet for the instance (Elastic IP — no NAT gateway needed). Add an **S3 gateway endpoint** (free) so file traffic never leaves the AWS network. Port 25 is throttled on EC2: use SES on 587.

DNS: an `A` record to the Elastic IP (Route 53 or any DNS). **Use your own domain, not a provider URL**: handover links already handed to drivers contain the host name (see §8).

## 4. Environment variables

The complete annotated template is `deploy/aws/easy-fleet.env.example` (installed as `/etc/easy-fleet/easy-fleet.env`, `0640 root:easyfleet`). Every variable is read from the environment; nothing depends on Replit, Render or any other platform.

| Group | Variables | Where it lives |
|---|---|---|
| Application | `NODE_ENV=production`, `PORT`, `APP_ORIGINS`, `APP_URL`, `PUBLIC_APP_URL`, `COOKIE_SECURE=true`, `TRUST_PROXY`, `WEB_DIST_DIR`, `APP_TIMEZONE`, `SESSION_*`, `MAX_UPLOAD_MB` | env file |
| Database (**secret**: connection string) | `DATABASE_URL_FILE` → `DATABASE_URL`; `DB_SSL`, `DB_SSL_CA_FILE`, `DB_POOL_MAX`, `DB_CONNECTION_TIMEOUT_MS`, `DB_STATEMENT_TIMEOUT_MS`, `DB_IDLE_IN_TX_TIMEOUT_MS` | secret file + env file |
| Files | `STORAGE_PROVIDER=s3`, `S3_BUCKET`, `S3_REGION`, `S3_PREFIX`, `S3_SSE`, `S3_KMS_KEY_ID`, `DISK_MIN_FREE_MB`, `ORPHAN_FILE_CLEANUP`, `ORPHAN_FILE_DAYS`. **No AWS access keys**: the instance role is used. | env file |
| Email (**secret**: user and password) | `SMTP_HOST/PORT/SECURE`, `EMAIL_FROM`, `EMAIL_FROM_NAME`, `SUPPORT_EMAIL`; `SMTP_USER_FILE`, `SMTP_PASSWORD_FILE` | env file + secret files |
| Encryption (**secret**) | `EMAIL_SETTINGS_KEY_FILE` — protects SMTP/integration credentials saved from the admin screens. **Must be the same value as on Render** when you migrate the database. | secret file + the company password vault |
| Bright Washing (**secret**) | `BRIGHT_WASHING_BASE_URL` (env file); `BRIGHT_WASHING_INTEGRATION_ID_FILE`, `BRIGHT_WASHING_API_SECRET_FILE` | server-side only, never sent to the browser |
| First administrator | `BOOTSTRAP_ADMIN_EMAIL`, `BOOTSTRAP_ADMIN_NAME`, `BOOTSTRAP_ADMIN_PASSWORD_FILE` — remove after the first start | env file / secret file |
| Logging | `LOG_LEVEL`, `LOG_FORMAT=json`, `LOG_REQUESTS=true`, `SHUTDOWN_TIMEOUT_SECONDS` | env file |

There is no session secret: sessions are random tokens stored hashed in PostgreSQL. Secrets Manager holds **one JSON secret** (`easy-fleet/prod`) with the keys `DATABASE_URL`, `EMAIL_SETTINGS_KEY`, `SMTP_USER`, `SMTP_PASSWORD`, `BRIGHT_WASHING_INTEGRATION_ID`, `BRIGHT_WASHING_API_SECRET`; `deploy/aws/fetch-secrets.sh` writes each key to its own file (tmpfs, `0640 root:easyfleet`) and the application reads it through `NAME_FILE`. Nothing prints a secret value, and the structured logger redacts credentials, tokens and connection strings.

## 5. Host setup (once)

```bash
# Ubuntu 24.04, as a sudo user (through SSM Session Manager)
sudo apt-get update && sudo apt-get -y upgrade && sudo apt-get install -y curl jq unzip ca-certificates gnupg
curl -fsSL https://deb.nodesource.com/setup_22.x | sudo -E bash - && sudo apt-get install -y nodejs
# Caddy: follow https://caddyserver.com/docs/install#debian-ubuntu-raspbian
# AWS CLI v2: https://docs.aws.amazon.com/cli/latest/userguide/getting-started-install.html

sudo useradd --system --home /opt/easy-fleet --shell /usr/sbin/nologin easyfleet
sudo install -d -m 0755 /opt/easy-fleet /opt/easy-fleet/releases
sudo install -d -o root -g easyfleet -m 0750 /etc/easy-fleet
sudo curl -fsSL -o /opt/easy-fleet/rds-global-bundle.pem https://truststore.pki.rds.amazonaws.com/global/global-bundle.pem
sudo install -m 0640 -o root -g easyfleet deploy/aws/easy-fleet.env.example /etc/easy-fleet/easy-fleet.env   # then edit it
sudo install -m 0644 deploy/aws/easy-fleet.service /etc/systemd/system/easy-fleet.service
sudo install -m 0644 deploy/aws/Caddyfile /etc/caddy/Caddyfile                                           # edit the host name first
sudo printf '[Journal]\nSystemMaxUse=1G\nMaxRetentionSec=30day\n' | sudo tee /etc/systemd/journald.conf.d/easy-fleet.conf
sudo systemctl daemon-reload && sudo systemctl enable easy-fleet && sudo caddy validate --config /etc/caddy/Caddyfile && sudo systemctl reload caddy
```
Uncomment `ExecStartPre=+…/fetch-secrets.sh` in the unit when you use Secrets Manager, and set `EF_SECRET_ID`/`AWS_REGION` for it in a drop-in (`systemctl edit easy-fleet`). *(not tested here)*

**systemd**: runs as the unprivileged `easyfleet`, `Restart=always`, `RestartSec=5`, `StartLimitBurst=10`/5 min, `KillSignal=SIGTERM`, `TimeoutStopSec=30` (the app's own grace period is 15 s), strict filesystem hardening. On SIGTERM the app turns `/api/readyz` into 503 immediately, stops accepting connections, lets in-flight requests finish, stops its timers and drains the database pool; an uncaught exception also ends in this graceful path and systemd restarts the service.

## 6. HTTPS, proxy and client addresses

- `COOKIE_SECURE=true` is mandatory in production (the session cookie is `__Host-`/`Secure`, and the camera, GPS and PWA need a secure context). Caddy obtains the certificate itself (ports 80/443 open to the internet).
- `TRUST_PROXY` = the number of proxies between the client and Node: **Caddy only = 1** (the production default), ALB + Caddy = 2, CloudFront + ALB + Caddy = 3. A wrong value makes every user share the proxy's address and breaks the rate limits (600 requests/min per IP, 30 logins/15 min per IP, per-account lockout) and the IPs in the audit log. After deployment, check that a login audit row shows the real client IP.
- The access log (`/var/log/caddy/easy-fleet-access.log`, JSON, rotated) redacts `/h/<token>` and `/api/public/handover/<token>` and drops cookies, the CSRF header, `Authorization` and `Referer` (the Referer of an API call made by the handover page contains the token). The application's own request log applies the same redaction and never logs headers, cookies, bodies or query strings. Do not add other log destinations that record URLs.
- The application serves the API, the built web app and the SPA fallback, so there is a single place for the security headers (CSP, HSTS, frame, nosniff, referrer, permissions). Caddy adds TLS, compression and logging. HSTS (one year, `includeSubDomains`) is sent by the application: use a real public certificate, not a private CA.
- Uploads: Caddy limits request bodies to 12 MB (keep it a little above `MAX_UPLOAD_MB`).

## 7. Release and rollback

CI (`.github/workflows/ci.yml`) runs typecheck, tests (with PostgreSQL 16), build and `npm audit` on every push/PR and builds the release tarball as a build artifact. It needs no secrets. **A push never reaches AWS by itself.** The recommended pipeline is `GitHub → CI → build artifact → manual approval (GitHub Environment "production") → S3 → SSM Run Command → deploy.sh`; `.github/workflows/deploy-aws.yml.example` is the template (GitHub OIDC role, no stored keys), kept inactive until the AWS side exists.

Manual release (works without any workflow):
```bash
# on your machine / CI:   ./deploy/aws/package-release.sh      → dist-release/easy-fleet-<sha>.tgz (+ .sha256)
# 1. take an RDS snapshot (console or `aws rds create-db-snapshot …`)
# 2. copy the tarball to the instance (SSM / S3), then on the instance:
sudo CONFIRM_BACKUP=yes [EF_RUN_BOOTSTRAP=yes] /path/to/deploy.sh release /tmp/easy-fleet-<sha>.tgz <sha256>
sudo /opt/easy-fleet/current/deploy/aws/deploy.sh status
```
`deploy.sh release`: unpack to `/opt/easy-fleet/releases/<utc timestamp>` → `npm ci --omit=dev` → refresh secrets → **database migrations** (`migrate.js`: advisory lock, all pending migrations in one transaction) and, **only with `EF_RUN_BOOTSTRAP=yes`**, the role/permission sync (skipped by default; preview it first with `npm run db:preview-catalog -w server`, read-only) → switch the `current` symlink → restart → wait for `/api/readyz` (60 s) → **automatic code rollback** if it does not become ready. The last 5 releases are kept.
Rollback by hand: `sudo deploy.sh rollback`. Migrations are forward-only and have been additive (0006 tables, 0007 handover link columns, 0008 indexes): the previous code runs on the migrated schema. A migration that is not additive would need a restore of the pre-release snapshot — which is what `CONFIRM_BACKUP=yes` is for.

## 8. Moving from Render (data and links)

Render keeps running throughout. Order:
1. **Custom domain first**: handover links already sent to drivers are full URLs on the current host. Put your own domain on Render now, so the same URLs keep working after the DNS switch. (Links on `onrender.com` stop working when Render is switched off.)
2. Backup of the Render database (done before any change) and a copy of `EMAIL_SETTINGS_KEY` from the Render environment into Secrets Manager — **the same value**, otherwise the encrypted SMTP/integration secrets saved in the database become unreadable.
3. Build AWS (RDS, S3, EC2) and run the smoke test with an **empty** database first.
4. Cutover window: stop writes on Render (maintenance notice, scale the web service to 0), `pg_dump -Fc --no-owner --no-acl` (Render's database only allows internal connections: add your address to its allow list for the window), `pg_restore` into RDS, copy the files (Render persistent disk → `STORAGE_SOURCE_DIR`, via Render SSH), then `STORAGE_PROVIDER=s3 … node dist/scripts/migrate-storage-to-s3.js` (dry run by default; `--apply` to copy; idempotent, never deletes, same keys so no row changes) and `deploy.sh release` (applies only the migrations not yet recorded).
5. Smoke test on AWS (§12), then switch DNS (low TTL set beforehand).
6. Keep Render untouched for a few days. Falling back = point DNS back; data written on AWS since the cutover would have to be dumped back (so keep the window short and the decision early).

## 9. Backup and restore

| What | How | Retention | RPO / RTO |
|---|---|---|---|
| PostgreSQL | RDS automated backups + PITR; manual snapshot before every release and monthly; optional copy of snapshots to a second region | 14 days PITR (raise to 35), snapshots 12 months | RPO ≈ 5 min (PITR) · RTO 30–90 min (restore creates a new instance: update `DATABASE_URL` in Secrets Manager, restart) |
| Files (S3) | Versioning (+ optional replication to a second bucket/region); deleting a file in the app never deletes an object (soft delete), the orphan cleanup is opt-in | non-current versions 90 days | RPO ≈ 0 (versions) · RTO minutes (restore a version or point the app at the replica bucket) |
| Configuration | `/etc/easy-fleet/easy-fleet.env` (no secrets) and `Caddyfile` in a private ops repository / SSM Parameter Store; secrets in Secrets Manager (versioned, 30-day recovery window) | — | — |
| `EMAIL_SETTINGS_KEY` | additionally kept in the company password vault, **separately** from the other backups | — | losing it loses the saved SMTP and integration secrets (they are re-entered, nothing else is affected) |

Restore test: **quarterly**, restore the latest PITR/snapshot to a scratch RDS instance, point a throwaway copy of the app at it (separate S3 prefix or read-only), log in, open a vehicle with photos. Not performed yet — nothing was backed up or restored while preparing this document.

## 10. Logging and monitoring

- Application: structured JSON to stdout/stderr → journald. Fields: `ts, level, msg, requestId, method, path (token redacted), status, ms, ip, userId`; 5xx and unexpected errors carry an `errorId` that is also returned to the client (`error.errorId`) and echoed in the `X-Request-Id` response header. Never logged: passwords, session or CSRF tokens, handover tokens, API secrets, `DATABASE_URL`, S3 credentials, bodies, headers, cookies.
- `GET /api/healthz` = the process is alive (no dependencies). `GET /api/readyz` = not draining, PostgreSQL answers `select 1` (3 s limit), migrations applied (cached 60 s), file storage usable (S3 `HeadBucket` cached 30 s, no object transferred; local: writable with free space) and the volume for logs/temp files has at least `DISK_MIN_FREE_MB`. Booleans only.
- To monitor (CloudWatch agent, RDS metrics, journald/Caddy log metric filters, Route 53 health check or Synthetics on `/api/readyz` from outside):

| Metric | Alarm |
|---|---|
| EC2 CPU | > 80 % for 10 min |
| EC2 memory, disk (CloudWatch agent) | memory available < 15 %; root disk free < 20 % |
| RDS CPU, `DatabaseConnections`, `FreeStorageSpace`, `FreeableMemory`, read/write latency | CPU > 80 %; connections > 80; storage < 20 %; memory < 500 MB |
| API 5xx rate and response time | 5xx > 1 % of requests for 5 min (Caddy log `status`, or the journald `level=error` count); p95 > 2 s |
| `/api/readyz` | any 503 for 2 consecutive minutes (external probe) |
| Backups | RDS event "backup failed", no snapshot in 26 h (AWS Backup/EventBridge) |
| S3 | 5xx and 4xx request metrics on the bucket |
| Authentication | spikes of `AUTH_LOGIN_FAILED`/`SECURITY_RATE_LIMITED` in the audit log, 401/429 counts in the request log |
| Background jobs | Settings → System shows the last run; alarm on the journald message `background jobs failed` or no run for 8 h |

## 11. What remains true of this architecture

One application instance (the rate limiter, the map-tile cache and the background jobs are in-process). More than one instance first needs those moved out, and a second thought about deploys. That is by design for the current size (see the capacity notes in the audit): 100–200 concurrently active users are comfortable on one 2–4 vCPU instance and `db.t4g.medium`.

## 12. Smoke test (after every release, and before the DNS cutover)

Run it against the **rehearsal database** `easyfleet_staging`, not `easyfleet_production`: test activity leaves append-only audit rows that can never be removed (see `docs/PRODUCTION-INITIALIZATION.md`).


1. `curl -fsS https://HOST/api/healthz` and `/api/readyz` → 200, `status: ready`.
2. Log in as the administrator; the audit log row shows your real public IP (proves `TRUST_PROXY`).
3. Create a handover link → open it in a private window → upload the first photo → in S3 an object `files/<orgId>/<uuid>` exists; download the photo from the handover page as an administrator.
4. Close the link → the page says "هذا الرابط غير فعال"; reopen/renew → the old link is dead, the new one works. A viewer cannot close or renew.
5. Settings → تكامل API: the Bright Washing card turns on, test and sync report "بانتظار إعداد API الغسيل الساطع".
6. `grep` the Caddy log and `journalctl -u easy-fleet` for the token of the link you just used → **no match**; no `5xx` lines.
7. Stop the service (`systemctl stop easy-fleet`): `/api/readyz` answers 503 first, the process exits within seconds, `systemctl start` brings it back.
8. RDS: `SELECT count(*) FROM drizzle.__drizzle_migrations` equals the number of migration files in the release.
