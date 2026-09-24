# Easy Fleet — Database Schema

PostgreSQL 16 · Drizzle ORM · UUID primary keys (non-enumerable ids) · `timestamptz` everywhere · money as `numeric(14,2)` (never float).

**Tenant-readiness rule:** every tenant-owned table has `organization_id NOT NULL → organizations.id`.
The API always takes it from the session, never from the request body. Moving to multi-tenant later is
a matter of adding more organizations, not reshaping data.

Legend: ✅ implemented in Sprint 1 migrations · 🔜 proposed, will be added by the sprint that owns it.

## Implemented in Sprint 1 (migration `0000_init`, `0001_audit_log_append_only`)

### ✅ organizations
| column | type | notes |
|---|---|---|
| id | uuid PK | |
| name | text | |
| slug | text UNIQUE | `default` in phase 1 |
| status | enum ACTIVE/SUSPENDED | suspended org ⇒ all its sessions rejected |
| created_at, updated_at | timestamptz | |

### ✅ users
id · organization_id FK · email (unique on `lower(email)`, global for a future shared login) · name · phone ·
password_hash (scrypt) · status ACTIVE/DISABLED · must_change_password · last_login_at · password_changed_at ·
created_by · timestamps. Index: organization_id.

### ✅ roles / permissions / role_permissions / user_roles
- **roles**: id · organization_id NULL (= built-in system role; non-null reserved for per-tenant custom roles) · key · name_ar · description · is_system. `UNIQUE NULLS NOT DISTINCT (organization_id, key)`.
- **permissions**: id · key UNIQUE (e.g. `vehicles.update`) · module · description_ar.
- **role_permissions**: (role_id, permission_id) PK · **scope** enum `ALL | PROJECT | ASSIGNED`.
- **user_roles**: (user_id, role_id) PK · assigned_by · assigned_at. Index: role_id.

The catalog lives in code (`server/src/auth/permissions.ts`) and `npm run db:bootstrap` syncs it idempotently.

### ✅ sessions
id · user_id FK · **token_hash** (SHA-256, UNIQUE — the raw token never touches the DB) · csrf_token · ip · user_agent ·
created_at · last_seen_at (idle timeout) · expires_at (absolute timeout) · revoked_at.

### ✅ projects / project_users
- **projects**: id · organization_id · name · code (`UNIQUE(organization_id, code)`) · description · manager_id FK users · status PLANNED/ACTIVE/ON_HOLD/COMPLETED/ARCHIVED · start_date · end_date · budget numeric(14,2) · created_by · timestamps.
  CHECKs: `budget >= 0`, `end_date >= start_date`.
- **project_users**: (project_id, user_id) PK · added_by · added_at — this *is* the user's PROJECT scope.

### ✅ employees / drivers  (extended in Sprint 2 — migration `0002`)
- **employees**: id · organization_id · employee_number (`UNIQUE(org, number)`) · full_name · national_id (`UNIQUE(org, national_id)`, sensitive — never listed/searched) · phone · email · job_title · project_id · status ACTIVE/INACTIVE/SUSPENDED/ARCHIVED · hire_date · notes · user_id UNIQUE NULL (an employee is *not* necessarily a user) · created_by · timestamps. Index (org, status), project_id.
- **drivers**: id · organization_id · employee_id UNIQUE FK (driver → employee, never the reverse) · license_number (partial unique per org) · license_type PRIVATE/PUBLIC/HEAVY/MOTORCYCLE/OTHER · license_issue_date · license_expiry_date · status ACTIVE/SUSPENDED/INACTIVE (stored) · notes · archived_at · created_by · timestamps. **EXPIRED is derived** from the license date at read time. CHECK expiry ≥ issue. Index (org, license_expiry_date).
- Migration `0002` renames `name→full_name`, `start_date→hire_date`, `license_expiry→license_expiry_date` with `RENAME COLUMN`, and maps old employee statuses ON_LEAVE→INACTIVE, TERMINATED→ARCHIVED (data-preserving; verified on a copy with legacy rows).

### ✅ files  (Sprint 2)
id · organization_id · storage_key UNIQUE (server-generated `<org>/<uuid>`, never exposed) · original_name · mime_type · size_bytes · sha256 · uploaded_by · created_at.

### ✅ vehicle_documents  (Sprint 2)
id · organization_id · vehicle_id FK · document_type REGISTRATION/INSURANCE/LICENSE/WARRANTY/OWNERSHIP/OTHER · document_number · issue_date · expiry_date · issuer · file_id FK files · notes · superseded_at · deleted_at/deleted_by (soft delete) · created_by · timestamps.
**Status is not stored** — computed from expiry_date. Partial unique index `vehicle_documents_one_current_registration_uq` ⇒ at most one current (not superseded, not deleted) REGISTRATION per vehicle; renewal supersedes the previous row. Index (vehicle_id, type), (org, expiry_date).

### ✅ insurance_policies  (Sprint 2)
id · organization_id · vehicle_id FK · provider · policy_number (`UNIQUE(org, provider, policy_number)`) · issue_date · expiry_date NOT NULL · premium_amount numeric(14,2) ≥ 0 · coverage_type THIRD_PARTY/COMPREHENSIVE/OTHER · file_id · notes · superseded_at · created_by · timestamps. One current policy per vehicle (partial unique). Status computed.

