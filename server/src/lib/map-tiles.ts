/**
 * Map tile provider resolution (pure; evaluated once at startup from the environment).
 *
 * - MAP_TILE_URL (alias TILE_URL) unset → CARTO "Voyager" raster basemap (OpenStreetMap data,
 *   global CDN, no key), loaded directly by the browser.
 * - MAP_TILE_URL set → that provider. A template carrying a credential (key=, api_key=,
 *   access_token=, …) is proxied through /api/map/tiles so the key never reaches the
 *   browser; a keyless one is loaded directly. MAP_TILE_PROXY=true|false overrides.
 *
 * tile.openstreetmap.org (and any invalid template) is never used — the default provider is used instead: its tile usage policy is best-effort with no SLA,
 * forbids heavy/production reliance and proxying, and it blocks requests that arrive
 * without a Referer (this app sends `Referrer-Policy: same-origin`).
 */

export type TileMode = "direct" | "proxy";

export type MapTiles = {
  /** Short provider label shown in settings (never contains the URL or key). */
  name: string;
  mode: TileMode;
  /** Upstream template (may contain a key; server-side only). */
  upstream: string;
  /** Template given to Leaflet: the upstream itself (direct) or the same-origin proxy. */
  browserUrl: string;
  subdomains: string[];
  attribution: string;
  maxZoom: number;
  /** Extra CSP img-src origins (direct mode only). */
  imgSrc: string[];
  /** Set when the configured URL was rejected and the default is used instead. */
  warning?: string;
};

export const DEFAULT_TILES = {
  name: "CARTO Voyager",
  url: "https://{s}.basemaps.cartocdn.com/rastertiles/voyager/{z}/{x}/{y}{r}.png",
  subdomains: "abcd",
  attribution: '&copy; <a href="https://www.openstreetmap.org/copyright" target="_blank" rel="noopener noreferrer">OpenStreetMap</a> contributors &copy; <a href="https://carto.com/attributions" target="_blank" rel="noopener noreferrer">CARTO</a>',
  maxZoom: 20,
};

const OSM_ATTRIBUTION = '&copy; <a href="https://www.openstreetmap.org/copyright" target="_blank" rel="noopener noreferrer">OpenStreetMap</a> contributors';

/** Query parameters that carry a provider credential (MapTiler, Stadia, Thunderforest, Mapbox, HERE, …). */
const SECRET_PARAM = /^(key|api[_-]?key|apikey|access[_-]?token|token|app[_-]?(id|code)|client[_-]?id|signature|sig)$/i;

const BLOCKED_HOSTS = /(^|\.)tile\.openstreetmap\.org$/i;

/** A concrete URL for validation / CSP (placeholders replaced by harmless values). */
function sample(template: string, s: string): URL {
  return new URL(template.replace(/\{s\}/g, s).replace(/\{z\}|\{x\}|\{y\}|\{-y\}/g, "0").replace(/\{r\}/g, ""));
}

export function hasCredential(template: string): boolean {
  const u = sample(template, "a");
  if (u.username || u.password) return true;
  return [...u.searchParams.keys()].some((k) => SECRET_PARAM.test(k));
}

export function resolveMapTiles(env: {
  url?: string;
  subdomains?: string;
  attribution?: string;
  maxZoom?: number;
  proxy?: "auto" | "true" | "false";
  production?: boolean;
}): MapTiles {
  const custom = env.url?.trim();
  const upstream = custom || DEFAULT_TILES.url;
  // A bad map setting must never stop the server (or silently keep an old deployment running):
  // anything unusable falls back to the default provider with a startup warning.
  const fallback = (why: string): MapTiles => ({
    ...resolveMapTiles({ ...env, url: undefined, attribution: undefined, subdomains: undefined }),
    warning: `${why}; using the default CARTO basemap instead.`,
  });
  if (!/\{z\}/.test(upstream) || !/\{x\}/.test(upstream) || !/\{-?y\}/.test(upstream)) {
    return fallback("MAP_TILE_URL must contain {z}, {x} and {y} placeholders");
  }
  let probe: URL;
  try {
    probe = sample(upstream, "a");
  } catch {
    return fallback("MAP_TILE_URL is not a valid URL template");
  }
  if (probe.protocol !== "https:" && !(probe.protocol === "http:" && !env.production)) {
    return fallback("MAP_TILE_URL must use https");
  }
  if (BLOCKED_HOSTS.test(probe.hostname)) {
    return fallback("MAP_TILE_URL points at tile.openstreetmap.org, which is not allowed (OSM tile usage policy: no production use, no proxying, Referer required). Configure a provider such as MapTiler, Stadia Maps or Thunderforest");
  }
  // Leaflet semantics: "abc" = one subdomain per character; "t1,t2" = a list.
  const rawSubs = env.subdomains?.trim() || (custom ? "abc" : DEFAULT_TILES.subdomains);
  const subdomains = (/[\s,]/.test(rawSubs) ? rawSubs.split(/[\s,]+/) : [...rawSubs]).filter(Boolean);
  const secret = hasCredential(upstream);
  const mode: TileMode = env.proxy === "true" ? "proxy" : env.proxy === "false" ? "direct" : secret ? "proxy" : "direct";
  const origins = /\{s\}/.test(upstream) ? subdomains.map((s) => sample(upstream, s).origin) : [probe.origin];
  return {
    name: custom ? (mode === "proxy" ? "proxy" : probe.hostname) : DEFAULT_TILES.name,
    mode,
    upstream,
    // {r} (retina "@2x") is resolved by Leaflet in direct mode; the proxy serves standard tiles.
    browserUrl: mode === "proxy" ? "/api/map/tiles/{z}/{x}/{y}" : upstream,
    subdomains,
    attribution: env.attribution?.trim() || (custom ? OSM_ATTRIBUTION : DEFAULT_TILES.attribution),
    maxZoom: Math.min(22, Math.max(1, env.maxZoom ?? (custom ? 19 : DEFAULT_TILES.maxZoom))),
    imgSrc: mode === "direct" ? [...new Set(origins)] : [],
  };
}

/** Upstream URL for one tile (proxy mode). */
export function upstreamTileUrl(t: Pick<MapTiles, "upstream" | "subdomains">, z: number, x: number, y: number): string {
  const s = t.subdomains.length ? t.subdomains[(x + y) % t.subdomains.length]! : "";
  return t.upstream
    .replace(/\{s\}/g, s)
    .replace(/\{z\}/g, String(z))
    .replace(/\{x\}/g, String(x))
    .replace(/\{-y\}/g, String(2 ** z - 1 - y))
    .replace(/\{y\}/g, String(y))
    .replace(/\{r\}/g, "");
}
