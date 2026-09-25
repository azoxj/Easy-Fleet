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

/** Shows a freshly created/rotated link once, with copy + share. */
export function LinkModal({ link, onClose }: { link: string | null; onClose: () => void }) {
  const toast = useToast();
  const copy = async () => {
    try {
      await navigator.clipboard.writeText(link!);
      toast.success("تم نسخ الرابط");
    } catch {
      toast.error("تعذر النسخ — انسخ الرابط يدويًا");
    }
  };
  const share = () => navigator.share?.({ title: "رابط تسليم المركبة", url: link! }).catch(() => undefined);
  return (
    <Modal open={!!link} onClose={onClose} title="رابط التسليم للسائق" footer={<Button onClick={onClose}>تم</Button>}>
      <div className="space-y-4">
        <Alert tone="amber">يظهر هذا الرابط مرة واحدة فقط ولا يُخزن في النظام. أرسله للسائق عبر قناة موثوقة. نفس الرابط يُستخدم للاستلام ثم للإرجاع.</Alert>
        <Input readOnly value={link ?? ""} dir="ltr" onFocus={(e) => e.target.select()} aria-label="الرابط" />
        <div className="flex flex-wrap gap-2">
          <Button icon="copy" onClick={copy}>نسخ الرابط</Button>
          {"share" in navigator && <Button variant="secondary" icon="link" onClick={share}>مشاركة</Button>}
          <a className="inline-flex items-center gap-2 rounded-lg px-3.5 py-2 text-sm text-emerald-700 ring-1 ring-emerald-200 hover:bg-emerald-50" href={`https://wa.me/?text=${encodeURIComponent(link ?? "")}`} target="_blank" rel="noreferrer noopener">واتساب</a>
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
    if (!v.vehicleId || !v.driverId) return setError("اختر المركبة والسائق");
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
    <Modal open={open} onClose={onClose} title="تسليم مركبة لسائق" footer={<><Button variant="secondary" onClick={onClose}>إلغاء</Button><Button loading={busy} onClick={save}>إنشاء الرابط</Button></>}>
      <div className="space-y-4">
        {error && <Alert>{error}</Alert>}
        <Alert tone="blue">يصوّر السائق 7 صور إلزامية (الأمام، الخلف، الجانبين، الداخلية، العداد، الإطارات) ويوقّع، ثم يُسند إليه النظام المركبة تلقائيًا. عند الإرجاع يكرر التصوير ويقارن النظام بين الحالتين.</Alert>
        {!vehicleId && <Field label="المركبة" required htmlFor="h-vehicle"><VehicleSelect id="h-vehicle" value={v.vehicleId} onChange={(x) => setV((s) => ({ ...s, vehicleId: x, driverId: "" }))} vehicles={vehicles.filter((x) => ["AVAILABLE", "ASSIGNED"].includes(x.status))} all="اختر المركبة..." /></Field>}
        <Field label="السائق" required htmlFor="h-driver" hint="السائقون النشطون في مشروع المركبة وغير المسند إليهم مركبة أخرى">
          <Select id="h-driver" value={v.driverId} onChange={(e) => setV((s) => ({ ...s, driverId: e.target.value }))} disabled={!v.vehicleId}>
            <option value="">اختر السائق...</option>
            {drivers.map((d) => <option key={d.id} value={d.id}>{d.fullName}</option>)}
          </Select>
        </Field>
        <Field label="صلاحية الرابط (أيام)" htmlFor="h-days"><Input id="h-days" type="number" min={1} max={90} value={v.expiresInDays} onChange={(e) => setV((s) => ({ ...s, expiresInDays: e.target.value }))} /></Field>
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
        <p className="text-sm text-slate-500">جلسات التسليم والاستلام</p>
        {can("handover.create") && <Button icon="key" onClick={() => setCreating(true)}>تسليم مركبة</Button>}
      </div>
      {!embedded && (
        <FilterBar active={active} onClear={() => setF({ status: "", active: "" })}>
          <Select value={f.status} onChange={(e) => { setF({ ...f, status: e.target.value }); setPage(1); }} aria-label="الحالة"><option value="">كل الحالات</option>{Object.entries(HANDOVER_STATUS).map(([k, l]) => <option key={k} value={k}>{l.label}</option>)}</Select>
          <Select value={f.active} onChange={(e) => { setF({ ...f, active: e.target.value }); setPage(1); }} aria-label="نشطة"><option value="">الكل</option><option value="true">النشطة فقط</option></Select>
        </FilterBar>
      )}
      {loading ? <Loading /> : error ? <div className="p-4"><Alert>{error.message}</Alert></div> : !data?.data.length ? <EmptyState icon="key" title="لا توجد جلسات تسليم" /> : (
        <>
          <DataList rows={data.data} rowKey={(r) => r.id} onRowClick={(r) => navigate(`/handovers/${r.id}`)} columns={[
            { header: "المركبة", primary: true, cell: (r) => <span className="flex gap-2"><span className="font-semibold ltr">{r.plateNumber}</span><span>{r.driverName}</span></span> },
            { header: "الحالة", cell: (r) => <span className="flex gap-1"><StatusBadge map={HANDOVER_STATUS} value={r.status} />{r.expired && <Badge tone="red">منتهي الرابط</Badge>}</span> },
            { header: "الاستلام", cell: (r) => formatDateTime(r.handoverAt) },
            { header: "الإرجاع", cell: (r) => formatDateTime(r.returnAt), hideOnMobile: true },
            { header: "المسافة", cell: (r) => (r.returnOdometer !== null && r.handoverOdometer !== null ? `${formatNumber(r.returnOdometer - r.handoverOdometer)} كم` : "—"), hideOnMobile: true },
            { header: "المشروع", cell: (r) => r.projectName ?? "—", hideOnMobile: true },
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
      <PageHeader title="التسليم والاستلام" subtitle="تسليم المركبات للسائقين عبر رابط آمن وإرجاعها مع مقارنة الحالة" />
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
  if (!id) return <div className="grid aspect-[4/3] place-items-center rounded-lg bg-slate-100 text-xs text-slate-400">لا توجد صورة</div>;
  return (
    <a href={fileUrl(`/handover-photos/${id}/file`)} target="_blank" rel="noreferrer" className={cx("relative block overflow-hidden rounded-lg ring-2", damage ? "ring-red-500" : "ring-transparent")}>
      <img src={fileUrl(`/handover-photos/${id}/file`)} alt={label} loading="lazy" className="aspect-[4/3] w-full bg-slate-100 object-cover" />
      {damage && <span className="absolute start-1 top-1 rounded bg-red-600 px-1.5 text-[10px] font-bold text-white">ضرر</span>}
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
  if (error || !data) return <Alert>{error?.message ?? "تعذر التحميل"}</Alert>;
  const h = data.data;
  const has = (a: string) => h.actions.includes(a);
  const c = h.comparison;
  return (
    <>
      <PageHeader
        back={<BackLink to="/handovers" label="التسليم والاستلام" />}
        title={<span className="flex flex-wrap items-center gap-3"><span className="ltr">{h.plateNumber}</span><StatusBadge map={HANDOVER_STATUS} value={h.status} />{h.expired && <Badge tone="red">الرابط منتهي</Badge>}</span>}
        subtitle={`${h.make} ${h.model} — السائق: ${h.driverName ?? "—"}`}
        actions={
          <>
            {has("rotateLink") && <Button variant="secondary" icon="link" loading={busy === "rotate"} onClick={async () => { if (!(await confirm({ title: "تجديد الرابط", message: "سيتوقف الرابط القديم فورًا ويُنشأ رابط جديد." }))) return; await run("rotate", async () => { const r = await api<{ data: { link: string } }>(`/handovers/${h.id}/rotate-link`, { method: "POST" }); setLink(r.data.link); }, "تم تجديد الرابط"); reload(); }}>تجديد الرابط</Button>}
            {has("close") && <Button icon="check" onClick={() => setClosing(true)}>إغلاق بعد المراجعة</Button>}
            {has("cancel") && <Button variant="ghost" onClick={() => setCancelling(true)}>إلغاء الجلسة</Button>}
          </>
        }
      />
      {has("perform") && h.progress && (
        <Card className="mb-6">
          <CardHeader title={h.progress.phase === "HANDOVER" ? "استلام المركبة — صوّر المركبة ووقّع" : "إرجاع المركبة — صوّر المركبة ووقّع"} />
          <div className="p-5"><HandoverCapture base={`/handovers/${h.id}`} progress={h.progress} currentOdometer={h.returnOdometer ?? h.handoverOdometer} onDone={reload} authenticated /></div>
        </Card>
      )}
      {h.cancelReason && <div className="mb-4"><Alert>سبب الإلغاء: {h.cancelReason}</Alert></div>}
      <div className="grid grid-cols-1 gap-6 lg:grid-cols-3">
        <div className="space-y-6 lg:col-span-2">
          <Card>
            <CardHeader title="المقارنة بين الاستلام والإرجاع" subtitle={c.newDamageCount ? <span className="text-red-700">{c.newDamageCount} ملاحظة ضرر جديدة عند الإرجاع</span> : "لا توجد أضرار جديدة مسجلة"} />
            <div className="space-y-5 p-5">
              <DescList items={[
                { label: "عداد الاستلام", value: c.odometer.handover !== null ? formatNumber(c.odometer.handover) : null },
                { label: "عداد الإرجاع", value: c.odometer.return !== null ? formatNumber(c.odometer.return) : null },
                { label: "المسافة المقطوعة", value: c.odometer.distance !== null ? `${formatNumber(c.odometer.distance)} كم` : null },
                { label: "مدة الاستخدام", value: c.durationHours !== null ? `${c.durationHours} ساعة` : null },
                { label: "ملاحظات الاستلام", value: c.notes.handover },
                { label: "ملاحظات الإرجاع", value: c.notes.return },
              ]} />
              <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
                {c.slots.map((s) => (
                  <div key={s.category} className={cx("rounded-xl border p-3", s.newDamage ? "border-red-300 bg-red-50/40" : "border-slate-200")}>
                    <p className="mb-2 flex items-center justify-between text-sm font-medium">{PHOTO_CATEGORY[s.category]}{s.newDamage && <Badge tone="red">ضرر جديد</Badge>}</p>
                    <div className="grid grid-cols-2 gap-2">
                      <div><p className="mb-1 text-[11px] text-slate-500">عند الاستلام</p><Thumb id={s.handover?.id} label={`${PHOTO_CATEGORY[s.category]} — استلام`} damage={s.handover?.damage} />{s.handover?.notes && <p className="mt-1 text-xs text-slate-600">{s.handover.notes}</p>}</div>
                      <div><p className="mb-1 text-[11px] text-slate-500">عند الإرجاع</p><Thumb id={s.return?.id} label={`${PHOTO_CATEGORY[s.category]} — إرجاع`} damage={s.return?.damage} />{s.return?.notes && <p className="mt-1 text-xs text-slate-600">{s.return.notes}</p>}</div>
                    </div>
                  </div>
                ))}
              </div>
              {c.extras.length > 0 && (
                <div><p className="mb-2 text-sm font-medium">صور إضافية</p><div className="grid grid-cols-3 gap-2 sm:grid-cols-5">{c.extras.map((x) => <Thumb key={x.id} id={x.id} label="صورة إضافية" damage={x.damage} />)}</div></div>
              )}
              {h.reviewNotes && <Alert tone="green">ملاحظات المراجعة: {h.reviewNotes}</Alert>}
            </div>
          </Card>
        </div>
        <div className="space-y-6">
          <Card>
            <CardHeader title="البيانات" />
            <div className="p-5"><DescList items={[
              { label: "المركبة", value: <Link className="text-brand-700 ltr" to={`/vehicles/${h.vehicleId}`}>{h.plateNumber}</Link> },
              { label: "المشروع", value: h.projectName },
              { label: "أنشأها", value: h.createdByName },
              { label: "صلاحية الرابط حتى", value: formatDateTime(h.expiresAt) },
              { label: "وقت الاستلام", value: formatDateTime(h.handoverAt) },
              { label: "وقت الإرجاع", value: formatDateTime(h.returnAt) },
            ]} /></div>
          </Card>
          <Card><CardHeader title="السجل" /><div className="p-5"><RecordTimeline rows={h.timeline} /></div></Card>
        </div>
      </div>
      <LinkModal link={link} onClose={() => setLink(null)} />
      <ReasonModal open={cancelling} title="إلغاء جلسة التسليم" danger onClose={() => setCancelling(false)} onSubmit={async (reason) => { await api(`/handovers/${h.id}/cancel`, { method: "POST", body: { reason } }); reload(); }} />
      <Modal open={closing} onClose={() => setClosing(false)} title="إغلاق الجلسة بعد المراجعة" footer={<><Button variant="secondary" onClick={() => setClosing(false)}>إلغاء</Button><Button loading={busy === "close"} onClick={async () => { if (await run("close", () => api(`/handovers/${h.id}/close`, { method: "POST", body: review.trim() ? { reviewNotes: review.trim() } : {} }), "تم إغلاق الجلسة")) { setClosing(false); reload(); } }}>إغلاق</Button></>}>
        <Field label="ملاحظات المراجعة (اختياري)" htmlFor="rv"><Textarea id="rv" value={review} onChange={(e) => setReview(e.target.value)} /></Field>
      </Modal>
    </>
  );
}