### ✅ vehicle_driver_history  (Sprint 2)
id · organization_id · vehicle_id · driver_id · assigned_by · assigned_at · unassigned_by · unassigned_at. Partial unique indexes: one open row per vehicle and one per driver. `vehicles.assigned_driver_id` is the current pointer, kept in sync in the same transaction.

### ✅ audit_logs.vehicle_id  (Sprint 2)
Nullable column + index (vehicle_id, created_at) so every vehicle-related event (documents, insurance, driver changes, assignments) feeds the vehicle timeline.

### ✅ vehicles
id · organization_id · plate_number · vehicle_number · make · model · year · color · vin · current_odometer ·
status (AVAILABLE, ASSIGNED, IN_MAINTENANCE, OUT_OF_SERVICE, ACCIDENT, SOLD, ARCHIVED) · project_id FK ·
assigned_driver_id FK drivers · purchase_date · purchase_price · warranty_start · warranty_end · notes · archived_at ·
created_by · timestamps.
Uniques per org: plate_number, vehicle_number, vin. Indexes: (org, status), project_id, assigned_driver_id.
CHECKs: odometer ≥ 0, price ≥ 0, warranty_end ≥ warranty_start.

### ✅ assignments
id · organization_id · type (PROJECT, VEHICLE, MAINTENANCE_REQUEST, ACCIDENT, INVOICE, TASK, DOCUMENT) ·
assigned_to FK · assigned_by FK · project_id FK · vehicle_id FK · reference_id · title · description ·
priority LOW/MEDIUM/HIGH/URGENT · status PENDING/IN_PROGRESS/COMPLETED/CANCELLED · due_date · created_at · updated_at · completed_at.
Indexes: (assigned_to, status), (type, reference_id), project_id, vehicle_id, organization_id.

### ✅ notifications
id · organization_id · user_id FK · type · title · body · link (validated in-app path) · entity_type · entity_id ·
project_id · read_at · created_at. Index: (user_id, created_at).

### ✅ audit_logs  (append-only)
id bigserial · organization_id · user_id · action · entity · entity_id · project_id · metadata jsonb (secrets redacted) ·
ip · user_agent · created_at. Indexes: (org, created_at), (entity, entity_id), user_id.
**Trigger** `audit_logs_block_mutation` rejects UPDATE, DELETE and TRUNCATE.

### Expiry rule (single definition — `server/src/services/expiry.ts`)
`EXPIRED`: expiry < today · `EXPIRING_SOON`: today ≤ expiry ≤ today + 30 · `ACTIVE`: expiry > today + 30 (or none).
"today" = server clock in `APP_TIMEZONE` (default Asia/Riyadh); the clock is injectable for tests.

## Proposed for upcoming sprints 🔜

| table | key columns | notes |
|---|---|---|
| vendors | name, company, phone, email, tax_number, bank_name, iban (encrypted), status | |
| maintenance_requests | vehicle_id, project_id, requested_by, assigned_to, vendor_id, issue, description, priority, status, odometer, rejection_reason, completed_at | workflow REQUESTED → … → READY_FOR_HANDOVER → ACCEPTED/REJECTED → CLOSED |
| maintenance_quotes | request_id, vendor_id, amount, file_id, status | |
| maintenance_parts | request_id, name, qty, unit_price | |
| maintenance_events | request_id, from_status, to_status, actor_id, reason, created_at | full status history |
| invoices | project_id, vehicle_id NULL, vendor_id, invoice_number, amount, issue_date, due_date, category, description, file_id, status, created_by, reviewed_by, paid_by, rejection_reason | DRAFT → SUBMITTED → UNDER_REVIEW → APPROVED/REJECTED → PENDING_PAYMENT → PAID → CLOSED |
| invoice_payments | invoice_id, transfer_date, transfer_amount, reference_number, bank, receipt_file_id, paid_by | |
| fuel_transactions | vehicle_id, driver_id, project_id, date, station, liters, price_per_liter, total, odometer | cost/km, km/l, monthly cost via SQL |
| accidents | vehicle_id, driver_id, project_id, occurred_at, location, description, responsibility, police_report, insurance_claim, repair_cost, status | photos/docs via files |
| violations | vehicle_id, driver_id, project_id, violation_number, date, type, amount, status, payment_date | |
| handover_sessions | vehicle_id, driver_id, project_id, created_by, **token_hash**, status (HANDOVER_PENDING → HANDOVER_COMPLETED/RETURN_PENDING → RETURN_COMPLETED → CLOSED), handover_odometer, return_odometer, signatures | secure random token, only its hash stored |
| handover_photos | session_id, phase (HANDOVER/RETURN), category (FRONT, REAR, LEFT, RIGHT, INTERIOR, ODOMETER, TIRES, OTHER), file_id, taken_at, lat/lng (only if the device provides it), notes | required categories enforced server-side |
| subscriptions / plans | (future SaaS) | not built now |
