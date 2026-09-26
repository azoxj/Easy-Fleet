import { lazy, Suspense, useState, type ReactNode } from "react";
import { Link, useParams, useSearchParams } from "react-router";
import { AlertList, ExpiryDate } from "../../components/common";
import { useToast } from "../../components/feedback";
import { Icon } from "../../components/icons";
import { StateBadge } from "../../components/StateBadge";
import { Alert, Button, Card, CardHeader, DescList, EmptyState, Field, Loading, Modal, PageHeader, Select, StatusBadge, Tabs, Textarea, cx } from "../../components/ui";
import { useApi } from "../../hooks/useApi";
import { api, type Paged } from "../../lib/api";
import { useAuth } from "../../lib/auth";
import { formatDate, formatDateTime, formatMoney, formatNumber } from "../../lib/format";
import { errorMessage } from "../../lib/forms";
import { EXPIRY_STATUS, VEHICLE_STATUS } from "../../lib/labels";
import { agoLabel, speedLabel, toFleetVehicle, type LatestLocation } from "../../lib/fleetMap";
import { MAINTENANCE_STATUS, mrNumber } from "../../lib/maintenance";
import type { Compliance, DriverRow, MaintenanceRow, TimelineEvent, VehicleDetail } from "../../lib/types";
import { DocumentsTab } from "./tabs/DocumentsTab";
import { InsuranceTab } from "./tabs/InsuranceTab";
import { MaintenanceTab } from "./tabs/MaintenanceTab";
import { RegistrationTab } from "./tabs/RegistrationTab";
import { VehicleFormModal } from "./VehicleFormModal";
import { fileUrl } from "../../lib/api";
import { ExpensesList } from "../finance/ExpensesPage";
import { HandoversList } from "../handover/HandoverPages";
import { AccidentsList } from "../operations/AccidentsPages";
import { FuelList } from "../operations/FuelPage";
import { ViolationsList } from "../operations/ViolationsPages";

// The GPS tab pulls in Leaflet — loaded only when opened.
const GpsTab = lazy(() => import("./tabs/GpsTab").then((m) => ({ default: m.GpsTab })));

const ALL_TABS = [
  { key: "overview", label: "نظرة عامة" },
  { key: "documents", label: "المستندات", anyOf: ["vehicle_documents.read", "registration.read"] },
  { key: "registration", label: "الاستمارة", perm: "registration.read" },
  { key: "insurance", label: "التأمين", perm: "insurance.read" },
  { key: "maintenance", label: "الصيانة", perm: "maintenance.read" },
  { key: "fuel", label: "الوقود", perm: "fuel.read" },
  { key: "accidents", label: "الحوادث", perm: "accidents.read" },
  { key: "violations", label: "المخالفات", perm: "violations.read" },
  { key: "handover", label: "التسليم والإرجاع", perm: "handover.read" },
  { key: "gps", label: "GPS والرحلات", perm: "gps.read" },
  { key: "expenses", label: "المصروفات", perm: "finance.read" },
  { key: "timeline", label: "سجل التدقيق" },
];

type FuelStats = { totals: { count: number; liters: string; cost: string }; perVehicle: { kmPerLiter: string | null }[] };

/** One clickable summary tile of the vehicle profile strip. */
function ProfileTile({ label, icon, children, onClick, tone = "slate" }: { label: string; icon: string; children: ReactNode; onClick?: () => void; tone?: "slate" | "green" | "amber" | "red" | "blue" }) {
  const toneCls = { slate: "bg-slate-100 text-slate-600", green: "bg-emerald-50 text-emerald-700", amber: "bg-amber-50 text-amber-700", red: "bg-red-50 text-red-700", blue: "bg-blue-50 text-blue-700" }[tone];
  const body = (
    <>
      <span className={cx("grid size-9 shrink-0 place-items-center rounded-lg", toneCls)}><Icon name={icon} className="size-5" /></span>
      <span className="min-w-0 flex-1 text-start">
        <span className="block text-xs text-slate-500">{label}</span>
        <span className="mt-0.5 block text-sm font-semibold break-words text-slate-900">{children}</span>
      </span>
      {onClick && <Icon name="chevron" className="size-4 shrink-0 rotate-180 text-slate-300" />}
    </>
  );
  return onClick ? (
    <button onClick={onClick} className="flex min-h-16 w-full items-center gap-3 rounded-xl border border-slate-200 bg-white p-3 transition hover:border-brand-300 hover:shadow-sm active:scale-[0.99] active:bg-slate-50">{body}</button>
  ) : (
    <div className="flex min-h-16 items-center gap-3 rounded-xl border border-slate-200 bg-white p-3">{body}</div>
  );
}

