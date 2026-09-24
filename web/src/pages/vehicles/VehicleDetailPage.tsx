import { useState } from "react";
import { Link, useParams } from "react-router";
import { Icon } from "../../components/icons";
import { Alert, Button, Card, CardHeader, DescList, EmptyState, Loading, PageHeader, StatusBadge, Tabs } from "../../components/ui";
import { useApi } from "../../hooks/useApi";
import { api } from "../../lib/api";
import { useAuth } from "../../lib/auth";
import { formatDate, formatDateTime, formatMoney, formatNumber } from "../../lib/format";
import { errorMessage } from "../../lib/forms";
import { AUDIT_ACTION, FIELD_LABEL, VEHICLE_STATUS } from "../../lib/labels";
import type { VehicleDetail } from "../../lib/types";
import { VehicleFormModal } from "./VehicleFormModal";

const TABS = [
  { key: "overview", label: "نظرة عامة" },
  { key: "maintenance", label: "الصيانة", soon: true },
  { key: "insurance", label: "التأمين", soon: true },
  { key: "registration", label: "الاستمارة", soon: true },
  { key: "fuel", label: "الوقود", soon: true },
  { key: "accidents", label: "الحوادث", soon: true },
  { key: "violations", label: "المخالفات", soon: true },
  { key: "documents", label: "المستندات", soon: true },
  { key: "handover", label: "التسليم والاستلام", soon: true },
  { key: "expenses", label: "المصروفات", soon: true },
  { key: "timeline", label: "السجل الزمني" },
];

type TimelineEntry = { id: number; action: string; metadata: Record<string, unknown> | null; createdAt: string; userName: string | null };

function renderValue(field: string, value: unknown) {
  if (value === null || value === undefined || value === "") return "—";
  if (field === "status") return VEHICLE_STATUS[String(value)]?.label ?? String(value);
  return String(value);
}

function Timeline({ id }: { id: string }) {
  const { data, loading, error } = useApi<{ data: TimelineEntry[] }>(`/vehicles/${id}/timeline`);
  if (loading) return <Loading />;
  if (error) return <Alert>{error.message}</Alert>;
  if (!data?.data.length) return <EmptyState icon="clock" title="لا توجد أحداث مسجلة" />;
  return (
    <ol className="relative ms-3 border-s border-slate-200">
      {data.data.map((e) => {
        const changes = (e.metadata?.changes ?? null) as Record<string, { from: unknown; to: unknown }> | null;
        return (
          <li key={e.id} className="ms-6 pb-6">
            <span className="absolute -start-1.5 mt-1.5 size-3 rounded-full border-2 border-white bg-brand-600" />
            <p className="text-sm font-medium text-slate-800">{AUDIT_ACTION[e.action] ?? e.action}</p>
            <p className="text-xs text-slate-500">{e.userName ?? "النظام"} — {formatDateTime(e.createdAt)}</p>
            {changes && (
              <ul className="mt-2 space-y-1 rounded-lg bg-slate-50 p-3 text-xs text-slate-600">
                {Object.entries(changes).map(([field, c]) => (
                  <li key={field}>
                    <span className="font-medium">{FIELD_LABEL[field] ?? field}:</span> {renderValue(field, c.from)} ← {renderValue(field, c.to)}
                  </li>
                ))}
              </ul>
            )}
          </li>
        );
      })}
    </ol>
  );
}

