import { useEffect, useState } from "react";
import { useSearchParams } from "react-router";
import { FileAttachment } from "../../components/common";
import { DataList } from "../../components/DataList";
import { useToast } from "../../components/feedback";
import { LineChart } from "../../components/charts";
import { DateRange, FilterBar, localToIso, Money, nowLocalInput, ProjectSelect, useProjects, useVehicles, VehicleSelect } from "../../components/shared";
import { Alert, Button, Card, CardHeader, EmptyState, Field, Input, Loading, Modal, PageHeader, Pagination, StatCard, Textarea } from "../../components/ui";
import { useApi } from "../../hooks/useApi";
import { api, type Paged } from "../../lib/api";
import { useAuth } from "../../lib/auth";
import { formatDateTime, formatNumber } from "../../lib/format";
import { errorMessage, fieldErrors } from "../../lib/forms";
import type { FuelRow, Vehicle } from "../../lib/types";
import { t } from "../../i18n";

type Stats = {
  totals: { count: number; liters: string; cost: string; avgPrice: string | null };
  monthly: { month: string; liters: string; cost: string }[];
  perVehicle: { vehicleId: string; plateNumber: string; fills: number; liters: string; cost: string; distanceKm: number; kmPerLiter: string | null }[];
};

export function FuelModal({ open, onClose, onSaved, vehicleId }: { open: boolean; onClose: () => void; onSaved: () => void; vehicleId?: string }) {
  const toast = useToast();
  const vehicles = useVehicles();
  const empty = { vehicleId: vehicleId ?? "", fueledAt: nowLocalInput(), liters: "", pricePerLiter: "", odometer: "", station: "", notes: "" };
  const [v, setV] = useState(empty);
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  // eslint-disable-next-line react-hooks/exhaustive-deps
  useEffect(() => { if (open) { setV(empty); setErrors({}); setError(null); } }, [open]);
  const set = (k: keyof typeof v) => (e: { target: { value: string } }) => setV((s) => ({ ...s, [k]: e.target.value }));
  const total = v.liters && v.pricePerLiter ? (Number(v.liters) * Number(v.pricePerLiter)).toFixed(2) : "—";
  const save = async () => {
    const e: Record<string, string> = {};
    if (!v.vehicleId) e.vehicleId = t("common.selectAVehicle2");
    if (!(Number(v.liters) > 0)) e.liters = t("fuel.enterTheNumberOfLiters");
    if (!(Number(v.pricePerLiter) >= 0) || v.pricePerLiter === "") e.pricePerLiter = t("fuel.enterThePricePerLiter");
    setErrors(e);
    if (Object.keys(e).length) return;
    setBusy(true);
    try {
      await api("/fuel", { method: "POST", body: { vehicleId: v.vehicleId, fueledAt: localToIso(v.fueledAt), liters: Number(v.liters), pricePerLiter: Number(v.pricePerLiter), ...(v.odometer ? { odometer: Number(v.odometer) } : {}), ...(v.station.trim() ? { station: v.station.trim() } : {}), ...(v.notes.trim() ? { notes: v.notes.trim() } : {}) } });
      toast.success(t("fuel.fillUpRecorded"));
      onSaved();
      onClose();
    } catch (err) {
      setErrors(fieldErrors(err));
      setError(errorMessage(err));
    } finally {
      setBusy(false);
    }
  };
  return (
    <Modal open={open} onClose={onClose} title={t("fuel.recordFuelFillUp")} footer={<><Button variant="secondary" onClick={onClose}>{t("common.cancel")}</Button><Button loading={busy} onClick={save}>{t("common.save")}</Button></>}>
      <div className="space-y-4">
        {error && <Alert>{error}</Alert>}
        {!vehicleId && <Field label={t("common.vehicle")} required error={errors.vehicleId} htmlFor="f-vehicle"><VehicleSelect id="f-vehicle" value={v.vehicleId} onChange={(x) => setV((s) => ({ ...s, vehicleId: x }))} vehicles={vehicles.filter((x) => x.status !== "ARCHIVED" && x.status !== "SOLD")} all={t("common.selectAVehicle3")} /></Field>}
        <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
          <Field label={t("fuel.fillUpTime")} required htmlFor="f-at"><Input id="f-at" type="datetime-local" value={v.fueledAt} onChange={set("fueledAt")} /></Field>
          <Field label={t("common.odometerReading")} error={errors.odometer} htmlFor="f-odo" hint={t("fuel.mustNotBeLowerThan")}><Input id="f-odo" dir="ltr" inputMode="numeric" value={v.odometer} onChange={set("odometer")} /></Field>
          <Field label={t("fuel.liters")} required error={errors.liters} htmlFor="f-l"><Input id="f-l" dir="ltr" inputMode="decimal" value={v.liters} onChange={set("liters")} /></Field>
          <Field label={t("fuel.pricePerLiter")} required error={errors.pricePerLiter} htmlFor="f-p" hint={t("fuel.approximateTotalSarCalculatedOn", { total })}><Input id="f-p" dir="ltr" inputMode="decimal" value={v.pricePerLiter} onChange={set("pricePerLiter")} /></Field>
        </div>
        <Field label={t("fuel.station")} htmlFor="f-st"><Input id="f-st" value={v.station} onChange={set("station")} /></Field>
        <Field label={t("common.notes")} htmlFor="f-n"><Textarea id="f-n" value={v.notes} onChange={set("notes")} /></Field>
      </div>
    </Modal>
  );
}

