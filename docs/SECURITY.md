# Easy Fleet — Security Model & Notes (Sprint 1)

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
| Secrets | none in Git (`.env` ignored, `.env.example` has placeholders); first admin created from one-off env vars; demo seed refuses production and prints random passwords |
| Config | production refuses to start without `COOKIE_SECURE=true` and strong scrypt cost |

## Deployment recommendations
- Run behind HTTPS; set `COOKIE_SECURE=true`, `APP_ORIGINS`, and `TRUST_PROXY` to the number of proxies (otherwise rate limiting sees the proxy IP).
- Run the app with a DB role that is **not** the table owner and has only `SELECT, INSERT` on `audit_logs`
  (the trigger protects against the app; a non-owner role also prevents dropping the trigger).
- The rate limiter is in-memory (single instance). Use a shared store (e.g. Redis) before running multiple instances.
- Per-account failure limiting can be abused to temporarily lock a known account (15 min); this is the accepted trade-off vs. brute force.

## Known items / not yet in scope
- File storage (private bucket + signed URLs, MIME sniffing, size limits) arrives with the first module that uploads files.
- `npm audit` reports a moderate advisory in `esbuild` bundled by **drizzle-kit** (dev-only CLI used to generate migrations; its dev server is never started). Not shipped to production.
- Web fonts load from Google Fonts; self-host them if the deployment must not call external hosts.
- MFA, password breach checks and session listing UI are candidates for a later hardening sprint.
