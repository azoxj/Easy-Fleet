import { lazy, Suspense, useMemo } from "react";
import { Link, useNavigate } from "react-router";
import { useFleetLatest, useNow } from "../hooks/useFleetLatest";
import { fleetCounts, STATE_META, toFleet, type StatusFilter } from "../lib/fleetMap";
import { formatNumber } from "../lib/format";
import { Icon } from "./icons";
import { Alert, Card, CardHeader, Loading, cx } from "./ui";

// Leaflet stays out of the main bundle: the preview map loads on demand.
const FleetMap = lazy(() => import("./FleetMap").then((m) => ({ default: m.FleetMap })));

const TILES: { key: StatusFilter; label: string; icon: string; count: (c: ReturnType<typeof fleetCounts>) => number; color?: string }[] = [
  { key: "", label: "إجمالي المركبات", icon: "truck", count: (c) => c.total },
  { key: "MOVING", label: "متحركة", icon: "navigation", count: (c) => c.moving, color: STATE_META.MOVING.color },
  { key: "STOPPED", label: "متوقفة", icon: "stop", count: (c) => c.stopped, color: STATE_META.STOPPED.color },
  { key: "OFFLINE", label: "غير متصلة", icon: "signal", count: (c) => c.offline, color: STATE_META.OFFLINE.color },
  { key: "ALERT", label: "تنبيهات", icon: "alert", count: (c) => c.alerts, color: STATE_META.ALERT.color },
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
        title="خريطة الأسطول"
        subtitle={c.noGps ? `${formatNumber(c.noGps)} مركبة لم ترسل موقعًا بعد` : "آخر موقع مُبلَّغ لكل مركبة"}
        action={<Link to="/map" className="inline-flex min-h-11 items-center gap-1 text-sm font-medium text-brand-700 hover:underline">فتح الخريطة <Icon name="chevron" className="size-4 rotate-180" /></Link>}
      />
      {live.error ? (
        <div className="p-4"><Alert>{live.error.message}</Alert></div>
      ) : (
        <div className="grid grid-cols-1 lg:grid-cols-[18rem_minmax(0,1fr)]">
          <ul className="grid grid-cols-2 gap-px bg-slate-100 sm:grid-cols-5 lg:grid-cols-1" aria-label="حالة المركبات">
            {TILES.map((t) => (
              <li key={t.key || "all"} className={cx(t.key === "" && "col-span-2 sm:col-span-1")}>
                <Link to={t.key ? `/map?status=${t.key}` : "/map"} className="flex h-full min-h-16 items-center gap-3 bg-white px-4 py-3 transition hover:bg-slate-50 active:bg-slate-100">
                  <span className="grid size-9 shrink-0 place-items-center rounded-lg bg-slate-100 text-slate-600" style={t.color ? { background: `${t.color}1a`, color: t.color } : undefined}>
                    <Icon name={t.icon} className="size-5" />
                  </span>
                  <span className="min-w-0">
                    <span className="block text-xs text-slate-500">{t.label}</span>
                    <span className="block text-xl font-bold text-slate-900">{live.loading ? "—" : formatNumber(t.count(c))}</span>
                  </span>
                </Link>
              </li>
            ))}
          </ul>
          <div className="relative h-64 border-t border-slate-100 lg:h-auto lg:min-h-72 lg:border-t-0 lg:border-s">
            {live.loading ? <Loading label="جارٍ تحميل الخريطة..." /> : (
              <Suspense fallback={<Loading label="جارٍ تحميل الخريطة..." />}>
                <FleetMap vehicles={fleet} selectedId={null} onSelect={(id) => id && navigate(`/map?vehicle=${id}`)} fitKey="dashboard" />
              </Suspense>
            )}
          </div>
        </div>
      )}
    </Card>
  );
}
