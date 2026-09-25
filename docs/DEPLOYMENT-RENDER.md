# Easy Fleet — Render Preview Deployment

Target: one **Render Web Service (Node.js)** that serves the API (`/api`) and the built SPA from the same
origin, plus **Render PostgreSQL**. The configuration lives in [`render.yaml`](../render.yaml) (Blueprint).
No secret is stored in Git.

## Commands (all from existing package.json scripts)

| Step | Command | What it does |
|---|---|---|
| Build | `npm ci --include=dev && npm run build` | installs the workspace (devDependencies are needed for `tsc`, `vite` and `tsx`), builds `server/dist` and `web/dist` |
| Pre-deploy | `npm run db:setup` | `db:migrate` applies `server/drizzle/0000 → 0004` in journal order with the existing drizzle migrator (already-applied migrations are skipped), then `db:bootstrap` syncs roles/permissions and creates the first admin if `BOOTSTRAP_ADMIN_*` are set. Idempotent |
| Start | `npm run start -w server` | `node --env-file-if-exists=.env dist/index.js` (no `.env` exists on Render; env comes from the Dashboard). Listens on Render's `PORT` |
| Health check | `/api/readyz` | 200 only when the database answers and private storage is writable |

## Environment variables

| VARIABLE | REQUIRED / OPTIONAL | PURPOSE |
|---|---|---|
| `DATABASE_URL` | **Required** | From Render PostgreSQL (`fromDatabase` in render.yaml, internal URL). Never in Git |
| `NODE_ENV` | **Required** = `production` | enables production guards (secure cookies, https origins, scrypt cost) and blocks the demo seed |
| `COOKIE_SECURE` | **Required** = `true` | `Secure` + `__Host-` session cookie (HTTPS only). The app refuses to start in production without it |
| `TRUST_PROXY` | **Required** = `1` | Render terminates TLS in front of the app; needed so `req.protocol` is `https` and rate limits see the client IP |
| `WEB_DIST_DIR` | Recommended = `../web/dist` | built SPA served from the same origin. Resolved against the working directory, then against `server/`; when unset, production falls back to `<repo>/web/dist`. A missing build is logged at startup |
| `STORAGE_ROOT` | **Required** = `/var/data/storage` | private upload directory on the persistent disk (takes precedence over `STORAGE_DIR`). Must not be inside the web root |
| `NODE_VERSION` | **Required** = `22` | Node ≥ 22.9 (`--env-file-if-exists`) |
| `BOOTSTRAP_ADMIN_EMAIL` | Required for the first deploy | email of the first SUPER_ADMIN |
| `BOOTSTRAP_ADMIN_PASSWORD` | Required for the first deploy (secret) | ≥ 10 chars, 3 of 4 character classes. The admin must change it at first login. **Delete this variable after the first successful deploy** |
| `BOOTSTRAP_ADMIN_NAME` | Optional | display name of the first admin |
| `APP_ORIGINS` | Optional | comma-separated allowed browser origins (CSRF/Origin check). Defaults to `RENDER_EXTERNAL_URL` (e.g. `https://easy-fleet.onrender.com`). **Set it when adding a custom domain.** Production rejects non-https/localhost values |
| `PUBLIC_APP_URL` | Optional | base URL used in handover links and QR codes (defaults to the first `APP_ORIGINS`) |
| `APP_TIMEZONE` | Optional (default `Asia/Riyadh`) | business "today" for expiry rules |
| `SESSION_IDLE_MINUTES` / `SESSION_ABSOLUTE_HOURS` | Optional (60 / 12) | session lifetime |
| `MAX_UPLOAD_MB` | Optional (10) | upload size limit |
| `HANDOVER_LINK_DAYS` | Optional (14) | validity of handover links |
| `MAP_TILE_URL` | Optional | keyed tile provider template; proxied through `/api/map/tiles` so the key never reaches the browser. Unset = public OpenStreetMap |
| `MAP_ATTRIBUTION`, `MAP_DEFAULT_CENTER` | Optional | map display settings |
| `DISABLE_JOBS` | Optional (false) | disables the in-process jobs (expiry reminders, session/rate-limit cleanup) |
| `SCRYPT_LOG_N` | Do not set | defaults to 17 (production minimum) |
| `PORT`, `RENDER_EXTERNAL_URL` | Set by Render | do not set manually |