export function FuelList({ vehicleId, embedded }: { vehicleId?: string; embedded?: boolean }) {
  const { can, me } = useAuth();
  const projects = useProjects();
  const vehicles = useVehicles();
  const [params] = useSearchParams();
  const fromUrl = (k: string) => (embedded ? "" : (params.get(k) ?? ""));
  const [f, setF] = useState({ projectId: "", vehicleId: vehicleId ?? "", from: fromUrl("from"), to: fromUrl("to") });
  const [page, setPage] = useState(1);
  const [adding, setAdding] = useState(false);
  const [open, setOpen] = useState<FuelRow | null>(null);
  const list = useApi<Paged<FuelRow>>("/fuel", { ...f, page, pageSize: 20 });
  const stats = useApi<{ data: Stats }>("/fuel/stats", f);
  const upd = (k: keyof typeof f, v: string) => { setF((s) => ({ ...s, [k]: v })); setPage(1); };
  const reload = () => { list.reload(); stats.reload(); };
  const s = stats.data?.data;
  const active = Object.values(f).filter(Boolean).length - (vehicleId ? 1 : 0);
  return (
    <div className="space-y-6">
      {s && (
        <div className="grid grid-cols-2 gap-4 lg:grid-cols-4">
          <StatCard label={t("fuel.fillUps")} value={formatNumber(s.totals.count)} icon="fuel" />
          <StatCard label={t("fuel.liters")} value={formatNumber(s.totals.liters)} icon="gauge" tone="green" />
          <StatCard label={t("common.cost")} value={<Money value={s.totals.cost} />} icon="receipt" tone="amber" />
          <StatCard label={t("fuel.averagePricePerLiter")} value={s.totals.avgPrice ? `${s.totals.avgPrice}` : "—"} icon="chart" tone="violet" />
        </div>
      )}
      {s && !embedded && (
        <div className="grid grid-cols-1 gap-6 lg:grid-cols-2">
          <Card><CardHeader title={t("fuel.monthlyFuelCost")} /><div className="p-5"><LineChart points={s.monthly.map((m) => ({ label: m.month, value: Number(m.cost) }))} /></div></Card>
          <Card>
            <CardHeader title={t("fuel.vehicleConsumptionKmL")} subtitle={t("fuel.fromTheOdometerDifferenceBetween")} />
            <div className="max-h-72 overflow-y-auto p-3">
              {s.perVehicle.length === 0 ? <p className="p-4 text-sm text-slate-400">{t("fuel.noFillUpsWithAn")}</p> : (
                <table className="w-full text-sm"><thead><tr className="text-xs text-slate-500"><th className="p-2 text-start">{t("common.vehicle")}</th><th className="p-2 text-start">{t("common.distance")}</th><th className="p-2 text-start">{t("fuel.liters")}</th><th className="p-2 text-start">{t("fuel.kmL")}</th></tr></thead>
                  <tbody>{s.perVehicle.map((r) => <tr key={r.vehicleId} className="border-t border-slate-100"><td className="p-2 ltr">{r.plateNumber}</td><td className="p-2">{t("fuel.km", { distanceKm: formatNumber(r.distanceKm) })}</td><td className="p-2">{formatNumber(r.liters)}</td><td className="p-2 font-medium">{r.kmPerLiter ?? "—"}</td></tr>)}</tbody></table>
              )}
            </div>
          </Card>
        </div>
      )}
      <Card>
        <div className="flex items-center justify-between gap-2 border-b border-slate-100 px-4 py-3">
          <p className="text-sm text-slate-500">{t("fuel.fillUps2")}</p>
          {can("fuel.create") && <Button icon="plus" onClick={() => setAdding(true)}>{t("fuel.recordFillUp")}</Button>}
        </div>
        {!embedded && (
          <FilterBar active={active} onClear={() => { setF({ projectId: "", vehicleId: vehicleId ?? "", from: "", to: "" }); setPage(1); }}>
            {projects.length > 0 && <ProjectSelect value={f.projectId} onChange={(v) => upd("projectId", v)} projects={projects} />}
            {!vehicleId && <VehicleSelect value={f.vehicleId} onChange={(v) => upd("vehicleId", v)} vehicles={vehicles as Vehicle[]} />}
            <DateRange from={f.from} to={f.to} onFrom={(v) => upd("from", v)} onTo={(v) => upd("to", v)} />
          </FilterBar>
        )}
        {list.loading ? <Loading /> : list.error ? <div className="p-4"><Alert>{list.error.message}</Alert></div> : !list.data?.data.length ? <EmptyState icon="fuel" title={t("common.noFillUps")} /> : (
          <>
            <DataList rows={list.data.data} rowKey={(r) => r.id} onRowClick={setOpen} columns={[
              { header: t("common.vehicle"), primary: true, cell: (r) => <span className="ltr">{r.plateNumber}</span> },
              { header: t("common.time"), cell: (r) => formatDateTime(r.fueledAt) },
              { header: t("fuel.liters"), cell: (r) => formatNumber(r.liters) },
              { header: t("common.total"), cell: (r) => <Money value={r.total} /> },
              { header: t("common.odometer"), cell: (r) => (r.odometer !== null ? formatNumber(r.odometer) : "—"), hideOnMobile: true },
              { header: t("common.driver"), cell: (r) => r.driverName ?? "—", hideOnMobile: true },
              { header: t("fuel.station"), cell: (r) => r.station ?? "—", hideOnMobile: true },
            ]} />
            <Pagination {...list.data.meta} onPage={setPage} />
          </>
        )}
      </Card>
      <FuelModal open={adding} onClose={() => setAdding(false)} onSaved={reload} vehicleId={vehicleId} />
      <Modal open={!!open} onClose={() => setOpen(null)} title={t("fuel.fillUpDetails")}>
        {open && (
          <div className="space-y-2 text-sm">
            <p><span className="ltr">{open.plateNumber}</span> — {formatDateTime(open.fueledAt)}</p>
            <p>{formatNumber(open.liters)} {t("fuel.l")} {open.pricePerLiter} = <b><Money value={open.total} /></b></p>
            <p>{t("fuel.odometerDriverStation", { value: open.odometer ?? "—", value2: open.driverName ?? "—", value3: open.station ?? "—" })}</p>
            {open.notes && <p>{t("fuel.notes", { notes: open.notes })}</p>}
            <p className="text-xs text-slate-500">{t("fuel.recordedBy", { createdByName: open.createdByName })}</p>
            <FileAttachment fileName={open.hasReceipt ? t("fuel.fillUpReceipt") : null} downloadPath={`/fuel/${open.id}/receipt`} uploadPath={`/fuel/${open.id}/receipt`} canUpload={open.createdBy === me?.id} onUploaded={() => { list.reload(); setOpen(null); }} />
          </div>
        )}
      </Modal>
    </div>
  );
}

export function FuelPage() {
  return (
    <>
      <PageHeader title={t("common.fuel")} subtitle={t("fuel.fillUpsConsumptionAndCosts")} />
      <FuelList />
    </>
  );
}
