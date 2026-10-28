# Driver portal (mobile) — pickup and return by project

One **permanent link per driver** (`/p/<token>`). The driver needs no account. He sees the vehicles of his **current project**,
takes one available vehicle, completes the mandatory photos, confirms; later he returns the same vehicle the same way. The
electronic signature is no longer collected or required anywhere (old signatures and records are kept).

## The link
- Admin: **بوابة السائقين** (`/driver-portal`, needs `handover.manage` and `drivers.read`; a project manager only for drivers of his own projects).
- One row per driver in `driver_portal_links`; only the SHA-256 of the token is stored. The raw link is shown **once** (create / renew);
  if it is lost, renew it. Renewing kills the old token at once; revoking stops it; "open a new link" re-enables a revoked driver.
- The link is tied to the driver and his organization. The vehicles shown come from the driver's **current** project on every request, so a
  project change needs no new link.
- Tokens are 256-bit random values; unknown/revoked tokens all answer 404, are audited (`DRIVER_PORTAL_TOKEN_INVALID`) and rate limited per IP.
  Taking a vehicle, confirming a pickup/return and cancelling also need the driver's **employee number** (5 wrong answers lock the driver out
  for 15 minutes, audited as `DRIVER_PORTAL_IDENTITY_FAILED`). Logs and Caddy redact `/p/<token>` and `/api/portal/<token>`.

## Rules (server side, plus unique indexes)
- Only vehicles of the driver's project are listed or takeable (other projects answer 404). A driver without a project sees none.
- A vehicle can be taken when it is `AVAILABLE`, has no driver assigned and no open session; vehicles held by someone else show only
  "taken by another driver" (no name); maintenance/accident/out-of-service ones show their status.
- **One vehicle per driver, one driver per vehicle**: `handover_one_active_per_driver_uq` / `_per_vehicle_uq` (partial unique indexes on
  `PENDING_HANDOVER`/`RETURN_PENDING`) plus a row lock on the vehicle, so concurrent requests produce exactly one custody.
- Custody ends when the return is confirmed (`RETURN_COMPLETED`; the vehicle is `AVAILABLE` again); the admin review/close step stays.
- Project change while holding a vehicle: that vehicle stays listed and returnable; no new pickup until it is returned.
- Pickup: 7 photos + odometer + confirmation (`HANDOVER_COMPLETED`); return: the same for the return phase (`HANDOVER_RETURN_COMPLETED`).
  Duplicate submissions are refused; a driver cannot touch another driver's session.
- Portal sessions are ordinary `handover_sessions` rows (`via_portal = true`, no link of their own): one custody history, same photos,
  audit and notifications. The older admin-created link (`/h/<token>`) keeps working.

## Administration
- Drivers table: link state, last access, current custody. Per project: vehicles available / occupied (by whom, since when) / unavailable.
- Latest pickups and returns (full list and photos in **التسليم والاستلام**).
- **Exceptional administrative return** (handover detail → "إغلاق العهدة إداريًا"): for a lost link or a vehicle that cannot be returned. A reason is
  mandatory; the session becomes `RETURN_COMPLETED`, the vehicle is freed, nothing is deleted, audited as `HANDOVER_FORCE_RETURNED`.

## Database (migration 0009, additive)
`driver_portal_links` (new table) and `handover_sessions.via_portal boolean not null default false`. No data is rewritten or dropped.
Apply it with the normal deploy (`migrate`); the code needs it, so it must run before the new release serves traffic.
