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
    if (!navigator.geolocation) return setGeoError("المتصفح لا يدعم تحديد الموقع");
    const id = navigator.geolocation.watchPosition(
      (p) => {
        setLast(p);
        setGeoError(null);
        queue.current.push({ lat: p.coords.latitude, lng: p.coords.longitude, accuracy: p.coords.accuracy ?? null, speed: p.coords.speed !== null && p.coords.speed >= 0 ? Math.min(p.coords.speed, 200) : null, heading: p.coords.heading !== null && !Number.isNaN(p.coords.heading) ? p.coords.heading : null, recordedAt: new Date(p.timestamp).toISOString() });
        persist();
      },
      (e) => setGeoError(e.code === 1 ? "تم رفض إذن الموقع — فعّله من إعدادات المتصفح" : "تعذر الحصول على الموقع"),
      { enableHighAccuracy: true, maximumAge: 10_000, timeout: 30_000 },
    );
    const t = setInterval(() => void flush(), 20_000);
    let wake: { release: () => Promise<void> } | null = null;
    (navigator as Navigator & { wakeLock?: { request: (t: string) => Promise<{ release: () => Promise<void> }> } }).wakeLock?.request("screen").then((w) => { wake = w; }).catch(() => undefined);
    return () => {
      navigator.geolocation.clearWatch(id);
      clearInterval(t);
      void wake?.release();
    };
  }, [trip, flush]);

  const start = async () => {
    if (!vehicleId) return toast.error("اختر المركبة");
    setBusy(true);
    try {
      await api("/tracking/trips", { method: "POST", body: { vehicleId, source: "WEB" } });
      toast.success("بدأت الرحلة — أبقِ الصفحة مفتوحة");
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
      toast.success("انتهت الرحلة");
      queue.current = [];
      persist();
      active.reload();
    } catch (err) {
      toast.error(errorMessage(err));
    } finally {
      setBusy(false);
    }
  };
  const marker: Marker[] = last ? [{ id: "me", lat: last.coords.latitude, lng: last.coords.longitude, label: "موقعي الحالي" }] : [];
  const myVehicles = (vehicles.data?.data ?? []).filter((v) => v.status !== "ARCHIVED");

  return (
    <>
      <PageHeader title="تتبع الرحلة" subtitle="يُرسل موقعك أثناء الرحلة فقط وما دامت الصفحة مفتوحة" />
      {active.loading ? <Loading /> : !trip ? (
        <Card className="p-5">
          <div className="space-y-4">
            <Alert tone="blue">اختر مركبتك المسندة إليك ثم ابدأ الرحلة. سيطلب المتصفح إذن الوصول للموقع.</Alert>
            <Select value={vehicleId} onChange={(e) => setVehicleId(e.target.value)} aria-label="المركبة"><option value="">اختر المركبة...</option>{myVehicles.map((v) => <option key={v.id} value={v.id}>{v.plateNumber} — {v.make} {v.model}</option>)}</Select>
            <Button icon="play" className="w-full py-3" loading={busy} onClick={start}>بدء الرحلة</Button>
          </div>
        </Card>
      ) : (
        <div className="space-y-4">
          <div className="grid grid-cols-2 gap-4 lg:grid-cols-4">
            <StatCard label="المركبة" value={<span className="ltr">{trip.plateNumber}</span>} icon="truck" />
            <StatCard label="بدأت" value={timeAgo(trip.startedAt)} icon="clock" tone="violet" />
            <StatCard label="نقاط مرسلة" value={formatNumber(sent)} icon="pin" tone="green" />
            <StatCard label="بانتظار الإرسال" value={formatNumber(pending)} icon="refresh" tone={pending > 50 ? "amber" : "gray"} />
          </div>
          {geoError && <Alert>{geoError}</Alert>}
          {last && <p className="text-xs text-slate-500">آخر موقع: دقة ±{Math.round(last.coords.accuracy)} م — {formatDateTime(new Date(last.timestamp))}</p>}
          <MapView markers={marker} height={320} />
          <Button variant="danger" icon="stop" className="w-full py-3" loading={busy} onClick={end}>إنهاء الرحلة</Button>
        </div>
      )}
    </>
  );
}

export function TripDetailPage() {
  const { id } = useParams();
  const { data, loading, error } = useApi<{ data: { trip: Trip; points: { id: number; lat: string; lng: string; recordedAt: string }[] } }>(`/tracking/trips/${id}/points`);
  if (loading) return <Loading />;
  if (error || !data) return <Alert>{error?.message ?? "تعذر التحميل"}</Alert>;
  const pts = data.data.points.map((p) => [Number(p.lat), Number(p.lng)] as [number, number]);
  const t = data.data.trip;
  const ends: Marker[] = pts.length ? [{ id: "s", lat: pts[0]![0], lng: pts[0]![1], label: "البداية", color: "#059669" }, { id: "e", lat: pts[pts.length - 1]![0], lng: pts[pts.length - 1]![1], label: "آخر نقطة", color: "#dc2626" }] : [];
  return (
    <>
      <PageHeader title="مسار الرحلة" subtitle={`${formatDateTime(t.startedAt)} — ${t.endedAt ? formatDateTime(t.endedAt) : "جارية"} · ${(Number(t.distanceMeters) / 1000).toFixed(1)} كم · ${t.pointCount} نقطة`} />
      {pts.length === 0 ? <EmptyState icon="map" title="لا توجد نقاط مسجلة لهذه الرحلة" /> : <MapView markers={ends} path={pts} height={480} />}
    </>
  );
}
