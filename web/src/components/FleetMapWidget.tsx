import { lazy, Suspense, useMemo } from "react";
import { Link, useNavigate } from "react-router";
import { useFleetLatest, useNow } from "../hooks/useFleetLatest";
import { fleetCounts, STATE_META, toFleet, type StatusFilter } from "../lib/fleetMap";
import { formatNumber } from "../lib/format";
import { Icon } from "./icons";
import { Alert, Card, CardHeader, Loading, cx } from "./ui";
import { t } from "../i18n";

// Leaflet stays out of the main bundle: the preview map loads on demand.
const FleetMap = lazy(() => import("./FleetMap").then((m) => ({ default: m.FleetMap })));

const TILES: { key: StatusFilter; label: string; icon: string; count: (c: ReturnType<typeof fleetCounts>) => number; color?: string }[] = [
  { key: "", get label() { return t("common.totalVehicles"); }, icon: "truck", count: (c) => c.total },
  { key: "MOVING", get label() { return t("common.moving"); }, icon: "navigation", count: (c) => c.moving, color: STATE_META.MOVING.color },
  { key: "STOPPED", get label() { return t("common.stopped"); }, icon: "stop", count: (c) => c.stopped, color: STATE_META.STOPPED.color },
  { key: "OFFLINE", get label() { return t("common.offline"); }, icon: "signal", count: (c) => c.offline, color: STATE_META.OFFLINE.color },
  { key: "ALERT", get label() { return t("common.alerts"); }, icon: "alert", count: (c) => c.alerts, color: STATE_META.ALERT.color },
];

/** Dashboard fleet widget (users with gps.read). Each figure opens the map filtered on that state. */
export function FleetMapWidget() {
  const navigate = useNavigate();
  const live = useFleetLatest(true, 30_000);
  const now = useNow(10_000);
  const fleet = useMemo(() => toFleet(live.rows, now + live.skewMs, live.meta?.staleMinutes), [live.rows, now, live.skewMs, live.meta?.staleMinutes]);
  const c = fleetCounts(fleet, live.meta?.total);
  return (
    <Card className="mt-6 overflow-hidden">
      <CardHeader
        title={t("common.fleetMap")}
        subtitle={c.noGps ? t("fleetMapWidget.vehiclesHaveNotReportedA", { noGps: formatNumber(c.noGps) }) : t("fleetMapWidget.lastReportedLocationOfEach")}
        action={<Link to="/map" className="inline-flex min-h-11 items-center gap-1 text-sm font-medium text-brand-700 hover:underline">{t("fleetMapWidget.openMap")} <Icon name="chevron" className="size-4 rotate-180" /></Link>}
      />
      {live.error ? (
        <div className="p-4"><Alert>{live.error.message}</Alert></div>
      ) : (
        <div className="grid grid-cols-1 lg:grid-cols-[18rem_minmax(0,1fr)]">
          <ul className="grid grid-cols-2 gap-px bg-slate-100 sm:grid-cols-5 lg:grid-cols-1" aria-label={t("fleetMapWidget.vehicleStatus")}>
            {TILES.map((item) => (
              <li key={item.key || "all"} className={cx(item.key === "" && "col-span-2 sm:col-span-1")}>
                <Link to={item.key ? `/map?status=${item.key}` : "/map"} className="flex h-full min-h-16 items-center gap-3 bg-white px-4 py-3 transition hover:bg-slate-50 active:bg-slate-100">
                  <span className="grid size-9 shrink-0 place-items-center rounded-lg bg-slate-100 text-slate-600" style={item.color ? { background: `${item.color}1a`, color: item.color } : undefined}>
                    <Icon name={item.icon} className="size-5" />
                  </span>
                  <span className="min-w-0">
                    <span className="block text-xs text-slate-500">{item.label}</span>
                    <span className="block text-xl font-bold text-slate-900">{live.loading ? "—" : formatNumber(item.count(c))}</span>
                  </span>
                </Link>
              </li>
            ))}
          </ul>
          <div className="relative h-64 border-t border-slate-100 lg:h-auto lg:min-h-72 lg:border-t-0 lg:border-s">
            {live.loading ? <Loading label={t("common.loadingMap")} /> : (
              <Suspense fallback={<Loading label={t("common.loadingMap")} />}>
                <FleetMap vehicles={fleet} selectedId={null} onSelect={(id) => id && navigate(`/map?vehicle=${id}`)} fitKey="dashboard" />
              </Suspense>
            )}
          </div>
        </div>
      )}
    </Card>
  );
}
