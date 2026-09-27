import { useCallback, useEffect, useRef, useState } from "react";
import { useParams } from "react-router";
import { useToast } from "../../components/feedback";
import { MapView, type Marker } from "../../components/MapView";
import { Alert, Button, Card, EmptyState, Loading, PageHeader, Select, StatCard } from "../../components/ui";
import { useApi } from "../../hooks/useApi";
import { api, type Paged } from "../../lib/api";
import { formatDateTime, formatNumber, timeAgo } from "../../lib/format";
import { errorMessage } from "../../lib/forms";
import type { Vehicle } from "../../lib/types";
import { t } from "../../i18n";

type Trip = { id: string; vehicleId: string; plateNumber: string; driverName: string | null; source: string; status: string; startedAt: string; endedAt: string | null; distanceMeters: string; pointCount: number; lastPointAt: string | null };
type Point = { lat: number; lng: number; accuracy: number | null; speed: number | null; heading: number | null; recordedAt: string };

const QUEUE_KEY = "ef.gps.queue";

/**
 * Driver tracker (web/PWA). Uses watchPosition while the page is open; points
 * are batched every 20 s and queued locally when offline. A future native app
 * posts to the same endpoints with source=NATIVE for background tracking.
 */
export function DriverTrackingPage() {
  const toast = useToast();
  const active = useApi<{ data: (Trip & { plateNumber: string }) | null }>("/tracking/trips/active");
  const vehicles = useApi<Paged<Vehicle>>("/vehicles", { pageSize: 20 });
  const [vehicleId, setVehicleId] = useState("");
  const [last, setLast] = useState<GeolocationPosition | null>(null);
  const [sent, setSent] = useState(0);
  const [pending, setPending] = useState(0);
  const [geoError, setGeoError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const queue = useRef<Point[]>([]);
  const trip = active.data?.data ?? null;

  useEffect(() => {
    try {
      queue.current = JSON.parse(localStorage.getItem(QUEUE_KEY) ?? "[]") as Point[];
    } catch {
      queue.current = [];
    }
    setPending(queue.current.length);
  }, []);
  const persist = () => {
    try {
      localStorage.setItem(QUEUE_KEY, JSON.stringify(queue.current.slice(-2000)));
    } catch {
      /* storage unavailable: keep in memory */
    }
    setPending(queue.current.length);
  };

  const flush = useCallback(async () => {
    if (!trip || !queue.current.length || !navigator.onLine) return;
    const batch = queue.current.slice(0, 100);
    try {
      const r = await api<{ data: { accepted: number } }>(`/tracking/trips/${trip.id}/points`, { method: "POST", body: { points: batch } });
      queue.current = queue.current.slice(batch.length);
      persist();
      setSent((s) => s + r.data.accepted);
    } catch {
      /* keep queued; retry on next tick */
    }
  }, [trip]);

  useEffect(() => {
    if (!trip) return;
    if (!navigator.geolocation) return setGeoError(t("tracking.thisBrowserDoesNotSupport"));
    const id = navigator.geolocation.watchPosition(
      (p) => {
        setLast(p);
        setGeoError(null);
        queue.current.push({ lat: p.coords.latitude, lng: p.coords.longitude, accuracy: p.coords.accuracy ?? null, speed: p.coords.speed !== null && p.coords.speed >= 0 ? Math.min(p.coords.speed, 200) : null, heading: p.coords.heading !== null && !Number.isNaN(p.coords.heading) ? p.coords.heading : null, recordedAt: new Date(p.timestamp).toISOString() });
        persist();
      },
      (e) => setGeoError(e.code === 1 ? t("tracking.locationPermissionDeniedEnableIt") : t("tracking.couldNotGetTheLocation")),
      { enableHighAccuracy: true, maximumAge: 10_000, timeout: 30_000 },
    );
    const item = setInterval(() => void flush(), 20_000);
    let wake: { release: () => Promise<void> } | null = null;
    (navigator as Navigator & { wakeLock?: { request: (item: string) => Promise<{ release: () => Promise<void> }> } }).wakeLock?.request("screen").then((w) => { wake = w; }).catch(() => undefined);
    return () => {
      navigator.geolocation.clearWatch(id);
      clearInterval(item);
      void wake?.release();
    };
  }, [trip, flush]);

  const start = async () => {
    if (!vehicleId) return toast.error(t("common.selectAVehicle2"));
    setBusy(true);
    try {
      await api("/tracking/trips", { method: "POST", body: { vehicleId, source: "WEB" } });
      toast.success(t("tracking.tripStartedKeepThisPage"));
      active.reload();
    } catch (err) {
      toast.error(errorMessage(err));
    } finally {
      setBusy(false);
    }
  };
  const end = async () => {
    setBusy(true);
    try {
      await flush();
      await api(`/tracking/trips/${trip!.id}/end`, { method: "POST" });
      toast.success(t("tracking.tripEnded"));
      queue.current = [];
      persist();
      active.reload();
    } catch (err) {
      toast.error(errorMessage(err));
    } finally {
      setBusy(false);
    }
  };
  const marker: Marker[] = last ? [{ id: "me", lat: last.coords.latitude, lng: last.coords.longitude, label: t("tracking.myCurrentLocation") }] : [];
  const myVehicles = (vehicles.data?.data ?? []).filter((v) => v.status !== "ARCHIVED");

  return (
    <>
      <PageHeader title={t("common.tripTracking")} subtitle={t("tracking.yourLocationIsSentOnly")} />
      {active.loading ? <Loading /> : !trip ? (
        <Card className="p-5">
          <div className="space-y-4">
            <Alert tone="blue">{t("tracking.selectTheVehicleAssignedTo")}</Alert>
            <Select value={vehicleId} onChange={(e) => setVehicleId(e.target.value)} aria-label={t("common.vehicle")}><option value="">{t("common.selectAVehicle3")}</option>{myVehicles.map((v) => <option key={v.id} value={v.id}>{v.plateNumber} — {v.make} {v.model}</option>)}</Select>
            <Button icon="play" className="w-full py-3" loading={busy} onClick={start}>{t("tracking.startTrip")}</Button>
          </div>
        </Card>
      ) : (
        <div className="space-y-4">
          <div className="grid grid-cols-2 gap-4 lg:grid-cols-4">
            <StatCard label={t("common.vehicle")} value={<span className="ltr">{trip.plateNumber}</span>} icon="truck" />
            <StatCard label={t("tracking.started")} value={timeAgo(trip.startedAt)} icon="clock" tone="violet" />
            <StatCard label={t("tracking.pointsSent")} value={formatNumber(sent)} icon="pin" tone="green" />
            <StatCard label={t("tracking.waitingToSend")} value={formatNumber(pending)} icon="refresh" tone={pending > 50 ? "amber" : "gray"} />
          </div>
          {geoError && <Alert>{geoError}</Alert>}
          {last && <p className="text-xs text-slate-500">{t("tracking.lastLocationMAccuracy", { accuracy: Math.round(last.coords.accuracy), value: formatDateTime(new Date(last.timestamp)) })}</p>}
          <MapView markers={marker} height={320} />
          <Button variant="danger" icon="stop" className="w-full py-3" loading={busy} onClick={end}>{t("tracking.endTrip")}</Button>
        </div>
      )}
    </>
  );
}

export function TripDetailPage() {
  const { id } = useParams();
  const { data, loading, error } = useApi<{ data: { trip: Trip; points: { id: number; lat: string; lng: string; recordedAt: string }[] } }>(`/tracking/trips/${id}/points`);
  if (loading) return <Loading />;
  if (error || !data) return <Alert>{error?.message ?? t("common.couldNotLoad")}</Alert>;
  const pts = data.data.points.map((p) => [Number(p.lat), Number(p.lng)] as [number, number]);
  const item = data.data.trip;
  const ends: Marker[] = pts.length ? [{ id: "s", lat: pts[0]![0], lng: pts[0]![1], label: t("common.start"), color: "#059669" }, { id: "e", lat: pts[pts.length - 1]![0], lng: pts[pts.length - 1]![1], label: t("tracking.lastPoint"), color: "#dc2626" }] : [];
  return (
    <>
      <PageHeader title={t("common.tripRoute")} subtitle={t("tracking.kmPoints", { startedAt: formatDateTime(item.startedAt), value: item.endedAt ? formatDateTime(item.endedAt) : t("common.inProgress"), value2: (Number(item.distanceMeters) / 1000).toFixed(1), pointCount: item.pointCount })} />
      {pts.length === 0 ? <EmptyState icon="map" title={t("common.noPointsRecordedForThis")} /> : <MapView markers={ends} path={pts} height={480} />}
    </>
  );
}
