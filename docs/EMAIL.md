# Email notifications & password reset

Everything is sent by the **server** (Node + nodemailer over SMTP). The browser never talks to the mail provider and never sees SMTP credentials.

## Environment variables (Render → Environment)

| Variable | Required | Purpose |
| --- | --- | --- |
| `APP_URL` | **Yes** (production) | Public https URL used in reset links, e.g. `https://easy-fleet-2.onrender.com` or your domain. Falls back to `PUBLIC_APP_URL`, then the first `APP_ORIGINS` entry. Never hardcoded. |
| `SMTP_HOST` | Yes* | SMTP server, e.g. `smtp.sendgrid.net`, `smtp.office365.com`, `email-smtp.<region>.amazonaws.com` |
| `SMTP_PORT` | No (587) | 587 (STARTTLS) or 465 (implicit TLS) |
| `SMTP_SECURE` | No | `STARTTLS`, `TLS` or `NONE` (local relay only). Default: `TLS` on 465, else `STARTTLS` |
| `SMTP_USER` / `SMTP_PASSWORD` | Usually | SMTP credentials (secret: Dashboard only) |
| `EMAIL_FROM` | Yes* | Sender address (must be allowed by the provider: verified domain/sender) |
| `EMAIL_FROM_NAME` | No (`Easy Fleet`) | Sender display name |
| `SUPPORT_EMAIL` | No | Contact shown in email footers (defaults to the company email, then `EMAIL_FROM`) |
| `EMAIL_SETTINGS_KEY` | No | 32-byte key (base64/hex). Only needed to save the SMTP password from **Settings → Email** (stored AES-256-GCM encrypted). Without it, use `SMTP_PASSWORD`. Generate: `node -e "console.log(require('crypto').randomBytes(32).toString('base64'))"` |
| `PASSWORD_RESET_TTL_MINUTES` | No (30) | Reset link lifetime (5–240) |
| `EMAIL_QUEUE_INTERVAL_SECONDS` | No (15) | Outbox sender interval; `0` disables the in-process sender (then run `npm run jobs:run` from cron) |

\* Or set the same values in **Settings → Email**; any field left empty there falls back to the environment.

Without a host / sender, nothing pretends to be sent: security emails are logged **FAILED** ("email is not configured") and notification emails **SKIPPED**, visible in the email log.

## Password reset ("نسيت كلمة المرور؟")

1. Login → *نسيت كلمة المرور؟* → email → always: *"إذا كان البريد مرتبطًا بحساب، فسيتم إرسال رابط إعادة تعيين كلمة المرور."* The response is sent before any lookup, so neither content nor timing reveals whether the account exists.
2. For an active account: previous unused links are invalidated, a new token (32 random bytes, base64url) is created, **only its SHA-256 is stored** (`password_reset_tokens`), with `expires_at` = now + TTL.
3. Email *"إعادة تعيين كلمة المرور - Easy Fleet"* (Arabic, RTL): greeting, explanation, button, expiry, security warning, support contact. Link: `APP_URL/reset-password#token=…` — the token is in the URL **fragment**, which browsers never send to the server or in `Referer`, so it never appears in access logs. The page removes it from the address bar immediately.
4. The page checks the link (`POST /api/auth/reset-password/verify`), the user sets a password that must pass the existing policy and differ from the current one (`POST /api/auth/reset-password`).
5. On success, in one transaction: new hash, `must_change_password = false`, token marked used + all other outstanding tokens invalidated, **all sessions revoked**, audit entry. The failed-login lock is cleared and a *"تم تغيير كلمة المرور"* email is sent.

Also: changing the password while signed in, or an admin reset, invalidates outstanding links and sends a "password changed" notice (never the password).

## Security controls

