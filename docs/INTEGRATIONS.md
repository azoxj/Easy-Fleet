# API integrations (Settings → تكامل API)

Infrastructure only. The first integration slot is **الغسيل الساطع (Bright Washing)**. No real API exists in the code: no endpoint, authentication scheme or payload is assumed, and nothing is mocked as real data.

## Behaviour today
- The card is off by default. Off = no test, no sync (HTTP 409).
- On = settings (API Base URL, API Key, Client ID, Client Secret), connection status, test connection, sync now, last test / last sync, sync log.
- Test and sync answer **WAITING_FOR_API** ("بانتظار إعداد API الغسيل الساطع"): reason `NOT_CONFIGURED` (URL/key missing) or `ADAPTER_PENDING` (filled in, but the real adapter awaits the provider's documentation). Every attempt is logged in `integration_sync_runs`.

## Architecture (`server/src/integrations`)
- `types.ts` – `WashProvider`: `testConnection()`, `syncWashes()`, `getWash()`, `getSyncStatus()`.
- `bright-washing.ts` – `BrightWashingProvider` (no network calls). The real client replaces its `waiting()` once documentation exists.
- `matching.ts` – `decideMatch()` and the `VehicleMatcher` interface. Matching is by plate; exactly one candidate matches; none or several go to the review queue. A vehicle is never created automatically. Plate normalization is **not** implemented: a future service plugs in behind `VehicleMatcher`.
- `service.ts` – settings loading, sync runs, `matchOrQueue()`.
- `base-url.ts` – https only; no credentials/query in the URL; no localhost, `.local`/`.internal` or IP literals.

## Security
- Permission `integrations.manage` (SUPER_ADMIN only, ALL scope); all checks are server-side.
- API key / client secret: AES-256-GCM (same server key as the SMTP password, `EMAIL_SETTINGS_KEY`), write-only — the API returns only "saved / not saved". Without the key, secrets cannot be saved.
- Secrets never reach the frontend, logs or the audit trail (audit records field names only).
- Audit actions: `INTEGRATION_ENABLED`, `INTEGRATION_DISABLED`, `INTEGRATION_SETTINGS_UPDATED`, `INTEGRATION_TEST`, `INTEGRATION_SYNC_RUN`.
- Test / sync are rate limited (10 per 15 min per user, PostgreSQL-backed).

## Database (migration `0006_api_integrations`, additive only)
`integration_settings` (unique per organization + provider), `integration_sync_runs` (STARTED / COMPLETED / FAILED / WAITING_FOR_API, counts, error summary), `integration_review_queue` (NO_MATCH / AMBIGUOUS, one pending row per external id).

## Routes (all need `integrations.manage`)
`GET /api/integrations`, `GET|PUT /api/integrations/bright-washing`, `POST …/test`, `POST …/sync`, `GET …/runs`, `GET …/review`.

## Needed from الغسيل الساطع for the real connection
Official API documentation; a test account/sandbox; base URLs per environment; the authentication scheme; endpoints to list/get washes with paging and incremental sync; the field list (plate format, wash id, service type, time zone, status values, cost/tax, invoice number, project/site, provider details); rate limits, error codes, webhooks if any; sample data with known plates.
