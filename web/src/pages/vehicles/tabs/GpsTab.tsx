import { useMemo, useState } from "react";
import { Link } from "react-router";
import { DataList } from "../../../components/DataList";
import { MapView, type Marker } from "../../../components/MapView";
import { DateRange, todayIso } from "../../../components/shared";
import { Alert, Button, Card, CardHeader, EmptyState, Loading, cx } from "../../../components/ui";
import { useApi } from "../../../hooks/useApi";
import type { Paged } from "../../../lib/api";
import { agoLabel, durationLabel, msToKmh, speedLabel, STATE_META, toFleetVehicle, tripRange, type LatestLocation, type TripRangePreset } from "../../../lib/fleetMap";
import { formatDate, formatDateTime } from "../../../lib/format";
import { StateBadge } from "../../../components/StateBadge";

type Trip = { id: string; driverName: string | null; status: string; startedAt: string; endedAt: string | null; distanceMeters: string; pointCount: number; maxSpeed: string | null };
type Point = { id: number; lat: string; lng: string; speed: string | null; recordedAt: string };

const PRESETS: { key: TripRangePreset; label: string }[] = [
  { key: "today", label: "اليوم" },
  { key: "yesterday", label: "أمس" },
  { key: "7d", label: "آخر 7 أيام" },
  { key: "custom", label: "فترة مخصصة" },
];

const timeOf = (iso: string) => new Intl.DateTimeFormat("ar-SA-u-nu-latn", { hour: "2-digit", minute: "2-digit" }).format(new Date(iso));

/**
 * Vehicle GPS: latest reported position + trip history with the recorded route.
 * Only positions the driver's device actually sent are shown — nothing is
 * interpolated or invented for vehicles without GPS history.
 */
