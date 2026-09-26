/**
 * Fleet map data logic (pure, framework-free, unit-tested).
 *
 * Input: rows from GET /api/tracking/latest — the latest position each vehicle
 * actually reported (speed in m/s). Nothing here invents or interpolates a
 * position: a vehicle without a reported position is only counted as "no GPS".
 */

export type LatestLocation = {
  vehicleId: string;
  plateNumber: string;
  plateArabic?: string | null;
  vehicleNumber?: string | null;
  make?: string | null;
  model?: string | null;
  status: string;
  projectId: string | null;
  projectName: string | null;
  driverId?: string | null;
  driverName: string | null;
  currentDriverName?: string | null;
  latitude: string;
  longitude: string;
  accuracy: string | null;
  speed: string | null;
  heading: string | null;
  recordedAt: string;
  tripId?: string | null;
  tripActive: boolean;
  openAccident?: boolean;
  stale?: boolean;
};

export type MotionState = "MOVING" | "STOPPED" | "OFFLINE";
export type MarkerState = MotionState | "ALERT";
export type StatusFilter = "" | MarkerState;

export type FleetVehicle = {
  id: string;
  plate: string;
  plateArabic: string | null;
  vehicleNumber: string | null;
  makeModel: string;
  projectId: string | null;
  projectName: string | null;
  driverName: string | null;
  lat: number;
  lng: number;
  speedKmh: number | null;
  heading: number | null;
  recordedAt: string;
  ageSeconds: number;
  motion: MotionState;
  alert: string | null;
  /** What the marker shows: ALERT wins over the motion state. */
  state: MarkerState;
  tripActive: boolean;
  tripId: string | null;
  vehicleStatus: string;
};

/** Below this speed a reporting vehicle counts as stopped (GPS jitter). */
export const MOVING_KMH = 5;
/** Above this speed the marker shows an overspeed alert. */
export const OVERSPEED_KMH = 120;
export const DEFAULT_STALE_MINUTES = 15;
export const POLL_MS = 15_000;

export const STATE_META: Record<MarkerState, { label: string; color: string; ring: string; tone: "green" | "amber" | "gray" | "red" }> = {
  MOVING: { label: "متحركة", color: "#059669", ring: "#a7f3d0", tone: "green" },
  STOPPED: { label: "متوقفة", color: "#d97706", ring: "#fde68a", tone: "amber" },
  OFFLINE: { label: "غير متصلة", color: "#94a3b8", ring: "#e2e8f0", tone: "gray" },
  ALERT: { label: "تنبيه", color: "#dc2626", ring: "#fecaca", tone: "red" },
};

export const msToKmh = (ms: number) => ms * 3.6;

const num = (v: string | null | undefined): number | null => {
  if (v === null || v === undefined || v === "") return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
};

/** Keeps only the newest row per vehicle (defensive: the API already returns one per vehicle). */
export function latestPerVehicle<T extends { vehicleId: string; recordedAt: string }>(rows: T[]): T[] {
  const best = new Map<string, T>();
  for (const r of rows) {
    const cur = best.get(r.vehicleId);
    if (!cur || Date.parse(r.recordedAt) > Date.parse(cur.recordedAt)) best.set(r.vehicleId, r);
  }
  return [...best.values()];
}

/** Motion state from the age and speed of the last report. */
export function motionOf(ageSeconds: number, speedKmh: number | null, staleMinutes = DEFAULT_STALE_MINUTES): MotionState {
  if (ageSeconds > staleMinutes * 60) return "OFFLINE";
  return speedKmh !== null && speedKmh >= MOVING_KMH ? "MOVING" : "STOPPED";
}

/** Alert reason (null = none): open accident / accident status, or overspeed on a live report. */
export function alertOf(row: Pick<LatestLocation, "openAccident" | "status">, motion: MotionState, speedKmh: number | null): string | null {
  if (row.openAccident || row.status === "ACCIDENT") return "حادث مفتوح";
  if (motion !== "OFFLINE" && speedKmh !== null && speedKmh > OVERSPEED_KMH) return "تجاوز السرعة";
  return null;
}

export function toFleetVehicle(r: LatestLocation, nowMs: number, staleMinutes = DEFAULT_STALE_MINUTES): FleetVehicle | null {
  const lat = num(r.latitude);
  const lng = num(r.longitude);
  if (lat === null || lng === null || Math.abs(lat) > 90 || Math.abs(lng) > 180) return null; // never guess a position
  const speed = num(r.speed);
  const speedKmh = speed === null ? null : Math.round(msToKmh(speed));
  const ageSeconds = Math.max(0, Math.round((nowMs - Date.parse(r.recordedAt)) / 1000));
  const motion = motionOf(ageSeconds, speedKmh, staleMinutes);
  const alert = alertOf(r, motion, speedKmh);
  return {
    id: r.vehicleId,
    plate: r.plateNumber,
    plateArabic: r.plateArabic ?? null,
    vehicleNumber: r.vehicleNumber ?? null,
    makeModel: [r.make, r.model].filter(Boolean).join(" "),
    projectId: r.projectId,
    projectName: r.projectName,
    driverName: r.currentDriverName ?? r.driverName ?? null,
    lat,
    lng,
    speedKmh,
    heading: num(r.heading),
    recordedAt: r.recordedAt,
    ageSeconds,
    motion,
    alert,
    state: alert ? "ALERT" : motion,
    tripActive: r.tripActive,
    tripId: r.tripId ?? null,
    vehicleStatus: r.status,
  };
}

