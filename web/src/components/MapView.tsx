import L from "leaflet";
import "leaflet/dist/leaflet.css";
import { useEffect, useRef } from "react";
import { useApi } from "../hooks/useApi";
import { Alert, Loading } from "./ui";

export type MapConfig = { provider: string; tileUrl: string; attribution: string; maxZoom: number; center: { lat: number; lng: number }; zoom: number };
export type Marker = { id: string; lat: number; lng: number; label: string; popup?: string; color?: string };

/**
 * Provider-agnostic map: the tile URL comes from /api/config/map (public OSM,
 * or the server-side proxy when a keyed provider is configured — the key never
 * reaches the browser). Markers are circle markers (no external icon assets).
 */
export function MapView({ markers, path, height = 420, onMarker }: { markers: Marker[]; path?: [number, number][]; height?: number; onMarker?: (id: string) => void }) {
  const cfg = useApi<{ data: MapConfig }>("/config/map");
  const el = useRef<HTMLDivElement>(null);
  const map = useRef<L.Map | null>(null);
  const layer = useRef<L.LayerGroup | null>(null);

  useEffect(() => {
    if (!cfg.data || !el.current || map.current) return;
    const c = cfg.data.data;
    map.current = L.map(el.current, { zoomControl: true, attributionControl: true }).setView([c.center.lat, c.center.lng], c.zoom);
    L.tileLayer(c.tileUrl, { maxZoom: c.maxZoom, attribution: c.attribution }).addTo(map.current);
    layer.current = L.layerGroup().addTo(map.current);
    return () => {
      map.current?.remove();
      map.current = null;
    };
  }, [cfg.data]);

  useEffect(() => {
    const m = map.current;
    const g = layer.current;
    if (!m || !g) return;
    g.clearLayers();
    const bounds: L.LatLngExpression[] = [];
    if (path && path.length > 1) {
      L.polyline(path, { color: "#1d4ed8", weight: 4, opacity: 0.8 }).addTo(g);
      bounds.push(...path);
    }
    for (const mk of markers) {
      const c = L.circleMarker([mk.lat, mk.lng], { radius: 9, color: "#fff", weight: 2, fillColor: mk.color ?? "#1d4ed8", fillOpacity: 1 }).addTo(g);
      c.bindTooltip(mk.label, { direction: "top", offset: [0, -8] });
      if (mk.popup) c.bindPopup(mk.popup);
      if (onMarker) c.on("click", () => onMarker(mk.id));
      bounds.push([mk.lat, mk.lng]);
    }
    if (bounds.length === 1) m.setView(bounds[0]!, 14);
    else if (bounds.length > 1) m.fitBounds(L.latLngBounds(bounds as L.LatLngTuple[]), { padding: [30, 30], maxZoom: 15 });
  }, [markers, path, onMarker, cfg.data]);

  if (cfg.error) return <Alert>{cfg.error.message}</Alert>;
  return (
    <div className="relative overflow-hidden rounded-xl ring-1 ring-slate-200" style={{ height }}>
      {!cfg.data && <Loading label="جارٍ تحميل الخريطة..." />}
      <div ref={el} className="absolute inset-0 z-0" dir="ltr" role="region" aria-label="خريطة" />
    </div>
  );
}
