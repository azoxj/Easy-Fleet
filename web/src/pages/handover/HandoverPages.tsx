import { useEffect, useState } from "react";
import { Link, useNavigate, useParams } from "react-router";
import { DataList } from "../../components/DataList";
import { useConfirm, useToast } from "../../components/feedback";

import { BackLink, FilterBar, ReasonModal, RecordTimeline, useAction, useVehicles, VehicleSelect, type AuditRow } from "../../components/shared";
import { Alert, Badge, Button, Card, CardHeader, DescList, EmptyState, Field, Input, Loading, Modal, PageHeader, Pagination, Select, StatusBadge, Textarea, cx } from "../../components/ui";
import { useApi } from "../../hooks/useApi";
import { api, fileUrl, type Paged } from "../../lib/api";
import { useAuth } from "../../lib/auth";
import { formatDateTime, formatNumber } from "../../lib/format";
import { errorMessage } from "../../lib/forms";
import { HANDOVER_STATUS, PHOTO_CATEGORY } from "../../lib/labels";
import type { DriverRow, HandoverRow } from "../../lib/types";
import { HandoverCapture, type Progress } from "./HandoverCapture";
import { t } from "../../i18n";

/** Shows a freshly created/rotated link once, with copy + share. */
export function LinkModal({ link, onClose }: { link: string | null; onClose: () => void }) {
  const toast = useToast();
  const copy = async () => {
    try {
      await navigator.clipboard.writeText(link!);
      toast.success(t("handover.linkCopied"));
    } catch {
      toast.error(t("handover.couldNotCopyCopyThe"));
    }
  };
  const share = () => navigator.share?.({ title: t("handover.vehicleHandoverLink"), url: link! }).catch(() => undefined);
  return (
    <Modal open={!!link} onClose={onClose} title={t("handover.driverHandoverLink")} footer={<Button onClick={onClose}>{t("common.done")}</Button>}>
      <div className="space-y-4">
        <Alert tone="amber">{t("handover.thisLinkIsShownOnly")}</Alert>
        <Input readOnly value={link ?? ""} dir="ltr" onFocus={(e) => e.target.select()} aria-label={t("handover.link")} />
        <div className="flex flex-wrap gap-2">
          <Button icon="copy" onClick={copy}>{t("handover.copyLink")}</Button>
          {"share" in navigator && <Button variant="secondary" icon="link" onClick={share}>{t("handover.share")}</Button>}
          <a className="inline-flex items-center gap-2 rounded-lg px-3.5 py-2 text-sm text-emerald-700 ring-1 ring-emerald-200 hover:bg-emerald-50" href={`https://wa.me/?text=${encodeURIComponent(link ?? "")}`} target="_blank" rel="noreferrer noopener">{t("handover.whatsapp")}</a>
        </div>
      </div>
    </Modal>
  );
}

