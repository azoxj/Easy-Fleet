import { useMemo, useRef, useState } from "react";
import { Link, useNavigate, useSearchParams } from "react-router";
import { DataList } from "../../components/DataList";
import { FleetMap, type FleetMapHandle } from "../../components/FleetMap";
import { Icon } from "../../components/icons";
import { StateBadge } from "../../components/StateBadge";
import { ProjectSelect, useProjects } from "../../components/shared";
import { Alert, Badge, Button, Card, CardHeader, EmptyState, Loading, PageHeader, Pagination, cx } from "../../components/ui";
import { useApi } from "../../hooks/useApi";
import { useFleetLatest, useNow } from "../../hooks/useFleetLatest";
import type { Paged } from "../../lib/api";
import { useAuth } from "../../lib/auth";
import { agoLabel, filterFleet, fleetCounts, keepSelection, parseStatusParam, speedLabel, STATE_META, toFleet, type FleetVehicle, type StatusFilter } from "../../lib/fleetMap";
import { formatDateTime } from "../../lib/format";

type Trip = { id: string; vehicleId: string; plateNumber: string; driverName: string | null; status: string; startedAt: string; endedAt: string | null; distanceMeters: string };

function VehiclePanel({ v, nowMs, onClose }: { v: FleetVehicle; nowMs: number; onClose: () => void }) {
  const age = Math.max(0, (nowMs - Date.parse(v.recordedAt)) / 1000);
  const rows: [string, React.ReactNode][] = [
    ["المركبة", <span className="ltr font-semibold">{v.plate}</span>],
    ["رقم المركبة", v.vehicleNumber ? <span className="ltr">{v.vehicleNumber}</span> : "—"],
    ["الطراز", v.makeModel || "—"],
    ["السائق", v.driverName ?? "—"],
    ["المشروع", v.projectName ?? "—"],
    ["السرعة", speedLabel(v.speedKmh)],
    ["آخر تحديث", <span title={formatDateTime(v.recordedAt)}>{agoLabel(age)}</span>],
    ["الحالة", v.motion === "MOVING" ? "متحركة" : v.motion === "STOPPED" ? "متوقفة" : "غير متصلة"],
  ];
  return (
    <div className="flex h-full flex-col">
      <div className="flex items-start justify-between gap-3 border-b border-slate-100 px-4 py-3">
        <div className="min-w-0">
          <p className="truncate text-base font-bold text-slate-900 ltr">{v.plate}</p>
          <div className="mt-1 flex flex-wrap items-center gap-1.5">
            <StateBadge state={v.motion} />
            {v.alert && <Badge tone="red"><Icon name="alert" className="me-1 size-3" />{v.alert}</Badge>}
            {v.tripActive && <Badge tone="blue">في رحلة</Badge>}
          </div>
        </div>
        <button onClick={onClose} className="grid size-11 shrink-0 place-items-center rounded-lg text-slate-500 hover:bg-slate-100 active:bg-slate-200" aria-label="إغلاق لوحة المركبة">
          <Icon name="x" />
        </button>
      </div>
      <dl className="grid grid-cols-2 gap-x-4 gap-y-3 overflow-y-auto px-4 py-3 text-sm">
        {rows.map(([k, val]) => (
          <div key={k} className="min-w-0">
            <dt className="text-xs text-slate-500">{k}</dt>
            <dd className="mt-0.5 break-words font-medium text-slate-800">{val}</dd>
          </div>
        ))}
      </dl>
      <div className="mt-auto flex flex-wrap gap-2 border-t border-slate-100 px-4 py-3">
        <Link to={`/vehicles/${v.id}`} className="inline-flex min-h-11 flex-1 items-center justify-center gap-2 rounded-lg bg-brand-700 px-3 text-sm font-medium text-white hover:bg-brand-800 active:bg-brand-900">
          <Icon name="truck" className="size-4" /> ملف المركبة
        </Link>
        <Link to={`/vehicles/${v.id}?tab=gps`} className="inline-flex min-h-11 flex-1 items-center justify-center gap-2 rounded-lg bg-white px-3 text-sm font-medium text-slate-700 ring-1 ring-slate-300 hover:bg-slate-50 active:bg-slate-100">
          <Icon name="route" className="size-4" /> الرحلات
        </Link>
      </div>
    </div>
  );
}