export function VehicleDetailPage() {
  const { id = "" } = useParams();
  const { me } = useAuth();
  const { data, loading, error, reload } = useApi<{ data: VehicleDetail }>(`/vehicles/${id}`);
  const [tab, setTab] = useState("overview");
  const [editing, setEditing] = useState(false);
  const [actionError, setActionError] = useState<string | null>(null);
  const [archiving, setArchiving] = useState(false);

  if (loading) return <Loading />;
  if (error || !data) return <EmptyState icon="truck" title={error?.status === 404 ? "المركبة غير موجودة" : "تعذر تحميل المركبة"} description={error?.message} action={<Link to="/vehicles" className="text-sm text-brand-700">العودة للمركبات</Link>} />;
  const v = data.data;
  const limited = me?.permissions["vehicles.update"] === "ASSIGNED" || (me?.permissions["vehicles.update"] === "PROJECT" && !me.projectIds.includes(v.projectId ?? ""));

  const archive = async () => {
    const reason = window.prompt("سبب الأرشفة (اختياري):");
    if (reason === null) return;
    setArchiving(true);
    setActionError(null);
    try {
      await api(`/vehicles/${id}/archive`, { method: "POST", body: { reason } });
      reload();
    } catch (err) {
      setActionError(errorMessage(err));
    } finally {
      setArchiving(false);
    }
  };

  const active = TABS.find((t) => t.key === tab)!;

  return (
    <>
      <PageHeader
        back={<Link to="/vehicles" className="mb-2 inline-flex items-center gap-1 text-sm text-slate-500 hover:text-slate-700"><Icon name="chevron" className="size-4" /> المركبات</Link>}
        title={<span className="flex flex-wrap items-center gap-3"><span className="ltr">{v.plateNumber}</span> <StatusBadge map={VEHICLE_STATUS} value={v.status} /></span>}
        subtitle={`${v.make} ${v.model}${v.year ? ` — ${v.year}` : ""}`}
        actions={
          <>
            {v.capabilities.update && <Button variant="secondary" icon="edit" onClick={() => setEditing(true)}>{limited ? "تحديث العداد" : "تعديل"}</Button>}
            {v.capabilities.archive && <Button variant="danger" icon="archive" loading={archiving} onClick={() => void archive()}>أرشفة</Button>}
          </>
        }
      />
      {actionError && <div className="mb-4"><Alert>{actionError}</Alert></div>}

      <Tabs tabs={TABS} active={tab} onChange={setTab} />
      <div className="mt-5">
        {tab === "overview" && (
          <div className="grid grid-cols-1 gap-6 xl:grid-cols-3">
            <Card className="xl:col-span-2">
              <CardHeader title="بيانات المركبة" />
              <div className="p-5">
                <DescList
                  items={[
                    { label: "رقم اللوحة", value: <span className="ltr">{v.plateNumber}</span> },
                    { label: "رقم المركبة الداخلي", value: v.vehicleNumber ?? "—" },
                    { label: "رقم الهيكل (VIN)", value: v.vin ? <span className="ltr">{v.vin}</span> : "—" },
                    { label: "الشركة المصنعة", value: v.make },
                    { label: "الطراز", value: v.model },
                    { label: "سنة الصنع", value: v.year ?? "—" },
                    { label: "اللون", value: v.color ?? "—" },
                    { label: "قراءة العداد", value: `${formatNumber(v.currentOdometer)} كم` },
                    { label: "المشروع", value: v.projectId ? <Link className="text-brand-700 hover:underline" to={`/projects/${v.projectId}`}>{v.projectName}</Link> : "غير مخصصة" },
                    { label: "السائق المسند", value: v.assignedDriverId ? "مسند" : "—" },
                  ]}
                />
                {v.notes && (
                  <div className="mt-5 rounded-lg bg-slate-50 p-4">
                    <p className="text-xs text-slate-500">ملاحظات</p>
                    <p className="mt-1 text-sm whitespace-pre-line text-slate-700">{v.notes}</p>
                  </div>
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
                    { label: "تاريخ الإضافة", value: formatDate(v.createdAt) },
                    { label: "آخر تحديث", value: formatDateTime(v.updatedAt) },
                  ]}
                />
              </div>
            </Card>
          </div>
        )}
        {tab === "timeline" && (
          <Card className="p-5">
            <Timeline id={id} />
          </Card>
        )}
        {active.soon && (
          <Card>
            <EmptyState icon="clock" title={`${active.label} — قريبًا`} description="هذا القسم سيتوفر في Sprint قادم مع الوحدة الخاصة به." />
          </Card>
        )}
      </div>

      <VehicleFormModal open={editing} onClose={() => setEditing(false)} vehicle={v} limited={limited} onSaved={() => reload()} />
    </>
  );
}
