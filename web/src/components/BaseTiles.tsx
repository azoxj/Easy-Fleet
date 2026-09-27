import L from "leaflet";
import { useCallback, useRef, useState } from "react";
import { t } from "../i18n";
import { createTileHealth, ERROR_TILE, tileLayerOptions, type MapConfig, type TileStatus } from "../lib/mapTiles";
import { Icon } from "./icons";

/**
 * Adds the configured base-map tile layer and reports its health. Returns the
 * status, an `attach(map, config)` to call once when the map is created and a
 * `retry()` that reloads the tiles (markers are left untouched).
 */
export function useBaseTiles() {
  const [status, setStatus] = useState<TileStatus>("loading");
  const layer = useRef<L.TileLayer | null>(null);
  const health = useRef(createTileHealth());

  const attach = useCallback((m: L.Map, c: MapConfig) => {
    health.current.reset();
    setStatus("loading");
    const tl = L.tileLayer(c.tileUrl, tileLayerOptions(c));
    tl.on("tileload", (e: L.TileEvent) => {
      // Leaflet also fires tileload when the placeholder replacing a failed tile loads; that is not a success.
      if (e.tile.getAttribute("src") === ERROR_TILE) return;
      setStatus(health.current.load());
    });
    tl.on("tileerror", () => setStatus(health.current.error()));
    tl.addTo(m);
    layer.current = tl;
    return tl;
  }, []);

  const retry = useCallback(() => {
    setStatus(health.current.reset());
    layer.current?.redraw();
  }, []);

  return { status, attach, retry };
}

/** Shown over the map when the background tiles cannot be loaded; the vehicles stay visible. */
export function TileErrorBanner({ status, onRetry, className = "" }: { status: TileStatus; onRetry: () => void; className?: string }) {
  if (status !== "failed") return null;
  return (
    <div role="alert" className={`absolute inset-x-14 top-3 z-[600] mx-auto flex max-w-md flex-wrap items-center justify-center gap-2 rounded-lg bg-amber-50/95 px-3 py-2 text-center text-sm text-amber-900 shadow ring-1 ring-amber-200 ${className}`}>
      <Icon name="alert" className="size-4 shrink-0" />
      <span>{t("mapTiles.unavailable")}</span>
      <button type="button" onClick={onRetry} className="rounded-md bg-white px-2 py-0.5 font-medium text-amber-900 ring-1 ring-amber-300 hover:bg-amber-100 focus-visible:outline-2 focus-visible:outline-amber-600">
        {t("mapTiles.retry")}
      </button>
    </div>
  );
}