export function toFleet(rows: LatestLocation[], nowMs: number, staleMinutes = DEFAULT_STALE_MINUTES): FleetVehicle[] {
  return latestPerVehicle(rows)
    .map((r) => toFleetVehicle(r, nowMs, staleMinutes))
    .filter((v): v is FleetVehicle => v !== null)
    .sort((a, b) => a.plate.localeCompare(b.plate));
}

export type FleetFilter = { projectId?: string; status?: StatusFilter; q?: string };

const norm = (s: string) => s.toLowerCase().replace(/\s+/g, "");

/** Project / status / vehicle-or-driver search. Status ALERT matches alerts; motion filters match the motion state. */
export function filterFleet(list: FleetVehicle[], f: FleetFilter): FleetVehicle[] {
  const q = f.q ? norm(f.q) : "";
  return list.filter((v) => {
    if (f.projectId && v.projectId !== f.projectId) return false;
    if (f.status === "ALERT" && !v.alert) return false;
    if (f.status && f.status !== "ALERT" && v.motion !== f.status) return false;
    if (q) {
      const hay = [v.plate, v.plateArabic, v.vehicleNumber, v.driverName, v.makeModel].filter(Boolean).map((s) => norm(s!));
      if (!hay.some((h) => h.includes(q))) return false;
    }
    return true;
  });
}

export type FleetCounts = { total: number; located: number; moving: number; stopped: number; offline: number; alerts: number; noGps: number };

/** Counts for the map header and dashboard widget. `total` = vehicles in scope (API meta.total). */
export function fleetCounts(list: FleetVehicle[], totalInScope?: number): FleetCounts {
  const c = { moving: 0, stopped: 0, offline: 0, alerts: 0 };
  for (const v of list) {
    if (v.motion === "MOVING") c.moving++;
    else if (v.motion === "STOPPED") c.stopped++;
    else c.offline++;
    if (v.alert) c.alerts++;
  }
  const total = Math.max(totalInScope ?? list.length, list.length);
  return { total, located: list.length, ...c, noGps: total - list.length };
}

/** A marker only needs redrawing when something it displays changed. */
export const markerSignature = (v: FleetVehicle) => `${v.lat.toFixed(6)},${v.lng.toFixed(6)}|${v.state}|${v.heading ?? ""}|${v.plate}`;

export type FleetDiff = { added: string[]; updated: string[]; removed: string[]; unchanged: string[] };

export function diffFleet(prev: Map<string, string>, next: FleetVehicle[]): FleetDiff {
  const out: FleetDiff = { added: [], updated: [], removed: [], unchanged: [] };
  const seen = new Set<string>();
  for (const v of next) {
    seen.add(v.id);
    const sig = markerSignature(v);
    const old = prev.get(v.id);
    if (old === undefined) out.added.push(v.id);
    else if (old !== sig) out.updated.push(v.id);
    else out.unchanged.push(v.id);
  }
  for (const id of prev.keys()) if (!seen.has(id)) out.removed.push(id);
  return out;
}

/** Keeps the selected vehicle only while it is still visible after a refresh / filter change. */
export function keepSelection(selectedId: string | null, visible: FleetVehicle[]): string | null {
  return selectedId && visible.some((v) => v.id === selectedId) ? selectedId : null;
}

/** "منذ 20 ثانية" style label for ages. */
export function agoLabel(seconds: number): string {
  const s = Math.max(0, Math.round(seconds));
  if (s < 5) return "الآن";
  if (s < 60) return `منذ ${s} ثانية`;
  const m = Math.floor(s / 60);
  if (m < 60) return `منذ ${m} دقيقة`;
  const h = Math.floor(m / 60);
  if (h < 24) return `منذ ${h} ساعة`;
  return `منذ ${Math.floor(h / 24)} يوم`;
}

export const speedLabel = (kmh: number | null) => (kmh === null ? "—" : `${kmh} كم/س`);

export function parseStatusParam(v: string | null): StatusFilter {
  return v === "MOVING" || v === "STOPPED" || v === "OFFLINE" || v === "ALERT" ? v : "";
}

// ---------------------------------------------------------------- trips

export type TripRangePreset = "today" | "yesterday" | "7d" | "custom";

const addDays = (iso: string, days: number) => {
  const [y, m, d] = iso.split("-").map(Number) as [number, number, number];
  const dt = new Date(Date.UTC(y, m - 1, d + days));
  return dt.toISOString().slice(0, 10);
};

/** Date range (inclusive, YYYY-MM-DD in the business day) for a preset. */
export function tripRange(preset: TripRangePreset, todayIso: string, custom?: { from: string; to: string }): { from: string; to: string } {
  if (preset === "today") return { from: todayIso, to: todayIso };
  if (preset === "yesterday") {
    const y = addDays(todayIso, -1);
    return { from: y, to: y };
  }
  if (preset === "7d") return { from: addDays(todayIso, -6), to: todayIso };
  const from = custom?.from || todayIso;
  const to = custom?.to || from;
  return from <= to ? { from, to } : { from: to, to: from };
}

export function durationLabel(startIso: string, endIso: string | null, nowMs = Date.now()): string {
  const ms = (endIso ? Date.parse(endIso) : nowMs) - Date.parse(startIso);
  if (!Number.isFinite(ms) || ms < 0) return "—";
  const min = Math.round(ms / 60_000);
  if (min < 60) return `${min} د`;
  return `${Math.floor(min / 60)} س ${min % 60} د`;
}