const expiryTone = (s: string | null | undefined) => (s === "EXPIRED" ? "red" : s === "EXPIRING_SOON" ? "amber" : s === "ACTIVE" ? "green" : "slate");

/** Central vehicle profile: status, driver, project, live location, documents, maintenance and fuel at a glance. */
function ProfileStrip({ v, c, onTab }: { v: VehicleDetail; c: Compliance | undefined; onTab: (k: string) => void }) {
  const { can } = useAuth();
  const gps = useApi<{ data: LatestLocation[]; meta: { staleMinutes: number; serverTime: string } }>(can("gps.read") ? "/tracking/latest" : null, { vehicleId: v.id });
  const mr = useApi<Paged<MaintenanceRow>>(can("maintenance.read") ? "/maintenance" : null, { vehicleId: v.id, pageSize: 1 });
  const fuel = useApi<{ data: FuelStats }>(can("fuel.read") ? "/fuel/stats" : null, { vehicleId: v.id });
  const row = gps.data?.data[0];
  const loc = row && gps.data ? toFleetVehicle(row, Date.parse(gps.data.meta.serverTime), gps.data.meta.staleMinutes) : null;
  const lastMr = mr.data?.data[0];
  const f = fuel.data?.data;
  return (
    <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 xl:grid-cols-4">
      <ProfileTile label="الحالة" icon="truck"><StatusBadge map={VEHICLE_STATUS} value={v.status} /></ProfileTile>
      <ProfileTile label="السائق الحالي" icon="user" tone={v.currentDriver ? "blue" : "slate"}>
        {v.currentDriver ? <Link to={`/drivers/${v.currentDriver.id}`} className="text-brand-700 hover:underline">{v.currentDriver.fullName}</Link> : "بدون سائق"}
      </ProfileTile>
      <ProfileTile label="المشروع" icon="folder">
        {v.projectId ? <Link to={`/projects/${v.projectId}`} className="text-brand-700 hover:underline">{v.projectName}</Link> : "غير مخصصة"}
      </ProfileTile>
      {can("gps.read") && (
        <ProfileTile label="الموقع الحالي" icon="pin" tone={loc ? (loc.state === "MOVING" ? "green" : loc.state === "ALERT" ? "red" : loc.state === "STOPPED" ? "amber" : "slate") : "slate"} onClick={() => onTab("gps")}>
          {gps.loading ? "…" : loc ? <span className="flex flex-wrap items-center gap-1.5"><StateBadge state={loc.state} /> <span className="text-xs font-normal text-slate-500">{speedLabel(loc.speedKmh)} · {agoLabel(loc.ageSeconds)}</span></span> : "لا يوجد موقع مسجل"}
        </ProfileTile>
      )}
      {c?.registration !== undefined && (
        <ProfileTile label="الاستمارة" icon="file" tone={expiryTone(c.registration?.status)} onClick={() => onTab("registration")}>
          {c.registration ? <span>{EXPIRY_STATUS[c.registration.status ?? ""]?.label ?? "—"} <span className="text-xs font-normal text-slate-500">· {formatDate(c.registration.expiryDate)}</span></span> : "لا توجد"}
        </ProfileTile>
      )}
      {can("insurance.read") && (
        <ProfileTile label="التأمين" icon="shield" tone={expiryTone(c?.insurance?.status)} onClick={() => onTab("insurance")}>
          {c?.insurance ? <span>{EXPIRY_STATUS[c.insurance.status ?? ""]?.label ?? "—"} <span className="text-xs font-normal text-slate-500">· {formatDate(c.insurance.expiryDate)}</span></span> : "لا توجد وثيقة"}
        </ProfileTile>
      )}
      {can("maintenance.read") && (
        <ProfileTile label="آخر صيانة" icon="wrench" tone={lastMr && !["CLOSED", "REJECTED"].includes(lastMr.status) ? "amber" : "slate"} onClick={() => onTab("maintenance")}>
          {mr.loading ? "…" : lastMr ? <span className="flex flex-wrap items-center gap-1.5"><span className="ltr">{mrNumber(lastMr.number)}</span><StatusBadge map={MAINTENANCE_STATUS} value={lastMr.status} /></span> : "لا توجد طلبات"}
        </ProfileTile>
      )}
      {can("fuel.read") && (
        <ProfileTile label="الوقود" icon="fuel" onClick={() => onTab("fuel")}>
          {fuel.loading ? "…" : f && f.totals.count > 0 ? <span>{formatMoney(f.totals.cost)} <span className="text-xs font-normal text-slate-500">· {formatNumber(f.totals.liters)} لتر{f.perVehicle[0]?.kmPerLiter ? ` · ${f.perVehicle[0].kmPerLiter} كم/لتر` : ""}</span></span> : "لا توجد تعبئات"}
        </ProfileTile>
      )}
    </div>
  );
}

