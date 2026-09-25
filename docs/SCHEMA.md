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

### ✅ Maintenance (Sprint 2 / Part 2 — migration `0003_maintenance_workflow`)
- **vendors**: id · organization_id · name (`UNIQUE(org, name)`) · phone · email · status ACTIVE/INACTIVE · notes · created_by · timestamps. Org-wide.
- **maintenance_requests**: id · number (bigserial, shown as MR-n) · organization_id · vehicle_id · project_id (copied from the vehicle, never from the client) · requested_by · assigned_to · issue · description · priority LOW/MEDIUM/HIGH/CRITICAL · status (10-state enum) · odometer ≥ 0 · diagnosis · work_performed · notes · rejection_reason · handover_rejections · vehicle_status_before · assigned_at / inspection_started_at / approved_at / started_at / ready_at / completed_at / closed_at · timestamps. Indexes: (org, status), project_id, (vehicle_id, created_at), assigned_to, (org, created_at).
- **maintenance_parts**: part_name · part_number · quantity > 0 · unit_price ≥ 0 · total · vendor_id · notes. CHECK `total = round(quantity × unit_price, 2)`.
- **maintenance_labor**: description · hours > 0 · hourly_rate ≥ 0 · total. CHECK `total = round(hours × hourly_rate, 2)`.
- **maintenance_quotes**: vendor_id · quote_number · amount ≥ 0 · valid_until · attachment_file_id · notes · status DRAFT/SUBMITTED/UNDER_REVIEW/APPROVED/REJECTED · created_by · submitted_at · reviewed_by/at · review_reason. Partial unique: one APPROVED quote per request.
- **maintenance_attachments**: request · file_id → files · category DAMAGE_PHOTO/INSPECTION_REPORT/QUOTE/INVOICE/REPAIR_PHOTO/OTHER · uploaded_by.
- **maintenance_events**: append-only history (type, from/to status, actor, reason, metadata); UPDATE/DELETE/TRUNCATE blocked by trigger.

### Expiry rule (single definition — `server/src/services/expiry.ts`)
`EXPIRED`: expiry < today · `EXPIRING_SOON`: today ≤ expiry ≤ today + 30 · `ACTIVE`: expiry > today + 30 (or none).
"today" = server clock in `APP_TIMEZONE` (default Asia/Riyadh); the clock is injectable for tests.

## ✅ Full system (migration `0004_fleet_operations_finance_handover_gps` — additive only)

Old migrations 0000–0003 are unchanged. 0004 only adds enums, tables, nullable columns and indexes, plus a
data-preserving backfill of `notifications.category`.

### Column additions
- **organizations**: legal_name · tax_number · cr_number · address · phone · email · settings jsonb (currency, vatRate, fiscalYearStartMonth, handoverLinkDays — validated keys only).
- **projects**: contract_value (revenue side of project financials).
- **vehicles**: plate_arabic · plate_english · serial_number · qr_token (UNIQUE, random — the QR never encodes the vehicle id).
- **vendors**: tax_number · address. **vehicle_documents**: fee (registration fees feed the cost ledger).
- **notifications**: category (MAINTENANCE/FINANCE/ASSIGNMENT/DOCUMENT_EXPIRY/ACCIDENT/VIOLATION/HANDOVER/SYSTEM) · dedupe_key (partial UNIQUE (user_id, dedupe_key)).
- **audit_logs**: old_value jsonb · new_value jsonb (redacted like metadata).
- **assignment_type** enum: + VIOLATION, REGISTRATION, INSURANCE.

