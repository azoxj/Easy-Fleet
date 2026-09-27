# Easy Fleet — Fleet Map & Vehicle GPS

## How a vehicle position reaches the map

```
Driver phone (page "تتبع الرحلة", browser Geolocation, permission-based)
  └─ POST /api/tracking/trips               start a trip on the driver's own assigned vehicle
  └─ POST /api/tracking/trips/:id/points    batched points every ~20 s (queued offline)
        → location_pings   (every point: lat, lng, accuracy, speed m/s, heading, recorded_at)
        → vehicle_locations (one row per vehicle = latest known position, upserted)
Fleet map / dashboard widget / vehicle profile
  └─ GET /api/tracking/latest               latest position of every vehicle in scope
  └─ GET /api/tracking/trips?vehicleId&from&to   trip history (+ max speed)
  └─ GET /api/tracking/trips/:id/points     recorded route of one trip
```

No new tables or migrations: the map uses the existing `vehicle_locations`, `trips` and `location_pings`.
Positions are only ever the ones a device actually reported — nothing is interpolated or invented.
A vehicle that never reported has no marker; it is only counted as "بلا موقع" (`meta.total` − located).
Demo data contains demo trips/positions labelled DEMO.

## Refresh ("live") mechanism

Polling, not WebSocket/SSE: the architecture is a stateless REST API (single instance on Render, no
pub/sub), so the client polls `GET /api/tracking/latest`:

- every **15 s** on the map page, every 30 s for the dashboard widget;
- paused while the browser tab is hidden, refreshed immediately when it becomes visible;
- the first load shows a loading state; later refreshes swap the data silently;
- markers are kept per vehicle and **updated in place** — only markers whose position/state changed are
  moved or restyled (`diffFleet` in `web/src/lib/fleetMap.ts`), so the page, the viewport and the
  selected vehicle are preserved;
- "آخر تحديث قبل X ثانية" + a manual "تحديث الآن" button; "منذ …" labels are corrected for client/server
  clock skew using `meta.serverTime`.

## Marker states

| State | Rule | Marker |
|---|---|---|
| متحركة (MOVING) | last report ≤ 15 min old and speed ≥ 5 km/h | green disc + heading arrow |
| متوقفة (STOPPED) | last report ≤ 15 min old and speed < 5 km/h (or unknown) | amber disc |
| غير متصلة (OFFLINE) | last report older than 15 min | grey disc |
| تنبيه (ALERT) | open accident / vehicle status ACCIDENT, or live speed > 120 km/h | red disc + "!" (motion state still shown in the panel) |

Every state is also written as text (chips, badges, panel, marker tooltip) — colour is never the only signal.

## Security

`/api/tracking/latest` uses the same server-side `vehicleScope(access, "gps.read")` as the vehicle
endpoints; the `projectId` / `vehicleId` filters can only narrow that scope, never widen it. Trips and
points use the existing trip scope (own trips for drivers with `gps.track`). Role defaults are unchanged:
SUPER_ADMIN (ALL), PROJECT_MANAGER (own projects); DRIVER and VIEWER have no `gps.read` and receive 403.
Covered by `server/tests/fleet-map.test.ts`.

## Limits of browser tracking (important)

- The web tracker records **only while the "تتبع الرحلة" page is open and the screen is on**. Browsers
  do not allow a normal web page to track location in the background; on iPhone (Safari/PWA) tracking
  stops as soon as the page is backgrounded or the phone is locked. The app never requests background
  location.
- Therefore the map shows "last reported position", and vehicles become "غير متصلة" 15 minutes after
  their last report.
- **Continuous background vehicle tracking requires either:**
  1. a **native driver app** with background-location permission (it can post to the same endpoints with
     `source = NATIVE`), or
  2. a **dedicated GPS tracker installed in the vehicle** (integrated server-side into `vehicle_locations`).

## Base map tiles

The tiles are only the background; markers, routes, GPS polling and panels never depend on them.

- **Why OpenStreetMap's tile server was replaced.** The map used `https://tile.openstreetmap.org/{z}/{x}/{y}.png` directly. The app sends `Referrer-Policy: same-origin`, so cross-origin tile requests carried **no `Referer`**. The OSM tile usage policy requires a valid Referer for browser requests and answers such requests with an "Access blocked" tile. The same policy also offers the service best-effort only (no SLA), forbids heavy/production reliance and forbids proxying, so it is not a production tile source; if `MAP_TILE_URL` points at it, the server logs a warning and uses the default provider instead.
- **Default:** CARTO Voyager raster basemap (`https://{s}.basemaps.cartocdn.com/rastertiles/voyager/{z}/{x}/{y}{r}.png`, OpenStreetMap data, global CDN, retina tiles, no key), attribution "© OpenStreetMap contributors © CARTO". CARTO's free basemaps are limited to non-commercial use / a monthly view quota; for a commercial deployment configure a keyed provider.
- **Configure a provider** without code changes (`MAP_TILE_URL` or `TILE_URL`, plus `MAP_ATTRIBUTION`):

  | Provider | `MAP_TILE_URL` |
  | --- | --- |
  | MapTiler | `https://api.maptiler.com/maps/streets-v2/{z}/{x}/{y}.png?key=KEY` |
  | Stadia Maps | `https://tiles.stadiamaps.com/tiles/alidade_smooth/{z}/{x}/{y}.png?api_key=KEY` |
  | Thunderforest | `https://{s}.tile.thunderforest.com/transport/{z}/{x}/{y}.png?apikey=KEY` |

  A key in the template is detected and the tiles are proxied through `/api/map/tiles` (the browser never sees the key; the proxy sends an identifying User-Agent and caches tiles). `MAP_TILE_PROXY=true|false` overrides the detection; `MAP_TILE_SUBDOMAINS` and `MAP_TILE_MAX_ZOOM` tune the layer. CSP `img-src` automatically allows only the configured direct origins.
- **Failure state:** if most recent tiles fail to load (network, quota, provider outage), failed tiles are drawn as a neutral grey and a banner says "The map background could not be loaded. Vehicle positions are still shown." with a **Retry** button (Arabic: "تعذر تحميل خلفية الخريطة…" / "إعادة المحاولة"). Vehicles are still shown and no position is invented.
