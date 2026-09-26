import L from "leaflet";
import "leaflet/dist/leaflet.css";
import { forwardRef, useEffect, useImperativeHandle, useRef, useState } from "react";
import { useApi } from "../hooks/useApi";
import { diffFleet, markerSignature, STATE_META, type FleetVehicle } from "../lib/fleetMap";
import type { MapConfig } from "./MapView";
import { Alert, Loading } from "./ui";

export type FleetMapHandle = { zoomIn: () => void; zoomOut: () => void; fitAll: () => void; focus: (id: string) => void };

const TRUCK = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M2 6h12v10H2zM14 9h4l3.5 3.5V16H14M6 19.3a1.8 1.8 0 1 0 0-3.6 1.8 1.8 0 0 0 0 3.6zM17.5 19.3a1.8 1.8 0 1 0 0-3.6 1.8 1.8 0 0 0 0 3.6z"/></svg>';

const esc = (s: string) => s.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!);

/** Marker = coloured disc with a vehicle icon, a heading arrow when moving, an "!" for alerts and the plate. */
function iconFor(v: FleetVehicle, selected: boolean): L.DivIcon {
  const m = STATE_META[v.state];
  const arrow = v.motion === "MOVING" && v.heading !== null ? `<span class="ef-heading" style="transform:rotate(${Math.round(v.heading)}deg)"></span>` : "";
  const alert = v.alert ? '<span class="ef-alert" aria-hidden="true">!</span>' : "";
  return L.divIcon({
    className: "ef-marker-wrap",
    html: `<div class="ef-marker ef-${v.state.toLowerCase()}${selected ? " ef-selected" : ""}" style="--c:${m.color};--r:${m.ring}">${arrow}<span class="ef-dot">${TRUCK}</span>${alert}<span class="ef-plate">${esc(v.plate)}</span></div>`,
    iconSize: [44, 44],
    iconAnchor: [22, 22],
  });
}

/**
 * Live fleet map. Markers are kept by vehicle id and updated in place: a
 * refresh only moves / restyles markers whose position or state changed, so
 * the map, the viewport and the selection are never rebuilt.
 */
export const FleetMap = forwardRef<FleetMapHandle, { vehicles: FleetVehicle[]; selectedId: string | null; onSelect: (id: string | null) => void; fitKey?: string; className?: string; height?: number | string }>(function FleetMap(
  { vehicles, selectedId, onSelect, fitKey = "", className, height = "100%" },
  ref,
) {
  const cfg = useApi<{ data: MapConfig }>("/config/map");
  const el = useRef<HTMLDivElement>(null);
  const map = useRef<L.Map | null>(null);
  const markers = useRef(new Map<string, L.Marker>());
  const sigs = useRef(new Map<string, string>());
  const byId = useRef(new Map<string, FleetVehicle>());
  const onSelectRef = useRef(onSelect);
  onSelectRef.current = onSelect;
  const [ready, setReady] = useState(false);
  const lastFit = useRef<string | null>(null);

  const fitAll = () => {
    const m = map.current;
    const pts = [...byId.current.values()].map((v) => [v.lat, v.lng] as L.LatLngTuple);
    if (!m || !pts.length) return;
    if (pts.length === 1) m.setView(pts[0]!, 14);
    else m.fitBounds(L.latLngBounds(pts), { padding: [48, 48], maxZoom: 15 });
  };
  const focus = (id: string) => {
    const v = byId.current.get(id);
    if (map.current && v) map.current.setView([v.lat, v.lng], Math.max(map.current.getZoom(), 14), { animate: true });
  };
  useImperativeHandle(ref, () => ({ zoomIn: () => map.current?.zoomIn(), zoomOut: () => map.current?.zoomOut(), fitAll, focus }));

  // Create the map once.
  useEffect(() => {
    if (!cfg.data || !el.current || map.current) return;
    const c = cfg.data.data;
    const m = L.map(el.current, { zoomControl: false, attributionControl: true, tapTolerance: 20 }).setView([c.center.lat, c.center.lng], c.zoom);
    L.tileLayer(c.tileUrl, { maxZoom: c.maxZoom, attribution: c.attribution }).addTo(m);
    m.on("click", () => onSelectRef.current(null));
    map.current = m;
    setReady(true);
    const ro = typeof ResizeObserver === "function" ? new ResizeObserver(() => m.invalidateSize()) : null;
    ro?.observe(el.current);
    return () => {
      ro?.disconnect();
      m.remove();
      map.current = null;
      markers.current.clear();
      sigs.current.clear();
    };
  }, [cfg.data]);

  // Diff-based marker updates.
  useEffect(() => {
    const m = map.current;
    if (!m || !ready) return;
    byId.current = new Map(vehicles.map((v) => [v.id, v]));
    const d = diffFleet(sigs.current, vehicles);
    for (const id of d.removed) {
      markers.current.get(id)?.remove();
      markers.current.delete(id);
      sigs.current.delete(id);
    }
    for (const id of [...d.added, ...d.updated]) {
      const v = byId.current.get(id)!;
      const label = `${v.plate} — ${STATE_META[v.state].label}`;
      let mk = markers.current.get(id);
      if (!mk) {
        mk = L.marker([v.lat, v.lng], { icon: iconFor(v, id === selectedId), title: label, alt: label, keyboard: true, riseOnHover: true }).addTo(m);
        mk.on("click", (e) => {
          L.DomEvent.stopPropagation(e);
          onSelectRef.current(id);
        });
        markers.current.set(id, mk);
      } else {
        mk.setLatLng([v.lat, v.lng]);
        mk.setIcon(iconFor(v, id === selectedId));
        mk.getElement()?.setAttribute("title", label);
      }
      sigs.current.set(id, markerSignature(v));
    }
    if (lastFit.current !== fitKey && vehicles.length) {
      lastFit.current = fitKey;
      fitAll();
    }
  }, [vehicles, ready, fitKey, selectedId]);

  // Selection styling + centring.
  useEffect(() => {
    if (!ready) return;
    for (const [id, mk] of markers.current) {
      const v = byId.current.get(id);
      if (!v) continue;
      mk.setIcon(iconFor(v, id === selectedId));
      mk.setZIndexOffset(id === selectedId ? 1000 : 0);
    }
    if (selectedId) focus(selectedId);
  }, [selectedId, ready]);

  if (cfg.error) return <Alert>{cfg.error.message}</Alert>;
  return (
    <div className={className} style={{ height, position: "relative" }}>
      {!cfg.data && <Loading label="جارٍ تحميل الخريطة..." />}
      <div ref={el} className="absolute inset-0 z-0" dir="ltr" role="region" aria-label="خريطة الأسطول" />
    </div>
  );
});