| Control | Implementation |
| --- | --- |
| No account enumeration | Identical immediate response for any input; work done after the response; inactive accounts get nothing |
| Token storage | SHA-256 only; tokens never logged, audited or stored in the email log |
| Expiry / single use | `expires_at`; `used_at` set on use, on a newer request and on any password change; row locked (`FOR UPDATE`) during use |
| Rate limits (PostgreSQL, shared by instances) | request: 10 / 15 min per IP (429) and 3 links / hour per email (silently ignored); verify + complete: 20 / 15 min per IP; test email: 5 / 15 min per admin |
| CSRF | Origin / `Sec-Fetch-Site` check on every POST (cross-site forms → 403); authenticated endpoints also need the session CSRF token |
| Cookies | Unchanged: `__Host-` + Secure + HttpOnly + SameSite=Strict in production |
| Sessions after reset | Every session of the account is revoked |
| Passwords in email | Never (welcome email has no password; admin temporary passwords are shown to the admin only) |
| SMTP errors | Users never see them; admins see a short safe reason (e.g. "SMTP authentication failed"); logs contain only the log id + safe reason |
| SMTP password | Environment variable, or AES-256-GCM encrypted in `email_settings` (key from `EMAIL_SETTINGS_KEY`); write-only in the API/UI |
| Production | The test transport hook is refused when `NODE_ENV=production` |

## Notifications by email

In-app notifications of these types also get an email (queued in `email_log` **in the same transaction** — an action that rolls back sends nothing — then sent by the outbox, 3 attempts with back-off):

- insurance / registration / license / document expiring or expired
- maintenance due, oil change due (new vehicle *service schedule*: next service / oil change date or odometer; reminders at 14/7/0 days or 1000/500/0 km, de-duplicated)
- accident reported, violation recorded, critical maintenance
- maintenance / quote approval required, invoice / expense submitted
- maintenance, quote, invoice, expense approved / rejected
- important system alerts (admin broadcast)

Security emails (password reset, password changed, new-device sign-in, welcome) are sent immediately and cannot be disabled.

**Preferences:** each user chooses per category *in app* and *by email* (Settings → Notifications). Administrators can switch email notifications off for the organization or per category (Settings → Email). SYSTEM alerts cannot be turned off by users.

**New sign-in alert:** sent when the account has signed in before and no sign-in in the last 90 days came from the same IP + browser.

## Email log & administration (Settings → Email, `settings.manage` ALL)

- SMTP host, port, username, password (write-only), From name / email, support email, TLS/SSL, configuration status, **send test email** (server-side).
- Delivery log: recipient, type, subject, status (`QUEUED`, `SENDING`, `SENT`, `FAILED`, `SKIPPED`), attempts, safe failure reason, created / sent time. Scoped to the organization.
- `email_log` never stores message bodies of security emails, tokens, passwords or SMTP secrets (notification rows keep only title / body / in-app link to render the message).
- Audit trail: `AUTH_PASSWORD_RESET_REQUESTED`, `AUTH_PASSWORD_RESET_COMPLETED`, `AUTH_PASSWORD_CHANGED`, `EMAIL_SENT`, `EMAIL_FAILED`, `EMAIL_SETTINGS_UPDATED` (field names only, never values of secrets).

## Database (migration `0005_email_notifications_password_reset`, additive only)

`password_reset_tokens`, `email_log`, `email_settings`, `notification_preferences.email_enabled` (default true) and `vehicles.next_service_date / next_service_odometer / next_oil_change_date / next_oil_change_odometer` (nullable). Nothing is dropped or rewritten; it is applied by the existing `npm run db:setup` / `start:render` migrator.

## Render: manual steps

1. Choose a provider and verify the sender domain (SPF/DKIM) — e.g. SendGrid, Mailgun, Amazon SES, Microsoft 365, Google Workspace SMTP relay.
2. Service → Environment: set `APP_URL`, `SMTP_HOST`, `SMTP_PORT`, `SMTP_USER`, `SMTP_PASSWORD`, `EMAIL_FROM` (optionally `EMAIL_FROM_NAME`, `SUPPORT_EMAIL`, `EMAIL_SETTINGS_KEY`).
3. Deploy (migration 0005 runs automatically and only adds tables/columns).
4. Settings → Email: check the status is "configured", send a test email, check the log.
5. Try *نسيت كلمة المرور؟* with your own account.

Emails are Arabic (RTL) by product decision.
