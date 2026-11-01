# AWS read-only checks (prepared, NOT executed)

Nothing here changes a resource, a file or a row. Run each block yourself, in order, from an operator session (AWS CLI with a read-only role, or SSM Session Manager on the instance). Replace the `<…>` placeholders. Region is `eu-central-1` in the repository examples; use the real one.
Do not paste output containing connection strings or secrets into tickets; the commands below print none.

## 0. Rules for every command
- AWS CLI: only `describe-*`, `list-*`, `get-*`. No `start/stop/modify/delete/send-command`.
- PostgreSQL: connect with a read-only session so the server itself refuses writes:
  `export PGOPTIONS='-c default_transaction_read_only=on -c statement_timeout=15000'` and use `psql "$DATABASE_URL" -X -v ON_ERROR_STOP=1 …` (the URL comes from the instance's env file; never echo it).
- Never run `migrate.js`, `bootstrap.js`, `db:sync-accident-catalog --apply`, `deploy.sh release|rollback` while doing these checks.

## 1. Service state and application version (on the EC2 instance)
```bash
readlink -f /opt/easy-fleet/current                 # active release directory (its name is the release timestamp)
ls -1 /opt/easy-fleet/releases | tail -5            # kept releases
systemctl is-active easy-fleet                      # active / failed
systemctl status easy-fleet --no-pager | head -15
curl -fsS --max-time 4 http://127.0.0.1:4000/api/healthz; echo     # process is alive
curl -fsS --max-time 4 http://127.0.0.1:4000/api/readyz;  echo     # database + schema + storage + not draining
journalctl -u easy-fleet --since "-30min" --no-pager | tail -40    # recent log (look for errors only)
ls /opt/easy-fleet/current/server/drizzle | tail -3                # newest migration file shipped with this release
```
The same view, as the repository's own read-only command: `sudo bash /opt/easy-fleet/current/deploy/aws/deploy.sh status` (prints current release, kept releases, service state, readiness).

## 2. AWS side (CLI, read-only)
```bash
aws sts get-caller-identity                                              # which account/role you are using
aws ec2 describe-instances --instance-ids <instance-id> --query 'Reservations[].Instances[].{state:State.Name,type:InstanceType,az:Placement.AvailabilityZone}'
aws ssm describe-instance-information --filters Key=InstanceIds,Values=<instance-id> --query 'InstanceInformationList[].{ping:PingStatus,agent:AgentVersion}'
aws rds describe-db-instances --db-instance-identifier <db-id> --query 'DBInstances[].{status:DBInstanceStatus,engine:EngineVersion,class:DBInstanceClass,multiAz:MultiAZ,public:PubliclyAccessible,backupDays:BackupRetentionPeriod,deletionProtection:DeletionProtection}'
aws rds describe-db-snapshots --db-instance-identifier <db-id> --snapshot-type manual --query 'reverse(sort_by(DBSnapshots,&SnapshotCreateTime))[:5].{id:DBSnapshotIdentifier,at:SnapshotCreateTime,status:Status}'
aws rds describe-db-instance-automated-backups --db-instance-identifier <db-id> --query 'DBInstanceAutomatedBackups[].{status:Status,from:RestoreWindow.EarliestTime,to:RestoreWindow.LatestTime}'
aws s3api list-objects-v2 --bucket <release-artifact-bucket> --prefix releases/ --query 'reverse(sort_by(Contents,&LastModified))[:5].{key:Key,at:LastModified}'
aws secretsmanager describe-secret --secret-id easy-fleet/prod --query '{name:Name,rotated:LastChangedDate}'    # metadata only; never get-secret-value
```
Take (or confirm) the manual RDS snapshot **before** any release; creating one is a separate, approved step and is not part of this list.

## 3. PostgreSQL: migrations (read-only SQL)
```sql
select count(*) as applied from drizzle.__drizzle_migrations;                       -- the code of this release has 11 (0000–0010)
select id, created_at from drizzle.__drizzle_migrations order by id;                -- compare with server/drizzle/meta/_journal.json
select to_regclass('public.accident_stage_officers') is not null as has_0010_tables,
       to_regclass('public.driver_portal_links') is not null     as has_0009_tables;
select column_name from information_schema.columns where table_name='accidents' and column_name='workflow_stage';   -- 0 rows = 0010 not applied
select pg_size_pretty(pg_total_relation_size('accidents')), (select count(*) from accidents) as accidents,
       (select count(*) from accident_attachments) as accident_attachments;
```
Baseline before a release, to compare afterwards (must be identical after `0010`):
```sql
select count(*), md5(string_agg(id::text || status::text || coalesce(description,''), ',' order by id)) from accidents;
```
Blocking sessions that would make the migration wait: `select pid, state, xact_start, left(query,80) from pg_stat_activity where datname = current_database() and xact_start < now() - interval '1 minute';`

Optional, with the **new** release's compiled tool (read-only transaction, lists what is unapplied and prints no credentials):
`cd /opt/easy-fleet/current/server && set -a && . /etc/easy-fleet/easy-fleet.env && set +a && node dist/scripts/verify-aws-readonly.js`
(It is written for a freshly provisioned environment: on a populated database its "holds no operational data" line is expected to FAIL; read the migration line only.)

## 4. PostgreSQL: roles and permissions (read-only SQL)
```sql
select r.key, count(*) as grants from roles r join role_permissions rp on rp.role_id = r.id
 where r.organization_id is null group by 1 order by 1;                              -- ACCIDENT_MANAGER / INSURANCE_OFFICER absent = catalog not synced
select key from permissions where key like 'accidents.%' order by 1;                  -- the 7 new keys present or not
select r.key as role, p.key as permission, rp.scope
  from role_permissions rp join roles r on r.id = rp.role_id join permissions p on p.id = rp.permission_id
 where p.key in ('accidents.documents.sensitive','accidents.assign','accidents.settings.manage','accidents.review.technical')
 order by 1, 2;                                                                       -- who holds the sensitive/assign/settings permissions today
select u.email, r.key from users u join user_roles ur on ur.user_id = u.id join roles r on r.id = ur.role_id where r.key = 'SUPER_ADMIN';   -- administrators (emails are personal data: do not paste out)
```
The full difference between the database and the code's catalog, still read-only, is `db:preview-catalog` (`node dist/scripts/preview-catalog-sync.js` from the **new** release directory; it runs in a READ ONLY transaction). It cannot be run from a release that predates it, so before the release rely on the SQL above.

## 5. Flags and configuration (read, do not edit)
```bash
sudo grep -E '^(ACCIDENT_WORKFLOW_ENABLED|ACCIDENT_LEGACY_SENSITIVE_ENFORCEMENT|NODE_ENV|STORAGE_PROVIDER)=' /etc/easy-fleet/easy-fleet.env
```
Expected today: both accident flags absent or `false`. (Never print the whole env file.)
