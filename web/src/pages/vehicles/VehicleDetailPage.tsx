import { useState } from "react";
import { Link, useParams } from "react-router";
import { AlertList, ExpiryDate } from "../../components/common";
import { useToast } from "../../components/feedback";
import { Icon } from "../../components/icons";
import { Alert, Button, Card, CardHeader, DescList, EmptyState, Field, Loading, Modal, PageHeader, Select, StatusBadge, Tabs, Textarea } from "../../components/ui";
import { useApi } from "../../hooks/useApi";
import { api, type Paged } from "../../lib/api";
import { useAuth } from "../../lib/auth";
import { formatDate, formatDateTime, formatMoney, formatNumber } from "../../lib/format";
import { errorMessage } from "../../lib/forms";
import { VEHICLE_STATUS } from "../../lib/labels";
import type { Compliance, DriverRow, TimelineEvent, VehicleDetail } from "../../lib/types";
import { DocumentsTab } from "./tabs/DocumentsTab";
import { InsuranceTab } from "./tabs/InsuranceTab";
import { RegistrationTab } from "./tabs/RegistrationTab";
import { VehicleFormModal } from "./VehicleFormModal";

const SOON = ["maintenance", "fuel", "accidents", "violations", "handover", "expenses"];
const ALL_TABS = [
  { key: "overview", label: "نظرة عامة" },
  { key: "registration", label: "الاستمارة", perm: "registration.read" },
  { key: "insurance", label: "التأمين", perm: "insurance.read" },
  { key: "documents", label: "المستندات", anyOf: ["vehicle_documents.read", "registration.read"] },
  { key: "maintenance", label: "الصيانة", soon: true },
  { key: "fuel", label: "الوقود", soon: true },
  { key: "accidents", label: "الحوادث", soon: true },
  { key: "violations", label: "المخالفات", soon: true },
  { key: "handover", label: "التسليم والاستلام", soon: true },
  { key: "expenses", label: "المصروفات", soon: true },
  { key: "timeline", label: "السجل الزمني" },
];

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

function Overview({ v, onChanged }: { v: VehicleDetail; onChanged: () => void }) {
  const compliance = useApi<{ data: Compliance }>(`/vehicles/${v.id}/compliance`);
  const [changing, setChanging] = useState(false);
  const c = compliance.data?.data;
  return (
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
  );
}

export function VehicleDetailPage() {
  const { id = "" } = useParams();
  const { me, can } = useAuth();
  const { data, loading, error, reload } = useApi<{ data: VehicleDetail }>(`/vehicles/${id}`);
  const [tab, setTab] = useState("overview");
  const [editing, setEditing] = useState(false);
  const [archiving, setArchiving] = useState(false);
  const [version, setVersion] = useState(0);

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
            {v.capabilities.update && <Button variant="secondary" icon="edit" onClick={() => setEditing(true)}>{limited ? "تحديث العداد" : "تعديل"}</Button>}
            {v.capabilities.archive && <Button variant="danger" icon="archive" onClick={() => setArchiving(true)}>أرشفة</Button>}
          </>
        }
      />
      <Tabs tabs={tabs} active={active.key} onChange={setTab} />
      <div className="mt-5" key={version}>
        {active.key === "overview" && <Overview v={v} onChanged={refresh} />}
        {active.key === "registration" && <RegistrationTab vehicleId={id} />}
        {active.key === "insurance" && <InsuranceTab vehicleId={id} />}
        {active.key === "documents" && <DocumentsTab vehicleId={id} />}
        {active.key === "timeline" && <Card className="p-5"><Timeline id={id} /></Card>}
        {SOON.includes(active.key) && (
          <Card><EmptyState icon="clock" title={`${active.label} — قريبًا`} description="هذا القسم سيتوفر في Sprint قادم مع الوحدة الخاصة به." /></Card>
        )}
      </div>
      <VehicleFormModal open={editing} onClose={() => setEditing(false)} vehicle={v} limited={limited} onSaved={refresh} />
      {archiving && <ArchiveModal vehicle={v} onClose={() => setArchiving(false)} onDone={refresh} />}
    </>
  );
}
