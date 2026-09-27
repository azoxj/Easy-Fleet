import { useMemo, useState } from "react";
import { Link } from "react-router";
import { DataList } from "../../../components/DataList";
import { MapView, type Marker } from "../../../components/MapView";
import { DateRange, todayIso } from "../../../components/shared";
import { Alert, Button, Card, CardHeader, EmptyState, Loading, cx } from "../../../components/ui";
import { useApi } from "../../../hooks/useApi";
import type { Paged } from "../../../lib/api";
import { agoLabel, durationLabel, msToKmh, speedLabel, STATE_META, toFleetVehicle, tripRange, type LatestLocation, type TripRangePreset } from "../../../lib/fleetMap";
import { formatDate, formatDateTime, formatTime } from "../../../lib/format";
import { StateBadge } from "../../../components/StateBadge";
import { t } from "../../../i18n";

type Trip = { id: string; driverName: string | null; status: string; startedAt: string; endedAt: string | null; distanceMeters: string; pointCount: number; maxSpeed: string | null };
type Point = { id: number; lat: string; lng: string; speed: string | null; recordedAt: string };

const PRESETS: { key: TripRangePreset; label: string }[] = [
  { key: "today", get label() { return t("common.today"); } },
  { key: "yesterday", get label() { return t("vehicleGps.yesterday"); } },
  { key: "7d", get label() { return t("vehicleGps.last7Days"); } },
  { key: "custom", get label() { return t("vehicleGps.customRange"); } },
];


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
  const ends: Marker[] = path.length ? [{ id: "s", lat: path[0]![0], lng: path[0]![1], label: t("vehicleGps.tripStart"), color: "#059669" }, { id: "e", lat: path[path.length - 1]![0], lng: path[path.length - 1]![1], label: t("vehicleGps.tripEnd"), color: "#dc2626" }] : [];
  const selectedTrip = trips.data?.data.find((item) => item.id === tripId) ?? null;

  return (
    <div className="space-y-6">
      <Card>
        <CardHeader title={t("common.currentLocation")} subtitle={t("vehicleGps.lastLocationSentByThe")} action={loc && <Link to={`/map?vehicle=${vehicleId}`} className="inline-flex min-h-11 items-center text-sm font-medium text-brand-700 hover:underline">{t("vehicleGps.viewOnFleetMap")}</Link>} />
        {latest.loading ? <Loading /> : latest.error ? <div className="p-4"><Alert>{latest.error.message}</Alert></div> : !loc ? (
          <EmptyState icon="pin" title={t("vehicleGps.noRecordedLocationForThis")} description={t("vehicleGps.theLocationAppearsWhenThe")} />
        ) : (
          <div className="grid grid-cols-1 gap-4 p-4 lg:grid-cols-[18rem_minmax(0,1fr)]">
            <dl className="grid grid-cols-2 gap-x-4 gap-y-3 text-sm lg:grid-cols-1">
              <div><dt className="text-xs text-slate-500">{t("common.status")}</dt><dd className="mt-1 flex flex-wrap gap-1"><StateBadge state={loc.motion} />{loc.alert && <StateBadge state="ALERT" />}</dd></div>
              <div><dt className="text-xs text-slate-500">{t("common.speed")}</dt><dd className="mt-1 font-medium">{speedLabel(loc.speedKmh)}</dd></div>
              <div><dt className="text-xs text-slate-500">{t("common.lastUpdated")}</dt><dd className="mt-1 font-medium" title={formatDateTime(loc.recordedAt)}>{agoLabel(loc.ageSeconds)}</dd></div>
              <div><dt className="text-xs text-slate-500">{t("common.driver")}</dt><dd className="mt-1 font-medium">{loc.driverName ?? "—"}</dd></div>
              <div className="col-span-2 lg:col-span-1"><dt className="text-xs text-slate-500">{t("common.coordinates")}</dt><dd className="mt-1 font-medium ltr text-start">{loc.lat.toFixed(5)}, {loc.lng.toFixed(5)}</dd></div>
            </dl>
            <MapView markers={locMarker} height={240} />
          </div>
        )}
      </Card>

      <Card>
        <CardHeader title={t("vehicleGps.tripHistory")} subtitle={range.from === range.to ? formatDate(range.from) : `${formatDate(range.from)} — ${formatDate(range.to)}`} />
        <div className="flex flex-wrap items-center gap-2 border-b border-slate-100 p-4" role="group" aria-label={t("vehicleGps.period")}>
          {PRESETS.map((p) => (
            <button key={p.key} onClick={() => { setPreset(p.key); setTripId(null); }} aria-pressed={preset === p.key} className={cx("min-h-11 rounded-full px-4 text-sm font-medium ring-1 transition active:scale-[0.98]", preset === p.key ? "bg-slate-900 text-white ring-slate-900" : "bg-white text-slate-700 ring-slate-300 hover:bg-slate-50")}>
              {p.label}
            </button>
          ))}
          {preset === "custom" && <div className="w-full sm:w-auto"><DateRange from={custom.from} to={custom.to} onFrom={(v) => setCustom((c) => ({ ...c, from: v }))} onTo={(v) => setCustom((c) => ({ ...c, to: v }))} /></div>}
        </div>
        {trips.loading ? <Loading /> : trips.error ? <div className="p-4"><Alert>{trips.error.message}</Alert></div> : !trips.data?.data.length ? (
          <EmptyState icon="route" title={t("vehicleGps.noTripsInThisPeriod")} description={t("vehicleGps.tryALongerPeriodTrips")} />
        ) : (
          <DataList rows={trips.data.data} rowKey={(item) => item.id} onRowClick={(item) => setTripId(item.id === tripId ? null : item.id)} columns={[
            { header: t("common.date"), primary: true, cell: (item) => <span className={cx("font-medium", item.id === tripId && "text-brand-700")}>{formatDate(item.startedAt)}{item.id === tripId ? t("vehicleGps.shown") : ""}</span> },
            { header: t("common.start"), cell: (item) => formatTime(item.startedAt) },
            { header: t("vehicleGps.end"), cell: (item) => (item.endedAt ? formatTime(item.endedAt) : t("common.inProgress")) },
            { header: t("common.distance"), cell: (item) => t("common.km2", { value: (Number(item.distanceMeters) / 1000).toFixed(1) }) },
            { header: t("vehicleGps.duration"), cell: (item) => durationLabel(item.startedAt, item.endedAt) },
            { header: t("vehicleGps.topSpeed"), cell: (item) => (item.maxSpeed === null ? "—" : speedLabel(Math.round(msToKmh(Number(item.maxSpeed))))) },
            { header: t("common.driver"), cell: (item) => item.driverName ?? "—", hideOnMobile: true },
          ]} />
        )}
      </Card>

      {tripId && (
        <Card>
          <CardHeader
            title={t("common.tripRoute")}
            subtitle={selectedTrip ? t("vehicleGps.kmPoints", { startedAt: formatDateTime(selectedTrip.startedAt), value: (Number(selectedTrip.distanceMeters) / 1000).toFixed(1), pointCount: selectedTrip.pointCount }) : undefined}
            action={<div className="flex gap-2"><Link to={`/tracking/trips/${tripId}`} className="inline-flex min-h-11 items-center px-2 text-sm font-medium text-brand-700 hover:underline">{t("vehicleGps.openTrip")}</Link><Button variant="secondary" onClick={() => setTripId(null)}>{t("vehicleGps.hide")}</Button></div>}
          />
          <div className="p-4">
            {points.loading ? <Loading label={t("vehicleGps.loadingRoutePoints")} /> : points.error ? <Alert>{points.error.message}</Alert> : path.length === 0 ? <EmptyState icon="map" title={t("common.noPointsRecordedForThis")} /> : <MapView markers={ends} path={path} height={380} />}
          </div>
        </Card>
      )}
    </div>
  );
}