function Timeline({ id }: { id: string }) {
  const { data, loading, error } = useApi<{ data: TimelineEvent[] }>(`/vehicles/${id}/timeline`);
  if (loading) return <Loading />;
  if (error) return <Alert>{error.message}</Alert>;
  if (!data?.data.length) return <EmptyState icon="clock" title="لا توجد أحداث مسجلة" />;
  return (
    <ol className="relative ms-3 border-s border-slate-200">
      {data.data.map((e) => (
        <li key={e.id} className="ms-6 pb-6">
          <span className="absolute -start-1.5 mt-1.5 size-3 rounded-full border-2 border-white bg-brand-600" />
          <p className="text-sm font-medium break-words text-slate-800">{e.description}</p>
          <p className="mt-0.5 text-xs text-slate-500">
            <span className="rounded bg-slate-100 px-1.5 py-0.5">{e.entityLabel}</span> · {e.actor} · {formatDateTime(e.timestamp)}
          </p>
        </li>
      ))}
    </ol>
  );
}

function ChangeDriverModal({ vehicle, onClose, onSaved }: { vehicle: VehicleDetail; onClose: () => void; onSaved: () => void }) {
  const toast = useToast();
  const drivers = useApi<Paged<DriverRow>>("/drivers", { projectId: vehicle.projectId ?? undefined, status: "ACTIVE", pageSize: 100 });
  const [driverId, setDriverId] = useState(vehicle.currentDriver?.id ?? "");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const options = (drivers.data?.data ?? []).filter((d) => d.projectId === vehicle.projectId && (!d.currentVehicleId || d.currentVehicleId === vehicle.id));

  const save = async () => {
    setBusy(true);
    setError(null);
    try {
      await api(`/vehicles/${vehicle.id}/driver`, { method: "PUT", body: { driverId: driverId || null } });
      toast.success(driverId ? "تم إسناد السائق" : "تم إلغاء إسناد السائق");
      onSaved();
      onClose();
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setBusy(false);
    }
  };
  return (
    <Modal open onClose={onClose} title="السائق الحالي للمركبة" footer={<><Button variant="secondary" onClick={onClose}>إلغاء</Button><Button onClick={save} loading={busy} disabled={driverId === (vehicle.currentDriver?.id ?? "")}>حفظ</Button></>}>
      <div className="space-y-4">
        {error && <Alert>{error}</Alert>}
        <Alert tone="blue">يظهر فقط السائقون النشطون ذوو الرخص السارية في مشروع المركبة، وغير المسند إليهم مركبة أخرى.</Alert>
        <Field label="السائق" htmlFor="cd-driver">
          <Select id="cd-driver" value={driverId} onChange={(e) => setDriverId(e.target.value)}>
            <option value="">— بدون سائق —</option>
            {options.map((d) => <option key={d.id} value={d.id}>{d.fullName}{d.licenseStatus === "EXPIRING_SOON" ? " (رخصة تنتهي قريبًا)" : ""}</option>)}
          </Select>
        </Field>
      </div>
    </Modal>
  );
}

