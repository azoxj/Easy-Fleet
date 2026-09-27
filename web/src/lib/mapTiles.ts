/**
 * Base-map tile helpers shared by the fleet map and the small map views.
 * Tiles are only the background: vehicle markers, routes and GPS data never
 * depend on them, so a tile failure is reported without touching the markers.
 */

export type MapConfig = {
  provider: string;
  /** "direct": the browser loads the provider's tiles; "proxy": same-origin /api/map/tiles (key stays on the server). */
  mode?: "direct" | "proxy";
  tileUrl: string;
  subdomains?: string[];
  attribution: string;
  maxZoom: number;
  center: { lat: number; lng: number };
  zoom: number;
};

export type TileStatus = "loading" | "ok" | "failed";

/** Neutral placeholder drawn in place of a tile that failed (no broken-image icons). */
export const ERROR_TILE = "data:image/svg+xml;charset=utf-8," + encodeURIComponent('<svg xmlns="http://www.w3.org/2000/svg" width="256" height="256"><rect width="256" height="256" fill="#eef2f6"/></svg>');

/** Leaflet TileLayer options for the configured provider. */
export function tileLayerOptions(c: MapConfig) {
  return {
    maxZoom: c.maxZoom,
    attribution: c.attribution,
    ...(c.subdomains?.length ? { subdomains: c.subdomains } : {}),
    // Cross-origin providers get the site origin only (never the page path, which can hold handover tokens);
    // several providers require a Referer, and the document policy (same-origin) would send none.
    referrerPolicy: c.mode === "proxy" ? ("same-origin" as const) : ("strict-origin-when-cross-origin" as const),
    errorTileUrl: ERROR_TILE,
  };
}

/**
 * Tracks the most recent tile loads/errors. The base map counts as failed when
 * at least `minErrors` of the last `window` tiles failed and they are the
 * majority (a few missing tiles at the edge of coverage are not an outage).
 * It recovers on its own as soon as tiles load again.
 */
export function createTileHealth(opts: { window?: number; minErrors?: number } = {}) {
  const size = opts.window ?? 16;
  const minErrors = opts.minErrors ?? 4;
  let recent: boolean[] = [];
  const push = (ok: boolean) => {
    recent.push(ok);
    if (recent.length > size) recent.shift();
    return status();
  };
  const status = (): TileStatus => {
    if (!recent.length) return "loading";
    const errors = recent.filter((ok) => !ok).length;
    return errors >= minErrors && errors * 2 > recent.length ? "failed" : "ok";
  };
  return {
    load: () => push(true),
    error: () => push(false),
    reset: () => {
      recent = [];
      return status();
    },
    status,
  };
}
