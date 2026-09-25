import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Link, useNavigate, useParams } from "react-router";
import { DataList } from "../../components/DataList";
import { useToast } from "../../components/feedback";
import { MapView, type Marker } from "../../components/MapView";
import { ProjectSelect, useProjects } from "../../components/shared";
import { Alert, Badge, Button, Card, CardHeader, EmptyState, Loading, PageHeader, Pagination, Select, StatCard } from "../../components/ui";
import { useApi } from "../../hooks/useApi";
import { api, type Paged } from "../../lib/api";
import { useAuth } from "../../lib/auth";
import { formatDateTime, formatNumber, timeAgo } from "../../lib/format";
import { errorMessage } from "../../lib/forms";
import type { Vehicle } from "../../lib/types";

type Latest = { vehicleId: string; plateNumber: string; status: string; projectName: string | null; driverName: string | null; latitude: string; longitude: string; accuracy: string | null; speed: string | null; recordedAt: string; stale: boolean; tripActive: boolean };
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

export function FleetMapPage() {
  const navigate = useNavigate();
  const projects = useProjects();
  const [projectId, setProjectId] = useState("");
  const latest = useApi<{ data: Latest[]; meta: { staleMinutes: number } }>("/tracking/latest", { projectId });
  const [page, setPage] = useState(1);
  const trips = useApi<Paged<Trip>>("/tracking/trips", { page, pageSize: 10 });
  const { can } = useAuth();
  useEffect(() => {
    const t = setInterval(() => latest.reload(), 30_000);
    return () => clearInterval(t);
  }, [latest]);
  const rows = latest.data?.data ?? [];
  const markers = useMemo<Marker[]>(() => rows.map((r) => ({ id: r.vehicleId, lat: Number(r.latitude), lng: Number(r.longitude), label: `${r.plateNumber}${r.driverName ? ` — ${r.driverName}` : ""}`, color: r.stale ? "#94a3b8" : r.tripActive ? "#059669" : "#1d4ed8" })), [rows]);
  return (
    <>
      <PageHeader title="خريطة الأسطول" subtitle="آخر موقع معروف لكل مركبة (يُحدَّث كل 30 ثانية)" actions={projects.length > 0 && <div className="w-56"><ProjectSelect value={projectId} onChange={setProjectId} projects={projects} /></div>} />
      <div className="mb-3 flex flex-wrap gap-3 text-xs text-slate-600">
        <span className="flex items-center gap-1"><span className="size-3 rounded-full bg-emerald-600" /> في رحلة نشطة</span>
        <span className="flex items-center gap-1"><span className="size-3 rounded-full bg-blue-700" /> متوقفة</span>
        <span className="flex items-center gap-1"><span className="size-3 rounded-full bg-slate-400" /> موقع قديم (أكثر من {latest.data?.meta.staleMinutes ?? 15} دقيقة)</span>
      </div>
      {latest.error ? <Alert>{latest.error.message}</Alert> : <MapView markers={markers} onMarker={(id) => navigate(`/vehicles/${id}`)} height={460} />}
      {!latest.loading && rows.length === 0 && <p className="mt-3 text-sm text-slate-500">لا توجد مواقع مسجلة بعد. تظهر المركبات عند بدء السائقين للرحلات من صفحة «تتبع الرحلة».</p>}
      <div className="mt-6 grid grid-cols-1 gap-6 lg:grid-cols-2">
        <Card>
          <CardHeader title="المركبات على الخريطة" />
          {rows.length === 0 ? <EmptyState icon="map" title="لا توجد مواقع" /> : (
            <ul className="max-h-80 divide-y divide-slate-100 overflow-y-auto">
              {rows.map((r) => <li key={r.vehicleId} className="flex items-center justify-between px-4 py-2 text-sm"><Link to={`/vehicles/${r.vehicleId}`} className="font-medium ltr hover:text-brand-700">{r.plateNumber}</Link><span className="flex items-center gap-2 text-xs text-slate-500">{r.tripActive && <Badge tone="green">في رحلة</Badge>}{r.stale && <Badge tone="gray">قديم</Badge>}{timeAgo(r.recordedAt)}</span></li>)}
            </ul>
          )}
        </Card>
        <Card>
          <CardHeader title="الرحلات" />
          {trips.loading ? <Loading /> : !trips.data?.data.length ? <EmptyState icon="navigation" title="لا توجد رحلات" /> : (
            <>
              <DataList rows={trips.data.data} rowKey={(r) => r.id} onRowClick={(r) => navigate(`/tracking/trips/${r.id}`)} columns={[
                { header: "المركبة", primary: true, cell: (r) => <span className="ltr">{r.plateNumber}</span> },
                { header: "السائق", cell: (r) => r.driverName ?? "—" },
                { header: "البداية", cell: (r) => formatDateTime(r.startedAt) },
                { header: "المسافة", cell: (r) => `${(Number(r.distanceMeters) / 1000).toFixed(1)} كم` },
                { header: "الحالة", cell: (r) => <Badge tone={r.status === "ACTIVE" ? "green" : "gray"}>{r.status === "ACTIVE" ? "نشطة" : "منتهية"}</Badge> },
              ]} />
              <Pagination {...trips.data.meta} onPage={setPage} />
            </>
          )}
        </Card>
      </div>
      {can("gps.track") && <p className="mt-4 text-sm"><Link className="text-brand-700" to="/tracking">تتبع رحلتي</Link></p>}
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