function ArchiveModal({ vehicle, onClose, onDone }: { vehicle: VehicleDetail; onClose: () => void; onDone: () => void }) {
  const toast = useToast();
  const [reason, setReason] = useState("");
  const [busy, setBusy] = useState(false);
  const submit = async () => {
    setBusy(true);
    try {
      await api(`/vehicles/${vehicle.id}/archive`, { method: "POST", body: { reason } });
      toast.success("تمت أرشفة المركبة");
      onDone();
      onClose();
    } catch (err) {
      toast.error(errorMessage(err));
    } finally {
      setBusy(false);
    }
  };
  return (
    <Modal open onClose={onClose} title={`أرشفة المركبة ${vehicle.plateNumber}`} footer={<><Button variant="secondary" onClick={onClose}>إلغاء</Button><Button variant="danger" onClick={submit} loading={busy}>أرشفة</Button></>}>
      <div className="space-y-4">
        <Alert tone="amber">المركبة المؤرشفة تصبح للقراءة فقط.</Alert>
        <Field label="سبب الأرشفة (اختياري)" htmlFor="ar-reason"><Textarea id="ar-reason" value={reason} onChange={(e) => setReason(e.target.value)} maxLength={500} /></Field>
      </div>
    </Modal>
  );
}

function Overview({ v, onChanged, onTab }: { v: VehicleDetail; onChanged: () => void; onTab: (k: string) => void }) {
  const compliance = useApi<{ data: Compliance }>(`/vehicles/${v.id}/compliance`);
  const [changing, setChanging] = useState(false);
  const c = compliance.data?.data;
  return (
    <div className="space-y-6">
    <ProfileStrip v={v} c={c} onTab={onTab} />
    <div className="grid grid-cols-1 gap-6 xl:grid-cols-3">
      <div className="space-y-6 xl:col-span-2">
        {c && c.alerts.length > 0 && (
          <Card>
            <CardHeader title="التنبيهات" />
            <div className="p-5"><AlertList alerts={c.alerts} /></div>
          </Card>
        )}
        <Card>
          <CardHeader title="بيانات المركبة" />
          <div className="p-5">
            <DescList
              items={[
                { label: "رقم اللوحة", value: <span className="ltr">{v.plateNumber}</span> },
                { label: "اللوحة (عربي / إنجليزي)", value: [v.plateArabic, v.plateEnglish ? <span key="en" className="ltr">{v.plateEnglish}</span> : null].filter(Boolean).length ? <span className="flex gap-2">{v.plateArabic}{v.plateEnglish && <span className="ltr text-slate-500">{v.plateEnglish}</span>}</span> : "—" },
                { label: "الرقم التسلسلي", value: v.serialNumber ? <span className="ltr">{v.serialNumber}</span> : "—" },
                { label: "رقم المركبة الداخلي", value: v.vehicleNumber ?? "—" },
                { label: "رقم الهيكل (VIN)", value: v.vin ? <span className="ltr break-all">{v.vin}</span> : "—" },
                { label: "الشركة المصنعة / الطراز", value: `${v.make} ${v.model}` },
                { label: "سنة الصنع", value: v.year ?? "—" },
                { label: "اللون", value: v.color ?? "—" },
                { label: "قراءة العداد", value: `${formatNumber(v.currentOdometer)} كم` },
                { label: "الحالة", value: <StatusBadge map={VEHICLE_STATUS} value={v.status} /> },
                { label: "المشروع", value: v.projectId ? <Link className="text-brand-700 hover:underline" to={`/projects/${v.projectId}`}>{v.projectName}</Link> : "غير مخصصة" },
              ]}
            />
            {v.notes && <p className="mt-5 rounded-lg bg-slate-50 p-4 text-sm whitespace-pre-line text-slate-700">{v.notes}</p>}
          </div>
        </Card>
        <Card>
          <CardHeader title="الاستمارة والتأمين" />
          {compliance.loading ? <Loading /> : (
            <div className="p-5">
              <DescList
                items={[
                  ...(c?.registration !== undefined
                    ? [
                        { label: "رقم الاستمارة", value: c?.registration?.documentNumber ? <span className="ltr">{c.registration.documentNumber}</span> : "—" },
                        { label: "انتهاء الاستمارة", value: c?.registration ? <ExpiryDate date={c.registration.expiryDate} status={c.registration.status} daysLeft={c.registration.daysLeft} /> : "لا توجد" },
                      ]
                    : []),
                  ...(c?.insurance
                    ? [
                        { label: "شركة التأمين", value: c.insurance.provider },
                        { label: "انتهاء التأمين", value: <ExpiryDate date={c.insurance.expiryDate} status={c.insurance.status} daysLeft={c.insurance.daysLeft} /> },
                      ]
                    : [{ label: "التأمين", value: c ? "لا توجد وثيقة أو ليست ضمن صلاحياتك" : "—" }]),
                ]}
              />
            </div>
          )}
        </Card>
      </div>
      <div className="space-y-6">
        <Card>
          <CardHeader title="السائق الحالي" action={v.capabilities.changeDriver && <Button variant="secondary" onClick={() => setChanging(true)}>{v.currentDriver ? "تغيير" : "إسناد سائق"}</Button>} />
          <div className="p-5 text-sm">
            {v.currentDriver ? (
              <div className="space-y-2">
                <p className="font-medium text-slate-900">{v.currentDriver.fullName}</p>
                {c?.driverLicense && <p className="text-slate-600">الرخصة: <ExpiryDate date={c.driverLicense.licenseExpiryDate} status={c.driverLicense.licenseStatus} /></p>}
                <Link to={`/drivers/${v.currentDriver.id}`} className="inline-flex items-center gap-1 text-brand-700 hover:underline">ملف السائق <Icon name="back" className="size-4" /></Link>
              </div>
            ) : (
              <p className="text-slate-500">لا يوجد سائق مسند</p>
            )}
          </div>
        </Card>
        <Card>
          <CardHeader title="الشراء والضمان" />
          <div className="p-5">
            <DescList
              items={[
                { label: "تاريخ الشراء", value: formatDate(v.purchaseDate) },
                { label: "سعر الشراء", value: formatMoney(v.purchasePrice) },
                { label: "بداية الضمان", value: formatDate(v.warrantyStart) },
                { label: "نهاية الضمان", value: formatDate(v.warrantyEnd) },
              ]}
            />
          </div>
        </Card>
      </div>
      {changing && <ChangeDriverModal vehicle={v} onClose={() => setChanging(false)} onSaved={() => { onChanged(); compliance.reload(); }} />}
    </div>
    </div>
  );
}