export function CreateHandoverModal({ open, onClose, vehicleId, onCreated }: { open: boolean; onClose: () => void; vehicleId?: string; onCreated: (id: string, link: string) => void }) {
  const vehicles = useVehicles();
  const [v, setV] = useState({ vehicleId: vehicleId ?? "", driverId: "", expiresInDays: "14" });
  const [drivers, setDrivers] = useState<DriverRow[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const vehicle = vehicles.find((x) => x.id === v.vehicleId);
  useEffect(() => { if (open) { setV({ vehicleId: vehicleId ?? "", driverId: "", expiresInDays: "14" }); setError(null); } }, [open, vehicleId]);
  useEffect(() => {
    if (!vehicle?.projectId) return setDrivers([]);
    api<Paged<DriverRow>>("/drivers", { query: { projectId: vehicle.projectId, status: "ACTIVE", pageSize: 100 } }).then((r) => setDrivers(r.data.filter((d) => !d.currentVehicleId || d.currentVehicleId === vehicle.id))).catch(() => setDrivers([]));
  }, [vehicle?.projectId, vehicle?.id]);
  const save = async () => {
    if (!v.vehicleId || !v.driverId) return setError(t("handover.selectTheVehicleAndThe"));
    setBusy(true);
    setError(null);
    try {
      const r = await api<{ data: { id: string; link: string } }>("/handovers", { method: "POST", body: { vehicleId: v.vehicleId, driverId: v.driverId, expiresInDays: Number(v.expiresInDays) } });
      onCreated(r.data.id, r.data.link);
      onClose();
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setBusy(false);
    }
  };
  return (
    <Modal open={open} onClose={onClose} title={t("handover.handOverAVehicleTo")} footer={<><Button variant="secondary" onClick={onClose}>{t("common.cancel")}</Button><Button loading={busy} onClick={save}>{t("handover.createLink")}</Button></>}>
      <div className="space-y-4">
        {error && <Alert>{error}</Alert>}
        <Alert tone="blue">{t("handover.theDriverTakes7Required")}</Alert>
        {!vehicleId && <Field label={t("common.vehicle")} required htmlFor="h-vehicle"><VehicleSelect id="h-vehicle" value={v.vehicleId} onChange={(x) => setV((s) => ({ ...s, vehicleId: x, driverId: "" }))} vehicles={vehicles.filter((x) => ["AVAILABLE", "ASSIGNED"].includes(x.status))} all={t("common.selectAVehicle3")} /></Field>}
        <Field label={t("common.driver")} required htmlFor="h-driver" hint={t("handover.activeDriversInTheVehicle")}>
          <Select id="h-driver" value={v.driverId} onChange={(e) => setV((s) => ({ ...s, driverId: e.target.value }))} disabled={!v.vehicleId}>
            <option value="">{t("handover.selectADriver")}</option>
            {drivers.map((d) => <option key={d.id} value={d.id}>{d.fullName}</option>)}
          </Select>
        </Field>
        <Field label={t("handover.linkValidityDays")} htmlFor="h-days"><Input id="h-days" type="number" min={1} max={90} value={v.expiresInDays} onChange={(e) => setV((s) => ({ ...s, expiresInDays: e.target.value }))} /></Field>
      </div>
    </Modal>
  );
}

export function HandoversList({ vehicleId, embedded }: { vehicleId?: string; embedded?: boolean }) {
  const { can } = useAuth();
  const navigate = useNavigate();
  const [f, setF] = useState({ status: "", active: "" });
  const [page, setPage] = useState(1);
  const [creating, setCreating] = useState(false);
  const [link, setLink] = useState<string | null>(null);
  const { data, loading, error, reload } = useApi<Paged<HandoverRow>>("/handovers", { ...f, vehicleId, page, pageSize: 20 });
  const active = Object.values(f).filter(Boolean).length;
  return (
    <Card>
      <div className="flex items-center justify-between gap-2 border-b border-slate-100 px-4 py-3">
        <p className="text-sm text-slate-500">{t("handover.handoverSessions")}</p>
        {can("handover.create") && <Button icon="key" onClick={() => setCreating(true)}>{t("handover.handOverVehicle")}</Button>}
      </div>
      {!embedded && (
        <FilterBar active={active} onClear={() => setF({ status: "", active: "" })}>
          <Select value={f.status} onChange={(e) => { setF({ ...f, status: e.target.value }); setPage(1); }} aria-label={t("common.status")}><option value="">{t("common.allStatuses")}</option>{Object.entries(HANDOVER_STATUS).map(([k, l]) => <option key={k} value={k}>{l.label}</option>)}</Select>
          <Select value={f.active} onChange={(e) => { setF({ ...f, active: e.target.value }); setPage(1); }} aria-label={t("common.active2")}><option value="">{t("common.all")}</option><option value="true">{t("handover.activeOnly")}</option></Select>
        </FilterBar>
      )}
      {loading ? <Loading /> : error ? <div className="p-4"><Alert>{error.message}</Alert></div> : !data?.data.length ? <EmptyState icon="key" title={t("handover.noHandoverSessions")} /> : (
        <>
          <DataList rows={data.data} rowKey={(r) => r.id} onRowClick={(r) => navigate(`/handovers/${r.id}`)} columns={[
            { header: t("common.vehicle"), primary: true, cell: (r) => <span className="flex gap-2"><span className="font-semibold ltr">{r.plateNumber}</span><span>{r.driverName}</span></span> },
            { header: t("common.status"), cell: (r) => <span className="flex gap-1"><StatusBadge map={HANDOVER_STATUS} value={r.status} />{r.expired && <Badge tone="red">{t("handover.linkExpired")}</Badge>}</span> },
            { header: t("handover.pickup"), cell: (r) => formatDateTime(r.handoverAt) },
            { header: t("handover.return"), cell: (r) => formatDateTime(r.returnAt), hideOnMobile: true },
            { header: t("common.distance"), cell: (r) => (r.returnOdometer !== null && r.handoverOdometer !== null ? t("common.km2", { value: formatNumber(r.returnOdometer - r.handoverOdometer) }) : "—"), hideOnMobile: true },
            { header: t("common.project"), cell: (r) => r.projectName ?? "—", hideOnMobile: true },
          ]} />
          <Pagination {...data.meta} onPage={setPage} />
        </>
      )}
      <CreateHandoverModal open={creating} onClose={() => setCreating(false)} vehicleId={vehicleId} onCreated={(_id, l) => { setLink(l); reload(); }} />
      <LinkModal link={link} onClose={() => setLink(null)} />
    </Card>
  );
}

export function HandoversPage() {
  return (
    <>
      <PageHeader title={t("common.handoverReturn")} subtitle={t("handover.handVehiclesOverToDrivers")} />
      <HandoversList />
    </>
  );
}

type Photo = { id: string; phase: "HANDOVER" | "RETURN"; category: string; damage: boolean; notes: string | null; latitude: string | null; longitude: string | null; capturedAt: string | null };
type Slot = { category: string; handover: { id: string; damage: boolean; notes: string | null } | null; return: { id: string; damage: boolean; notes: string | null } | null; newDamage: boolean };
type HandoverDetail = HandoverRow & {
  make: string;
  model: string;
  vehicleStatus: string;
  handoverNotes: string | null;
  returnNotes: string | null;
  reviewNotes: string | null;
  cancelReason: string | null;
  photos: Photo[];
  progress: Progress | null;
  comparison: { odometer: { handover: number | null; return: number | null; distance: number | null }; notes: { handover: string | null; return: string | null }; slots: Slot[]; extras: { id: string; phase: string; damage: boolean; notes: string | null }[]; newDamageCount: number; durationHours: number | null };
  timeline: AuditRow[];
  actions: string[];
};

function Thumb({ id, label, damage }: { id: string | null | undefined; label: string; damage?: boolean }) {
  if (!id) return <div className="grid aspect-[4/3] place-items-center rounded-lg bg-slate-100 text-xs text-slate-400">{t("handover.noPhoto")}</div>;
  return (
    <a href={fileUrl(`/handover-photos/${id}/file`)} target="_blank" rel="noreferrer" className={cx("relative block overflow-hidden rounded-lg ring-2", damage ? "ring-red-500" : "ring-transparent")}>
      <img src={fileUrl(`/handover-photos/${id}/file`)} alt={label} loading="lazy" className="aspect-[4/3] w-full bg-slate-100 object-cover" />
      {damage && <span className="absolute start-1 top-1 rounded bg-red-600 px-1.5 text-[10px] font-bold text-white">{t("handover.damage")}</span>}
    </a>
  );
}

export function HandoverDetailPage() {
  const { id } = useParams();
  const { data, loading, error, reload } = useApi<{ data: HandoverDetail }>(`/handovers/${id}`);
  const confirm = useConfirm();
  const { busy, run } = useAction();
  const [link, setLink] = useState<string | null>(null);
  const [cancelling, setCancelling] = useState(false);
  const [closing, setClosing] = useState(false);
  const [review, setReview] = useState("");
  if (loading) return <Loading />;
  if (error || !data) return <Alert>{error?.message ?? t("common.couldNotLoad")}</Alert>;
  const h = data.data;
  const has = (a: string) => h.actions.includes(a);
  const c = h.comparison;
  return (
    <>
      <PageHeader
        back={<BackLink to="/handovers" label={t("common.handoverReturn")} />}
        title={<span className="flex flex-wrap items-center gap-3"><span className="ltr">{h.plateNumber}</span><StatusBadge map={HANDOVER_STATUS} value={h.status} />{h.expired && <Badge tone="red">{t("handover.linkExpired2")}</Badge>}</span>}
        subtitle={t("handover.driver", { make: h.make, model: h.model, value: h.driverName ?? "—" })}
        actions={
          <>
            {has("rotateLink") && <Button variant="secondary" icon="link" loading={busy === "rotate"} onClick={async () => { if (!(await confirm({ title: t("handover.renewLink"), message: t("handover.theOldLinkStopsWorking") }))) return; await run("rotate", async () => { const r = await api<{ data: { link: string } }>(`/handovers/${h.id}/rotate-link`, { method: "POST" }); setLink(r.data.link); }, t("handover.linkRenewed")); reload(); }}>{t("handover.renewLink")}</Button>}
            {has("close") && <Button icon="check" onClick={() => setClosing(true)}>{t("handover.closeAfterReview")}</Button>}
            {has("cancel") && <Button variant="ghost" onClick={() => setCancelling(true)}>{t("handover.cancelSession")}</Button>}
          </>
        }
      />
      {has("perform") && h.progress && (
        <Card className="mb-6">
          <CardHeader title={h.progress.phase === "HANDOVER" ? t("handover.vehiclePickupPhotographTheVehicle") : t("handover.vehicleReturnPhotographTheVehicle")} />
          <div className="p-5"><HandoverCapture base={`/handovers/${h.id}`} progress={h.progress} currentOdometer={h.returnOdometer ?? h.handoverOdometer} onDone={reload} authenticated /></div>
        </Card>
      )}
      {h.cancelReason && <div className="mb-4"><Alert>{t("handover.cancellationReason", { cancelReason: h.cancelReason })}</Alert></div>}
      <div className="grid grid-cols-1 gap-6 lg:grid-cols-3">
        <div className="space-y-6 lg:col-span-2">
          <Card>
            <CardHeader title={t("handover.pickupVsReturnComparison")} subtitle={c.newDamageCount ? <span className="text-red-700">{t("handover.newDamageNotesAtReturn", { newDamageCount: c.newDamageCount })}</span> : t("handover.noNewDamageRecorded")} />
            <div className="space-y-5 p-5">
              <DescList items={[
                { label: t("handover.pickupOdometer"), value: c.odometer.handover !== null ? formatNumber(c.odometer.handover) : null },
                { label: t("handover.returnOdometer"), value: c.odometer.return !== null ? formatNumber(c.odometer.return) : null },
                { label: t("handover.distanceDriven"), value: c.odometer.distance !== null ? t("handover.km", { distance: formatNumber(c.odometer.distance) }) : null },
                { label: t("handover.usageDuration"), value: c.durationHours !== null ? t("handover.hours", { durationHours: c.durationHours }) : null },
                { label: t("handover.pickupNotes"), value: c.notes.handover },
                { label: t("handover.returnNotes"), value: c.notes.return },
              ]} />
              <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
                {c.slots.map((s) => (
                  <div key={s.category} className={cx("rounded-xl border p-3", s.newDamage ? "border-red-300 bg-red-50/40" : "border-slate-200")}>
                    <p className="mb-2 flex items-center justify-between text-sm font-medium">{PHOTO_CATEGORY[s.category]}{s.newDamage && <Badge tone="red">{t("handover.newDamage")}</Badge>}</p>
                    <div className="grid grid-cols-2 gap-2">
                      <div><p className="mb-1 text-[11px] text-slate-500">{t("handover.atPickup")}</p><Thumb id={s.handover?.id} label={t("handover.pickup2", { value: PHOTO_CATEGORY[s.category] })} damage={s.handover?.damage} />{s.handover?.notes && <p className="mt-1 text-xs text-slate-600">{s.handover.notes}</p>}</div>
                      <div><p className="mb-1 text-[11px] text-slate-500">{t("handover.atReturn")}</p><Thumb id={s.return?.id} label={t("handover.return2", { value: PHOTO_CATEGORY[s.category] })} damage={s.return?.damage} />{s.return?.notes && <p className="mt-1 text-xs text-slate-600">{s.return.notes}</p>}</div>
                    </div>
                  </div>
                ))}
              </div>
              {c.extras.length > 0 && (
                <div><p className="mb-2 text-sm font-medium">{t("handover.additionalPhotos")}</p><div className="grid grid-cols-3 gap-2 sm:grid-cols-5">{c.extras.map((x) => <Thumb key={x.id} id={x.id} label={t("handover.additionalPhoto")} damage={x.damage} />)}</div></div>
              )}
              {h.reviewNotes && <Alert tone="green">{t("handover.reviewNotes", { reviewNotes: h.reviewNotes })}</Alert>}
            </div>
          </Card>
        </div>
        <div className="space-y-6">
          <Card>
            <CardHeader title={t("handover.details")} />
            <div className="p-5"><DescList items={[
              { label: t("common.vehicle"), value: <Link className="text-brand-700 ltr" to={`/vehicles/${h.vehicleId}`}>{h.plateNumber}</Link> },
              { label: t("common.project"), value: h.projectName },
              { label: t("handover.createdBy"), value: h.createdByName },
              { label: t("handover.linkValidUntil"), value: formatDateTime(h.expiresAt) },
              { label: t("handover.pickupTime"), value: formatDateTime(h.handoverAt) },
              { label: t("handover.returnTime"), value: formatDateTime(h.returnAt) },
            ]} /></div>
          </Card>
          <Card><CardHeader title={t("common.history")} /><div className="p-5"><RecordTimeline rows={h.timeline} /></div></Card>
        </div>
      </div>
      <LinkModal link={link} onClose={() => setLink(null)} />
      <ReasonModal open={cancelling} title={t("handover.cancelHandoverSession")} danger onClose={() => setCancelling(false)} onSubmit={async (reason) => { await api(`/handovers/${h.id}/cancel`, { method: "POST", body: { reason } }); reload(); }} />
      <Modal open={closing} onClose={() => setClosing(false)} title={t("handover.closeTheSessionAfterReview")} footer={<><Button variant="secondary" onClick={() => setClosing(false)}>{t("common.cancel")}</Button><Button loading={busy === "close"} onClick={async () => { if (await run("close", () => api(`/handovers/${h.id}/close`, { method: "POST", body: review.trim() ? { reviewNotes: review.trim() } : {} }), t("handover.sessionClosed"))) { setClosing(false); reload(); } }}>{t("common.close")}</Button></>}>
        <Field label={t("handover.reviewNotesOptional")} htmlFor="rv"><Textarea id="rv" value={review} onChange={(e) => setReview(e.target.value)} /></Field>
      </Modal>
    </>
  );
}