### New tables
| table | key columns / constraints |
|---|---|
| notification_preferences | PK (user_id, category) · enabled. SYSTEM cannot be disabled |
| rate_limits | key PK · window_start · count — shared fixed-window limiter (multi-instance) |
| invoices | number bigserial (INV-n) · project_id NOT NULL · maintenance_request_id · vehicle_id · vendor_id · invoice_number · amount · tax · total (**CHECK total = amount + tax**) · invoice_date · due_date · status (DRAFT, SUBMITTED, UNDER_REVIEW, APPROVED, REJECTED, TRANSFER_PENDING, TRANSFERRED, PAID, CANCELLED) · file_id · created_by · approved_by/at · rejected_by/at · rejection_reason · paid_at |
| invoice_transfers | invoice_id UNIQUE · transfer_date · amount · bank · reference · **receipt_file_id NOT NULL** · notes · created_by |
| expenses | project_id · vehicle_id · category · amount > 0 · expense_date · vendor_id · invoice_id · description · status SUBMITTED/APPROVED/REJECTED · receipt_file_id · reviewed_by/at · review_reason |
| fuel_transactions | vehicle_id · driver_id · project_id · fueled_at · liters > 0 · price_per_liter ≥ 0 · total (**CHECK total = round(liters × price, 2)**) · station · odometer ≥ 0 · receipt_file_id |
| accidents | number (ACC-n) · vehicle/project/driver · occurred_at · location · lat/lng (CHECK ranges) · description · severity · responsibility · police_report_number · insurance_claim_number · repair_cost ≥ 0 · status OPEN/UNDER_REVIEW/INSURANCE/REPAIR/CLOSED · resolution · vehicle_status_before · maintenance_request_id · closed_at |
| accident_attachments | accident_id · file_id · category (PHOTO/POLICE_REPORT/INSURANCE/REPAIR_INVOICE/OTHER) |
| violations | vehicle/project/driver · violation_number (partial UNIQUE per org) · violation_date · type · amount ≥ 0 · authority · status OPEN/PAID/DISPUTED/CANCELLED (**CHECK PAID ⇒ payment_date**) · dispute_reason · file_id |
| employee_documents | employee_id · document_type (NATIONAL_ID, IQAMA, PASSPORT, CONTRACT, DRIVING_LICENSE, OTHER) · number · issue/expiry (CHECK order) · file_id · soft delete |
| handover_sessions | vehicle/driver/project · created_by · **token_hash UNIQUE** (SHA-256; raw token shown once) · status PENDING_HANDOVER → RETURN_PENDING → RETURN_COMPLETED → CLOSED / CANCELLED · expires_at · access stats · handover_at/odometer/notes · return_at/odometer/notes (CHECK return ≥ handover) · closed_by · review_notes · cancel_reason. **Partial UNIQUE: one active session per vehicle and per driver** |
| handover_photos | session_id · phase HANDOVER/RETURN · category FRONT, REAR, LEFT, RIGHT, INTERIOR, ODOMETER, TIRES, OTHER, SIGNATURE · file_id · damage · notes · lat/lng/accuracy only when the device supplied them · captured_at. Partial UNIQUE slot per (session, phase, category) except OTHER |
| trips | driver/vehicle/project/user · source WEB/NATIVE · status ACTIVE/ENDED · started/ended · distance_meters · point_count · last_point_at. Partial UNIQUE one ACTIVE trip per driver and per vehicle |
| location_pings | bigserial · trip_id · driver/vehicle/project · lat/lng (CHECK) · accuracy · speed · heading · recorded_at · received_at |
| vehicle_locations | vehicle_id PK · latest position (upsert only when newer) |

### Unified cost ledger (read model, `modules/finance/costs.ts`)
One SQL CTE used by the finance dashboard, project financials, dashboard charts and reports, so every screen shows the
same totals: FUEL (fuel totals) · MAINTENANCE (parts + labor of CLOSED requests) · INSURANCE (premiums) · REGISTRATION
(fees) · ACCIDENT (repair_cost) · VIOLATION (PAID amounts) · approved manual expenses by category.

### Still future (not built)
| table | notes |
|---|---|
| subscriptions / plans | SaaS billing — the schema already carries organization_id everywhere |
| vendor bank data (IBAN) | would need column-level encryption first |