export function VehicleDetailPage() {
  const { id = "" } = useParams();
  const { me, can } = useAuth();
  const { data, loading, error, reload } = useApi<{ data: VehicleDetail }>(`/vehicles/${id}`);
  const [params, setParams] = useSearchParams();
  const tab = params.get("tab") === "audit" ? "timeline" : (params.get("tab") ?? "overview");
  const setTab = (k: string) => {
    const next = new URLSearchParams(params);
    if (k === "overview") next.delete("tab");
    else next.set("tab", k);
    setParams(next, { replace: true });
  };
  const [editing, setEditing] = useState(false);
  const [archiving, setArchiving] = useState(false);
  const [version, setVersion] = useState(0);
  const [qr, setQr] = useState(false);

  if (loading && !data) return <Loading />;
  if (error || !data) return <EmptyState icon="truck" title={error?.status === 404 ? "المركبة غير موجودة" : "تعذر تحميل المركبة"} description={error?.message} action={<Link to="/vehicles" className="text-sm text-brand-700">العودة للمركبات</Link>} />;
  const v = data.data;
  const limited = me?.permissions["vehicles.update"] === "ASSIGNED" || (me?.permissions["vehicles.update"] === "PROJECT" && !me.projectIds.includes(v.projectId ?? ""));
  const tabs = ALL_TABS.filter((t) => (t.perm ? can(t.perm) : t.anyOf ? t.anyOf.some((p) => can(p)) : true));
  const active = tabs.find((t) => t.key === tab) ?? tabs[0]!;
  const refresh = () => { reload(); setVersion((x) => x + 1); };

  return (
    <>
      <PageHeader
        back={<Link to="/vehicles" className="mb-2 inline-flex items-center gap-1 text-sm text-slate-500 hover:text-slate-700"><Icon name="chevron" className="size-4" /> المركبات</Link>}
        title={<span className="flex flex-wrap items-center gap-3"><span className="ltr">{v.plateNumber}</span> <StatusBadge map={VEHICLE_STATUS} value={v.status} /></span>}
        subtitle={`${v.make} ${v.model}${v.year ? ` — ${v.year}` : ""}`}
        actions={
          <>
            <Button variant="secondary" icon="qr" onClick={() => setQr(true)}>رمز QR</Button>
            {v.capabilities.update && <Button variant="secondary" icon="edit" onClick={() => setEditing(true)}>{limited ? "تحديث العداد" : "تعديل"}</Button>}
            {v.capabilities.archive && <Button variant="danger" icon="archive" onClick={() => setArchiving(true)}>أرشفة</Button>}
          </>
        }
      />
      <Tabs tabs={tabs} active={active.key} onChange={setTab} />
      <div className="mt-5" key={version}>
        {active.key === "overview" && <Overview v={v} onChanged={refresh} onTab={setTab} />}
        {active.key === "gps" && <Suspense fallback={<Loading />}><GpsTab vehicleId={id} /></Suspense>}
        {active.key === "registration" && <RegistrationTab vehicleId={id} />}
        {active.key === "insurance" && <InsuranceTab vehicleId={id} />}
        {active.key === "documents" && <DocumentsTab vehicleId={id} />}
        {active.key === "maintenance" && <MaintenanceTab vehicleId={id} archived={v.status === "ARCHIVED"} />}
        {active.key === "timeline" && <Card className="p-5"><Timeline id={id} /></Card>}
        {active.key === "fuel" && <FuelList vehicleId={id} embedded />}
        {active.key === "accidents" && <AccidentsList vehicleId={id} embedded />}
        {active.key === "violations" && <ViolationsList vehicleId={id} embedded />}
        {active.key === "handover" && <HandoversList vehicleId={id} embedded />}
        {active.key === "expenses" && <ExpensesList vehicleId={id} projectId={v.projectId ?? undefined} embedded />}
      </div>
      <VehicleFormModal open={editing} onClose={() => setEditing(false)} vehicle={v} limited={limited} onSaved={refresh} />
      {archiving && <ArchiveModal vehicle={v} onClose={() => setArchiving(false)} onDone={refresh} />}
      <Modal open={qr} onClose={() => setQr(false)} title={`رمز QR للمركبة ${v.plateNumber}`} footer={<><a className="inline-flex items-center gap-2 rounded-lg bg-white px-3.5 py-2 text-sm ring-1 ring-slate-300" href={fileUrl(`/vehicles/${id}/qr?format=png`)} download={`qr-${v.plateNumber}.png`}>تنزيل PNG</a><Button icon="printer" onClick={() => window.print()}>طباعة</Button></>}>
        <div className="text-center">
          {qr && <img src={fileUrl(`/vehicles/${id}/qr`)} alt={`رمز QR للمركبة ${v.plateNumber}`} className="mx-auto size-64" />}
          <p className="mt-3 text-lg font-bold ltr">{v.plateNumber}</p>
          <p className="mt-1 text-xs text-slate-500">مسح الرمز يفتح ملف المركبة لمن لديه صلاحية فقط — لا يكشف أي بيانات لغير المصرح لهم.</p>
        </div>
      </Modal>
    </>
  );
}
