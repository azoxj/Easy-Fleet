# Easy Fleet — Security Model & Notes

## Authorization: Role + Permission + Scope + Assignment

Every protected request goes through the same pipeline, entirely server-side:

1. **Session** — opaque 256-bit token in an `HttpOnly; SameSite=Strict` cookie (`__Host-` prefixed + `Secure` in production).
   Only its SHA-256 hash is stored. Idle timeout (default 60 min) + absolute timeout (default 12 h). Revoked on logout,
   password change (other devices), admin reset, and user disable.
2. **Access context** — loaded fresh from the DB on every request: role keys, effective permissions, member projects.
   Role changes therefore take effect immediately.
3. **Permission check** — `requirePermission("vehicles.read")` ⇒ 403 when missing.
4. **Scope predicate** — every query that reads or mutates a scoped table includes `vehicleScope()` / `projectScope()` /
   `assignmentScope()`:
   - `ALL` — organization-wide.
   - `PROJECT` — rows in projects where the user is a member or the manager, **plus** rows assigned to them.
   - `ASSIGNED` — only rows explicitly assigned to the user (active assignment) or, for vehicles, where the user is the linked driver.
5. **Assignments never grant permissions.** They only widen the *record set* of a permission the role already has, and a
   vehicle assignment counts only while the vehicle is still in the assignment's project (moving the vehicle invalidates it).
6. **Write checks are separate from read checks** — e.g. updating a vehicle requires it to be in the `vehicles.update`
   scope, and moving it to another project requires rights on the *target* project too. ASSIGNED-scope editors can only change odometer/notes.
7. Out-of-scope records return **404**, not 403, so ids cannot be probed (no existence oracle / IDOR).

Client-provided `organizationId` / `userId` / `createdBy` are never read: schemas are `.strict()` (unknown fields ⇒ 400),
and ownership fields are always set from the session. Where a client value is a lookup key (e.g. `projectId` on an
assignment), the server derives the real linkage and rejects conflicts.

### Anti-escalation
- A user can only grant roles whose every permission they already hold with an equal-or-wider scope.
- Admins cannot change their own roles or disable themselves; the last active SUPER_ADMIN cannot be disabled or demoted.
- Budget, code and manager of a project require `projects.update` with `ALL` scope.

## Other controls implemented
| Area | Control |
|---|---|
| Passwords | scrypt (N=2¹⁷, r=8, p=1, 16-byte salt), params stored per hash with transparent upgrade on login; policy: ≥10 chars, 3 of 4 classes; temp passwords are random and force a change at first login |
| Login | generic error for unknown email / bad password / disabled; dummy hash on unknown email (timing); rate limit 30/15 min per IP + 5 failures/15 min per account (429 + Retry-After) |
| CSRF | SameSite=Strict + per-session CSRF token required on POST/PUT/PATCH/DELETE + Origin / Sec-Fetch-Site check (also protects login) |
| Headers | CSP (`default-src 'self'`, `frame-ancestors 'none'`), X-Frame-Options DENY, nosniff, Referrer-Policy, COOP/CORP, HSTS when secure, `Cache-Control: no-store` on API, no `X-Powered-By` |
| Input | Zod validation on every body/query/param; UUID validation; 100 kB JSON limit; money as validated decimal strings; DB CHECK and UNIQUE constraints as a second line |
| Errors | no stack traces or SQL leaked; unique violations → 409 |
| Audit | login/logout/failed login, password change/reset, user create/update/disable/roles, project create/update/members, vehicle create/update/archive, assignment create/status. IP + UA recorded. Secrets (`password|token|secret|hash|iban`) redacted. **DB trigger blocks UPDATE/DELETE/TRUNCATE.** No delete endpoint. |
| Notifications | always queried by `user_id = session user`; recipients filtered to active users of the same org and, for project notifications, to users who can see that project; links must be in-app paths |
| Secrets | none in Git (`.env` ignored, `.env.example` has placeholders); first admin created from one-off env vars; demo seed refuses production unless `ALLOW_DEMO_SEED=true` + `DEMO_PASSWORD` are given (then the password is never printed); locally it prints a random password once |
| Config | production refuses to start without `COOKIE_SECURE=true` and strong scrypt cost |