Not used by this architecture (do **not** create them):
- `SESSION_SECRET`: sessions are opaque 256-bit random tokens stored hashed (SHA-256) in PostgreSQL; nothing is signed, so there is no signing secret. CSRF tokens are also random per session.
- `SUPABASE_*`: Supabase is not used.
- `DEMO_PASSWORD`: the demo seed refuses to run in production.

## Render Dashboard steps (Blueprint)

1. Render Dashboard → **New → Blueprint** → connect GitHub → choose `azoxj/Easy-Fleet`, branch **`claude/easy-fleet-sprint-1`**.
2. Render reads `render.yaml` and shows two resources: `easy-fleet-db` (PostgreSQL) and `easy-fleet` (web service, Starter plan with a 1 GB disk).
   - Free PostgreSQL is for the preview only: it **expires after 30 days** and has no backups. Choose a paid plan (e.g. Basic-256mb) if the data must be kept.
3. Fill in the `sync: false` values when prompted:
   - `BOOTSTRAP_ADMIN_EMAIL` = your admin email
   - `BOOTSTRAP_ADMIN_PASSWORD` = a strong password (type it in the Dashboard only)
   - `BOOTSTRAP_ADMIN_NAME` = optional
4. Click **Apply**. Render creates the database, builds, runs the pre-deploy step (migrations 0000 → 0004 + roles/permissions + first admin), starts the service, and waits for `/api/readyz` to return 200.
5. Check the deploy logs for:
   - `[migrate] database is up to date`
   - `[bootstrap] ... system roles synced`
   - `SUPER_ADMIN ... created`
6. Open `https://<service>.onrender.com/api/healthz` and `/api/readyz`. Expect `{"status":"ok"}` and `{"status":"ready","checks":{"database":true,"storage":true}}`.
7. Open `https://<service>.onrender.com` on the iPhone (Safari), log in, and change the password when asked.
8. Remove `BOOTSTRAP_ADMIN_PASSWORD` (Environment tab). This triggers a redeploy; bootstrap then only syncs roles.
9. Optional: Safari → Share → **Add to Home Screen** installs the PWA.

Manual alternative (without Blueprint): create PostgreSQL first. Then create a Web Service (Node) with the same build, pre-deploy, start and health-check values and the same env vars. Set `DATABASE_URL` to the database's **Internal** connection string, and add a disk mounted at `/var/data`.

## Storage — preview only
- Uploaded files (invoice files, receipts, handover photos, documents) are stored on the service's **persistent disk** at `STORAGE_ROOT`.
  - They are private: never under the web root, downloaded only through authorized endpoints, magic-byte validated.
- A Render disk ties the service to **one instance** (no horizontal scaling, and zero-downtime deploys are not available with a disk).
- **This is not the final production storage.** Before production, move `server/src/services/storage.ts` to an object store (S3/R2/GCS) with private buckets and signed URLs. File metadata and authorization already live in PostgreSQL.
- On the Free web plan there is no disk: files would be lost on every deploy/restart. That is why the Blueprint uses Starter.

## Security checklist (verified locally in a production-mode simulation)
- No secrets in Git (`.env` ignored; render.yaml has no secret values).
- `NODE_ENV=production` refuses to start without `COOKIE_SECURE=true` or with a non-https / localhost `APP_ORIGINS`.
- Session cookie `__Host-ef_session; Secure; HttpOnly; SameSite=Strict`; CSRF token + Origin/Sec-Fetch-Site checks on writes.
- No CORS headers are emitted: the SPA and the API share one origin, so no `Access-Control-Allow-Origin: *`.
- HSTS is sent when `COOKIE_SECURE=true`; Render provides HTTPS.
- Rate limits for login, password, uploads, public handover links and GPS are stored in PostgreSQL. The general API limiter is per instance.
- `/api/healthz` exposes only `{"status":"ok"}`; `/api/readyz` exposes booleans only.

## Known limitations of the preview
- Free PostgreSQL: 30-day lifetime, no backups.
- Single instance because of the disk; files are on local disk.
- Password hashing uses scrypt N=2¹⁷, about 128 MB of RAM per login in progress. Starter has 512 MB, which is fine for a preview; use a larger plan for many simultaneous logins.
- Map tiles come from public OpenStreetMap (fair-use policy). Set `MAP_TILE_URL` for a commercial provider.
- Web GPS tracking works only while the page is open on the phone. Camera and geolocation require HTTPS, which Render provides.
- No demo data in production (the seed is blocked). Create projects, vehicles and users from the admin account.
