# Fleet staging — review draft, NOT provisioned

Region: eu-north-1. Repository: azoxj/Easy-Fleet.
No infrastructure has been created. No production resources, data, secrets,
workflows, DNS, or IAM policies may be changed by this draft.

## Approval and access gates

1. Connect a dedicated AWS staging identity securely (no keys in chat).
2. Read-only: verify account ID, quotas, available instance types and current
   regional prices. Prefer a dedicated AWS account; otherwise a dedicated VPC
   with no peering, shared security groups, or production role access.
3. Present a priced resource plan, monthly estimate and spending limit for
   explicit owner approval BEFORE any resource creation or paid CI execution.
4. Create a dedicated provisioning role restricted to staging resources; review
   the actual IaC plan and IAM diff before apply. Do not use AdministratorAccess.
5. Review GitHub environment settings and OIDC trust before enabling deployment.

## Proposed billable resources (not approved)

- Dedicated VPC, public app subnet and two private DB subnets across AZs.
- One x86 EC2 t3.small candidate (validate availability/pricing), encrypted gp3
  root disk, IMDSv2 required, no SSH, SSM management. HTTPS only ingress after
  approval of a staging hostname; app binds loopback behind a TLS reverse proxy.
- One private RDS PostgreSQL 16 instance (db.t4g.micro candidate), encrypted,
  single AZ, 20 GiB gp3, seven-day backup retention; port 5432 allowed only from
  the staging app security group. No public access. Fresh synthetic data only.
- Separate private S3 uploads and release-artifact buckets, block public access,
  encryption, versioning, TLS-only bucket policies and bounded retention.
- Secrets Manager staging-only secrets; no copied production credentials.
- CloudWatch application/SSM logs with 14-day retention; CPU, status checks,
  disk/memory (agent), RDS free storage/connections, application errors and
  readiness alarms. Confirm alarm recipient before subscribing anyone.
- Public IPv4, storage, backup, logs, requests, egress and GitHub Actions usage
  must all appear in the estimate. No NAT gateway or load balancer proposed.

## Runtime isolation

Use /opt/fleet-staging, /etc/fleet-staging, /run/fleet-staging/secrets,
fleet-staging.service and OS user fleetstaging. NODE_ENV=production,
COOKIE_SECURE=true, TRUST_PROXY=1 and a staging-only APP_ORIGINS/APP_URL.
STORAGE_PROVIDER=s3; S3_BUCKET must be the new uploads bucket.
DATABASE_URL_FILE must resolve only to the newly created RDS database
fleet_staging. Runtime DB role has no CREATEDB or CREATEROLE. Migration role is
separate. Disable outbound email initially; never import project/customer data.
Do not reuse deploy/aws/deploy.sh defaults or fetch-secrets.sh unmodified:
they refer to production-style paths. A staging service and secret loader must
be independently configured and tested before activation.

## Delivery design (pending implementation and approval)

A new staging-only workflow, leaving existing CI and production files unchanged:
- Trigger only on protected staging branch changes after initial cost approval.
- Run npm ci, typecheck, tests, build and production dependency audit.
- PostgreSQL 16 ephemeral CI service; TEST_DATABASE_URL ends in _test and never
  references RDS. Migration tests require CREATEDB only in this ephemeral DB.
- Package once; retain checksum, exact commit and CI result with the artifact.
- GitHub OIDC trust: exact repo and environment staging; no static AWS keys.
- Deploy role: staging artifact prefix + exact instance + custom SSM document.
  Avoid unrestricted AWS-RunShellScript; document must constrain allowed paths
  and release commands. No access to production secrets, databases or buckets.
- Take/verify a staging DB backup before migrations. Wait for SSM completion;
  readiness must report database/schema/storage healthy. Roll back code on
  failure; destructive schema rollback requires an explicit reviewed restore.

## Acceptance before declaring ready

Verify TLS; unauthenticated/authenticated access; uploads/downloads in the new
bucket; migrations and synthetic seed; handover/driver scope permissions;
negative cross-project authorization; CI failure prevents deployment; exact
commit deployed; code rollback; backup restore into a disposable staging DB;
alarm delivery; explicit denial of production resource access. Record actual
AWS IDs, test results, costs and staging URL. Do not declare success from this
proposal alone.