export function GpsTab({ vehicleId }: { vehicleId: string }) {
  const latest = useApi<{ data: LatestLocation[]; meta: { staleMinutes: number; serverTime: string } }>("/tracking/latest", { vehicleId });
  const [preset, setPreset] = useState<TripRangePreset>("7d");
  const [custom, setCustom] = useState({ from: "", to: "" });
  const range = tripRange(preset, todayIso(), custom);
  const trips = useApi<Paged<Trip>>("/tracking/trips", { vehicleId, from: range.from, to: range.to, pageSize: 50 });
  const [tripId, setTripId] = useState<string | null>(null);
  const points = useApi<{ data: { trip: Trip; points: Point[] } }>(tripId ? `/tracking/trips/${tripId}/points` : null);

  const row = latest.data?.data[0];
  const serverNow = latest.data ? Date.parse(latest.data.meta.serverTime) : Date.now();
  const loc = row ? toFleetVehicle(row, serverNow, latest.data?.meta.staleMinutes) : null;
  const locMarker: Marker[] = loc ? [{ id: loc.id, lat: loc.lat, lng: loc.lng, label: `${loc.plate} — ${STATE_META[loc.state].label}`, color: STATE_META[loc.state].color }] : [];
  const path = useMemo(() => (points.data?.data.points ?? []).map((p) => [Number(p.lat), Number(p.lng)] as [number, number]), [points.data]);
  const ends: Marker[] = path.length ? [{ id: "s", lat: path[0]![0], lng: path[0]![1], label: "بداية الرحلة", color: "#059669" }, { id: "e", lat: path[path.length - 1]![0], lng: path[path.length - 1]![1], label: "نهاية الرحلة", color: "#dc2626" }] : [];
  const selectedTrip = trips.data?.data.find((t) => t.id === tripId) ?? null;

  return (
    <div className="space-y-6">
      <Card>
        <CardHeader title="الموقع الحالي" subtitle="آخر موقع أرسله جهاز السائق" action={loc && <Link to={`/map?vehicle=${vehicleId}`} className="inline-flex min-h-11 items-center text-sm font-medium text-brand-700 hover:underline">عرض على خريطة الأسطول</Link>} />
        {latest.loading ? <Loading /> : latest.error ? <div className="p-4"><Alert>{latest.error.message}</Alert></div> : !loc ? (
          <EmptyState icon="pin" title="لا يوجد موقع مسجل لهذه المركبة" description="يظهر الموقع عندما يبدأ السائق رحلة من صفحة «تتبع الرحلة» ويرسل هاتفه موقعه." />
        ) : (
          <div className="grid grid-cols-1 gap-4 p-4 lg:grid-cols-[18rem_minmax(0,1fr)]">
            <dl className="grid grid-cols-2 gap-x-4 gap-y-3 text-sm lg:grid-cols-1">
              <div><dt className="text-xs text-slate-500">الحالة</dt><dd className="mt-1 flex flex-wrap gap-1"><StateBadge state={loc.motion} />{loc.alert && <StateBadge state="ALERT" />}</dd></div>
              <div><dt className="text-xs text-slate-500">السرعة</dt><dd className="mt-1 font-medium">{speedLabel(loc.speedKmh)}</dd></div>
              <div><dt className="text-xs text-slate-500">آخر تحديث</dt><dd className="mt-1 font-medium" title={formatDateTime(loc.recordedAt)}>{agoLabel(loc.ageSeconds)}</dd></div>
              <div><dt className="text-xs text-slate-500">السائق</dt><dd className="mt-1 font-medium">{loc.driverName ?? "—"}</dd></div>
              <div className="col-span-2 lg:col-span-1"><dt className="text-xs text-slate-500">الإحداثيات</dt><dd className="mt-1 font-medium ltr text-start">{loc.lat.toFixed(5)}, {loc.lng.toFixed(5)}</dd></div>
            </dl>
            <MapView markers={locMarker} height={240} />
          </div>
        )}
      </Card>

      <Card>
        <CardHeader title="سجل الرحلات" subtitle={range.from === range.to ? formatDate(range.from) : `${formatDate(range.from)} — ${formatDate(range.to)}`} />
        <div className="flex flex-wrap items-center gap-2 border-b border-slate-100 p-4" role="group" aria-label="الفترة">
          {PRESETS.map((p) => (
            <button key={p.key} onClick={() => { setPreset(p.key); setTripId(null); }} aria-pressed={preset === p.key} className={cx("min-h-11 rounded-full px-4 text-sm font-medium ring-1 transition active:scale-[0.98]", preset === p.key ? "bg-slate-900 text-white ring-slate-900" : "bg-white text-slate-700 ring-slate-300 hover:bg-slate-50")}>
              {p.label}
            </button>
          ))}
          {preset === "custom" && <div className="w-full sm:w-auto"><DateRange from={custom.from} to={custom.to} onFrom={(v) => setCustom((c) => ({ ...c, from: v }))} onTo={(v) => setCustom((c) => ({ ...c, to: v }))} /></div>}
        </div>
        {trips.loading ? <Loading /> : trips.error ? <div className="p-4"><Alert>{trips.error.message}</Alert></div> : !trips.data?.data.length ? (
          <EmptyState icon="route" title="لا توجد رحلات في هذه الفترة" description="جرّب فترة أطول. لا تُنشأ رحلات إلا من مواقع أرسلها السائق فعليًا." />
        ) : (
          <DataList rows={trips.data.data} rowKey={(t) => t.id} onRowClick={(t) => setTripId(t.id === tripId ? null : t.id)} columns={[
            { header: "التاريخ", primary: true, cell: (t) => <span className={cx("font-medium", t.id === tripId && "text-brand-700")}>{formatDate(t.startedAt)}{t.id === tripId ? " — معروضة" : ""}</span> },
            { header: "البداية", cell: (t) => timeOf(t.startedAt) },
            { header: "النهاية", cell: (t) => (t.endedAt ? timeOf(t.endedAt) : "جارية") },
            { header: "المسافة", cell: (t) => `${(Number(t.distanceMeters) / 1000).toFixed(1)} كم` },
            { header: "المدة", cell: (t) => durationLabel(t.startedAt, t.endedAt) },
            { header: "أعلى سرعة", cell: (t) => (t.maxSpeed === null ? "—" : speedLabel(Math.round(msToKmh(Number(t.maxSpeed))))) },
            { header: "السائق", cell: (t) => t.driverName ?? "—", hideOnMobile: true },
          ]} />
        )}
      </Card>

      {tripId && (
        <Card>
          <CardHeader
            title="مسار الرحلة"
            subtitle={selectedTrip ? `${formatDateTime(selectedTrip.startedAt)} · ${(Number(selectedTrip.distanceMeters) / 1000).toFixed(1)} كم · ${selectedTrip.pointCount} نقطة` : undefined}
            action={<div className="flex gap-2"><Link to={`/tracking/trips/${tripId}`} className="inline-flex min-h-11 items-center px-2 text-sm font-medium text-brand-700 hover:underline">فتح الرحلة</Link><Button variant="secondary" onClick={() => setTripId(null)}>إخفاء</Button></div>}
          />
          <div className="p-4">
            {points.loading ? <Loading label="جارٍ تحميل نقاط المسار..." /> : points.error ? <Alert>{points.error.message}</Alert> : path.length === 0 ? <EmptyState icon="map" title="لا توجد نقاط مسجلة لهذه الرحلة" /> : <MapView markers={ends} path={path} height={380} />}
          </div>
        </Card>
      )}
    </div>
  );
}