function MapButton({ icon, label, onClick, disabled, spin }: { icon: string; label: string; onClick: () => void; disabled?: boolean; spin?: boolean }) {
  return (
    <button onClick={onClick} disabled={disabled} title={label} aria-label={label} className="grid size-11 place-items-center rounded-lg bg-white text-slate-700 shadow-md ring-1 ring-slate-200 transition hover:bg-slate-50 active:bg-slate-100 disabled:opacity-40">
      <Icon name={icon} className={cx("size-5", spin && "animate-spin")} />
    </button>
  );
}

const CHIPS: { key: StatusFilter; label: string }[] = [
  { key: "", label: "الكل" },
  { key: "MOVING", label: "متحركة" },
  { key: "STOPPED", label: "متوقفة" },
  { key: "OFFLINE", label: "غير متصلة" },
  { key: "ALERT", label: "تنبيهات" },
];

export function FleetMapPage() {
  const navigate = useNavigate();
  const { can } = useAuth();
  const projects = useProjects();
  const [params, setParams] = useSearchParams();
  const projectId = params.get("project") ?? "";
  const status = parseStatusParam(params.get("status"));
  const [q, setQ] = useState("");
  const [selected, setSelected] = useState<string | null>(params.get("vehicle"));
  const mapRef = useRef<FleetMapHandle>(null);
  const live = useFleetLatest();
  const now = useNow(1000);
  const serverNow = now + live.skewMs;
  // Motion states are re-evaluated every 10 s (a vehicle can go offline without a new report).
  const bucket = Math.floor(serverNow / 10_000) * 10_000;
  const fleet = useMemo(() => toFleet(live.rows, bucket, live.meta?.staleMinutes), [live.rows, bucket, live.meta?.staleMinutes]);
  const scoped = useMemo(() => filterFleet(fleet, { projectId }), [fleet, projectId]);
  const visible = useMemo(() => filterFleet(scoped, { status, q }), [scoped, status, q]);
  const counts = fleetCounts(scoped, projectId ? undefined : live.meta?.total);
  const selectedId = keepSelection(selected, visible);
  const current = visible.find((v) => v.id === selectedId) ?? null;
  const [page, setPage] = useState(1);
  const trips = useApi<Paged<Trip>>("/tracking/trips", { page, pageSize: 8 });

  const setParam = (k: string, v: string) => {
    const next = new URLSearchParams(params);
    if (v) next.set(k, v);
    else next.delete(k);
    setParams(next, { replace: true });
  };
  const select = (id: string | null) => {
    setSelected(id);
    setParam("vehicle", id ?? "");
  };
  const countOf: Record<string, number> = { "": counts.located, MOVING: counts.moving, STOPPED: counts.stopped, OFFLINE: counts.offline, ALERT: counts.alerts };
  const sinceRefresh = live.fetchedAt ? (now - live.fetchedAt) / 1000 : null;

  return (
    <>
      <PageHeader
        title="خريطة الأسطول"
        subtitle={<span aria-live="polite">آخر موقع مُبلَّغ لكل مركبة — {sinceRefresh === null ? "جارٍ التحميل..." : `آخر تحديث قبل ${Math.round(sinceRefresh)} ثانية`}</span>}
        actions={<Button variant="secondary" icon="refresh" loading={live.refreshing && !live.loading} onClick={() => void live.refresh()}>تحديث الآن</Button>}
      />

      {/* Filters: compact on phones (search + project on one row, status chips scroll inside their own row). */}
      <div className="mb-3 grid grid-cols-1 gap-2 sm:grid-cols-[1fr_14rem]">
        <label className="relative block">
          <span className="sr-only">بحث بالمركبة أو السائق</span>
          <Icon name="search" className="pointer-events-none absolute start-3 top-1/2 size-4 -translate-y-1/2 text-slate-400" />
          <input type="search" value={q} onChange={(e) => setQ(e.target.value)} placeholder="ابحث بلوحة المركبة أو اسم السائق..." className="block min-h-11 w-full rounded-lg border-0 bg-white py-2 ps-9 pe-3 text-sm ring-1 ring-inset ring-slate-300 placeholder:text-slate-400 focus:ring-2 focus:ring-brand-600" />
        </label>
        {projects.length > 0 && <ProjectSelect value={projectId} onChange={(v) => setParam("project", v)} projects={projects} id="map-project" />}
      </div>
      <div className="-mx-4 mb-3 overflow-x-auto px-4 sm:mx-0 sm:px-0">
        <div className="flex min-w-max gap-2" role="group" aria-label="تصفية حسب الحالة">
          {CHIPS.map((c) => {
            const active = status === c.key;
            const color = c.key ? STATE_META[c.key].color : "#1d4ed8";
            return (
              <button key={c.key || "all"} onClick={() => setParam("status", c.key)} aria-pressed={active} className={cx("inline-flex min-h-11 items-center gap-2 rounded-full px-4 text-sm font-medium ring-1 transition active:scale-[0.98]", active ? "bg-slate-900 text-white ring-slate-900" : "bg-white text-slate-700 ring-slate-300 hover:bg-slate-50")}>
                {c.key && <span className="size-2.5 rounded-full" style={{ background: color }} aria-hidden="true" />}
                {c.label}
                <span className={cx("rounded-full px-1.5 text-xs", active ? "bg-white/20" : "bg-slate-100 text-slate-600")}>{countOf[c.key] ?? 0}</span>
              </button>
            );
          })}
        </div>
      </div>

      {live.error && <div className="mb-3"><Alert>{live.error.message} — ستتم إعادة المحاولة تلقائيًا.</Alert></div>}

      <div className="grid grid-cols-1 gap-4 lg:grid-cols-[minmax(0,1fr)_22rem]">
        <div className="relative h-[58vh] min-h-[340px] overflow-hidden rounded-xl ring-1 ring-slate-200 lg:h-[calc(100vh-17rem)] lg:min-h-[480px]">
          {live.loading ? <Loading label="جارٍ تحميل مواقع المركبات..." /> : <FleetMap ref={mapRef} vehicles={visible} selectedId={selectedId} onSelect={select} fitKey={`${projectId}|${status}`} />}
          <div className="absolute top-3 start-3 z-[500] flex flex-col gap-2">
            <MapButton icon="plus" label="تكبير" onClick={() => mapRef.current?.zoomIn()} />
            <MapButton icon="minus" label="تصغير" onClick={() => mapRef.current?.zoomOut()} />
            <MapButton icon="expand" label="عرض كل المركبات" onClick={() => mapRef.current?.fitAll()} disabled={!visible.length} />
            <MapButton icon="crosshair" label="التركيز على المركبة المحددة" onClick={() => selectedId && mapRef.current?.focus(selectedId)} disabled={!selectedId} />
            <MapButton icon="refresh" label="تحديث الآن" onClick={() => void live.refresh()} spin={live.refreshing} />
          </div>
          {!live.loading && visible.length === 0 && (
            <div className="pointer-events-none absolute inset-x-3 bottom-3 z-[500] rounded-lg bg-white/95 p-3 text-center text-sm text-slate-600 shadow ring-1 ring-slate-200">
              {fleet.length === 0 ? "لا توجد مواقع مُبلَّغة بعد — تظهر المركبات عندما يرسل السائقون مواقعهم أثناء الرحلات." : "لا توجد مركبات مطابقة للتصفية الحالية."}
            </div>
          )}
        </div>

        {/* Desktop side panel: selected vehicle, otherwise the list. */}
        <Card className="hidden min-h-0 overflow-hidden lg:flex lg:h-[calc(100vh-17rem)] lg:min-h-[480px] lg:flex-col">
          {current ? (
            <VehiclePanel v={current} nowMs={serverNow} onClose={() => select(null)} />
          ) : (
            <>
              <CardHeader title="المركبات" subtitle={`${visible.length} من ${counts.total} مركبة${counts.noGps ? ` · ${counts.noGps} بلا موقع` : ""}`} />
              <VehicleList vehicles={visible} nowMs={serverNow} onSelect={select} />
            </>
          )}
        </Card>
      </div>

      {/* Phone / tablet: list under the map, selected vehicle as a bottom sheet. */}
      <Card className="mt-4 lg:hidden">
        <CardHeader title="المركبات" subtitle={`${visible.length} من ${counts.total} مركبة${counts.noGps ? ` · ${counts.noGps} بلا موقع` : ""}`} />
        <VehicleList vehicles={visible} nowMs={serverNow} onSelect={select} />
      </Card>
      {current && (
        <div className="fixed inset-x-0 bottom-0 z-[1000] max-h-[70vh] overflow-hidden rounded-t-2xl bg-white shadow-[0_-8px_30px_rgba(15,23,42,0.18)] ring-1 ring-slate-200 lg:hidden" role="dialog" aria-label={`المركبة ${current.plate}`}>
          <div className="mx-auto mt-2 h-1.5 w-10 rounded-full bg-slate-300" aria-hidden="true" />
          <div className="max-h-[calc(70vh-14px)] overflow-y-auto pb-[env(safe-area-inset-bottom)]">
            <VehiclePanel v={current} nowMs={serverNow} onClose={() => select(null)} />
          </div>
        </div>
      )}

      <div className="mt-4"><Alert tone="blue">
        <span className="font-medium">عن دقة التتبع:</span> تعرض الخريطة آخر موقع أرسله جهاز السائق فعليًا، وتتحدث كل 15 ثانية. التتبع من المتصفح يعمل فقط ما دامت صفحة «تتبع الرحلة» مفتوحة على هاتف السائق ولا يعمل في الخلفية (خاصة على iPhone). للتتبع المستمر في الخلفية يلزم تطبيق سائق أصلي بصلاحية الموقع في الخلفية أو جهاز تتبع GPS مثبت في المركبة.
      </Alert></div>

      <Card className="mt-6">
        <CardHeader title="الرحلات الأخيرة" action={can("gps.track") ? <Link className="text-sm font-medium text-brand-700 hover:underline" to="/tracking">تتبع رحلتي</Link> : undefined} />
        {trips.loading ? <Loading /> : trips.error ? <div className="p-4"><Alert>{trips.error.message}</Alert></div> : !trips.data?.data.length ? <EmptyState icon="navigation" title="لا توجد رحلات" description="تظهر الرحلات هنا عند بدء السائقين للرحلات من صفحة «تتبع الرحلة»." /> : (
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
    </>
  );
}

function VehicleList({ vehicles, nowMs, onSelect }: { vehicles: FleetVehicle[]; nowMs: number; onSelect: (id: string) => void }) {
  if (!vehicles.length) return <EmptyState icon="map" title="لا توجد مركبات" description="غيّر التصفية أو انتظر وصول مواقع جديدة." />;
  return (
    <ul className="min-h-0 flex-1 divide-y divide-slate-100 overflow-y-auto lg:max-h-none max-h-96">
      {vehicles.map((v) => (
        <li key={v.id}>
          <button onClick={() => onSelect(v.id)} className="flex min-h-14 w-full items-center gap-3 px-4 py-2.5 text-start transition hover:bg-slate-50 active:bg-slate-100">
            <span className="grid size-9 shrink-0 place-items-center rounded-full text-white" style={{ background: STATE_META[v.state].color }} aria-hidden="true">
              <Icon name="truck" className="size-4" />
            </span>
            <span className="min-w-0 flex-1">
              <span className="block truncate text-sm font-semibold text-slate-900 ltr text-start">{v.plate}</span>
              <span className="block truncate text-xs text-slate-500">{v.driverName ?? "بدون سائق"} · {v.projectName ?? "بدون مشروع"}</span>
            </span>
            <span className="shrink-0 text-end">
              <StateBadge state={v.state} />
              <span className="mt-1 block text-[11px] text-slate-400">{agoLabel((nowMs - Date.parse(v.recordedAt)) / 1000)}</span>
            </span>
          </button>
        </li>
      ))}
    </ul>
  );
}