## Deployment recommendations
- Run behind HTTPS; set `COOKIE_SECURE=true`, `APP_ORIGINS`, and `TRUST_PROXY` to the number of proxies (otherwise rate limiting sees the proxy IP).
- Run the app with a DB role that is **not** the table owner and has only `SELECT, INSERT` on `audit_logs`
  (the trigger protects against the app; a non-owner role also prevents dropping the trigger).
- Security-sensitive limiters (login per IP / per account, password change, uploads, public handover link, GPS pings, tile proxy) are stored in PostgreSQL (`rate_limits`) and shared by all instances. The general API limiter (600/min per IP) stays in memory per instance.
- Per-account failure limiting can be abused to temporarily lock a known account (15 min); this is the accepted trade-off vs. brute force.

## Sprint 2 additions
| Area | Control |
|---|---|
| Employee PII | National ID/Iqama never returned by list, search or driver endpoints; not searchable; masked (`••••1234`) in detail unless the caller may edit that employee; redacted from audit metadata (`national*` keys and change diffs) |
| Scope | employees scoped by stored `employees.project_id` (PROJECT) or own record (ASSIGNED); drivers through their employee; documents / registration / insurance through the vehicle scope of the matching permission. Moving an employee or vehicle requires rights on the target project; out-of-scope ids ⇒ 404 |
| Derived state | document / insurance / license statuses and driver EXPIRED are computed server-side; any client-sent `status` is rejected (strict schemas) |
| Files | upload = raw body on a record-specific endpoint (no multipart parser); type identified by **magic bytes** (PDF/PNG/JPEG/WEBP) and must match Content-Type; size limit (`MAX_UPLOAD_MB`, default 10); server-generated storage key under a private `STORAGE_DIR` (never under the web root, never exposed); SHA-256 stored. Download only through endpoints that re-authorize the owning record, sent as `attachment` with `nosniff` and `CSP: sandbox`; every download is audited |
| Integrity | DB partial unique indexes: one current registration / insurance per vehicle, one current vehicle per driver and vice versa; CHECKs on dates and premium |
| Least privilege | archive/delete of people and documents is SUPER_ADMIN only; employee PII limited to project managers (and a driver's own record); FINANCE is read-only on documents/insurance |

## Sprint 2 / Part 2 — maintenance
| Area | Control |
|---|---|
| State machine | one server-side transition table (`modules/maintenance/workflow.ts`); each transition is its own action endpoint; no endpoint accepts `status`/`approved`/`projectId`/`vehicleId`/`total` (strict schemas ⇒ 400); invalid transitions ⇒ 409 `INVALID_TRANSITION`; status updates are guarded by the current status (optimistic concurrency) |
| Separation of duties | FINANCE approves/rejects quotes; the PM approves the work (only after a quote is approved) and accepts/rejects the handover; closing needs `maintenance.close` and is only reachable from ACCEPTED |
| Scope | `maintenanceScope` (ALL / PROJECT / ASSIGNED). ASSIGNED = assigned technician or an active MAINTENANCE_REQUEST assignment matching the request's project. Acting with PROJECT scope requires real membership; an assignment never lets a project-scoped user approve another project's work. Out of scope ⇒ 404, in scope without the action permission ⇒ 403 |
| Assignment ≠ permission | assignment rows only widen record sets for roles that already hold the permission (tested with DRIVER + assignment ⇒ 403); technicians must hold `maintenance.update` and belong to the project to be assignable |
| Money | parts/labor totals computed in SQL numeric and enforced by CHECK constraints; the UI shows estimates only |
| Files | attachments & quote files reuse the private storage (magic-byte validation, size limit); downloads re-authorize through the parent request and are audited |
| Notifications | recipients resolved by permission + project membership (`permissionHolders`), then filtered again by the project visibility guard; tested against cross-project leakage |
| Audit | every action (create/update/assign/transitions/quotes/parts/labor/files) writes an audit entry with user, old/new status, reason, project and vehicle, plus an append-only maintenance_events row |

## Full system — finance, operations, handover, GPS
| Area | Control |
|---|---|
| Invoices | server state machine (`invoice-workflow.ts`); separation of duties — the creator submits/cancels, **never** reviews/approves/rejects own invoice; reject needs a reason; submit needs the invoice file; approve records APPROVED then TRANSFER_PENDING; transfer requires a receipt uploaded **by the same finance user**, unused, amount ≤ total, date not in the future; totals computed in SQL + CHECK |
| Expenses | nobody approves their own expense; vehicle must belong to the project; project access checked on the target project |
| Accidents / violations | state machines with optimistic concurrency (409 on races / invalid transitions); vehicle status ACCIDENT set/restored server-side; closing requires a resolution; violations PAID require a payment date (DB CHECK); duplicate violation numbers ⇒ 409 |
| Handover link | 256-bit random token, only its SHA-256 stored; raw token returned once; same link valid for handover then return, dead after RETURN_COMPLETED / CLOSED / CANCELLED / expiry / rotation; invalid tokens ⇒ identical 404, audited (`HANDOVER_TOKEN_INVALID`) and counted by a per-IP limiter (20 / 15 min ⇒ 429); public responses expose only plate/model, driver name and progress (no ids, no org data); uploads are images only (magic bytes) and 7 photos + signature + confirmation are enforced server-side; GPS stored only when the device sent it; `Referrer-Policy: same-origin` prevents leaking the link |
| QR codes | encode a random per-vehicle token (never the id); resolving requires a session and vehicle scope (404 otherwise) |
| GPS | only the driver's own trip on a vehicle assigned to them; points validated (ranges, timestamps not in the future / before the trip), deduplicated, implausible jumps (>250 km/h) and inaccurate points (>200 m) excluded from distance; per-user rate limit; fleet map (`gps.read`) is scope-filtered |
| Map provider | tile URL chosen server-side. Default public OSM (no key). With `MAP_TILE_URL` (may contain a key) tiles go through `/api/map/tiles` so the key never reaches the browser; CSP allows the OSM host only when no proxy is configured |
| Reports | each report reuses its module's scope predicate; CSV export needs `reports.export`, is audited, and neutralises spreadsheet formula injection (`= + - @` prefixed with `'`) |
| Notifications | categories + per-user preferences (SYSTEM locked); dedupe keys for scheduled expiry reminders; project visibility guard on every project notification; self-directed notifications (a driver's own violation/handover) are sent without project scope to that user only |
| Vehicle timeline | events of modules the caller cannot read (finance, fuel, handover...) are excluded |
| Audit | old/new values on every state change (derived from diffs / status transitions), redacted; CSRF rejections and rate-limit hits audited as SECURITY_* |
| Users | "delete" = permanent deactivation (row kept for audit/FKs), sessions revoked, memberships removed, open assignments cancelled; last admin / self / active project manager protected |
| Service worker | never caches `/api/*`; shell network-first with an offline page; `sw.js` served `no-cache` |

## Known items / not yet in scope
- Local-disk storage is single-instance (file bytes; metadata and authorization are in PostgreSQL); switch `services/storage.ts` to an object store with signed URLs before scaling out.
- National ID is masked and access-controlled but not encrypted at rest; column-level encryption with a managed key is a candidate for a hardening sprint.
- `npm audit` reports a moderate advisory in `esbuild` bundled by **drizzle-kit** (dev-only CLI used to generate migrations; its dev server is never started). Not shipped to production.
- Web fonts load from Google Fonts; self-host them if the deployment must not call external hosts.
- MFA, password breach checks and session listing UI are candidates for a later hardening sprint.
- The web tracker only records while the page is open (browser limitation); background tracking needs the native app (same API, `source=NATIVE`).
- Handover links are bearer secrets: anyone holding the link can complete the step until it is used, rotated, cancelled or expires.
