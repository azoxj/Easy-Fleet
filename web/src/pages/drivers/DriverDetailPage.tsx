import { useState } from "react";
import { Link, useParams } from "react-router";
import { AlertList, ExpiryDate } from "../../components/common";
import { useConfirm, useToast } from "../../components/feedback";
import { Icon } from "../../components/icons";
import { Button, Card, CardHeader, DescList, EmptyState, Loading, PageHeader, StatusBadge } from "../../components/ui";
import { useApi } from "../../hooks/useApi";
import { api } from "../../lib/api";
import { useAuth } from "../../lib/auth";
import { formatDate, formatDateTime } from "../../lib/format";
import { errorMessage } from "../../lib/forms";
import { DRIVER_STATUS, LICENSE_TYPE } from "../../lib/labels";
import type { DriverDetail } from "../../lib/types";
import { DriverFormModal } from "./DriverFormModal";

function Later({ title }: { title: string }) {
  return (
    <Card>
      <CardHeader title={title} />
      <EmptyState icon="clock" title="قريبًا" description="يتوفر مع الوحدة الخاصة به في Sprint قادم." />
    </Card>
  );
}

export function DriverDetailPage() {
  const { id = "" } = useParams();
  const { can } = useAuth();
  const toast = useToast();
  const confirm = useConfirm();
  const { data, loading, error, reload } = useApi<{ data: DriverDetail }>(`/drivers/${id}`);
  const [editing, setEditing] = useState(false);

  if (loading) return <Loading />;
  if (error || !data) return <EmptyState icon="user" title={error?.status === 404 ? "السائق غير موجود" : "تعذر تحميل السائق"} description={error?.message} action={<Link to="/drivers" className="text-sm text-brand-700">العودة للسائقين</Link>} />;
  const d = data.data;

  const archive = async () => {
    if (!(await confirm({ title: "أرشفة السائق", message: `سيتم أرشفة ملف السائق ${d.fullName}. يبقى سجل الموظف كما هو.`, confirmLabel: "أرشفة", danger: true }))) return;
    try {
      await api(`/drivers/${id}/archive`, { method: "POST" });
      toast.success("تمت أرشفة ملف السائق");
      reload();
    } catch (err) {
      toast.error(errorMessage(err));
    }
  };

  return (
    <>
      <PageHeader
        back={<Link to="/drivers" className="mb-2 inline-flex items-center gap-1 text-sm text-slate-500 hover:text-slate-700"><Icon name="chevron" className="size-4" /> السائقون</Link>}
        title={<span className="flex flex-wrap items-center gap-3">{d.fullName} <StatusBadge map={DRIVER_STATUS} value={d.status} /> {d.archivedAt && <StatusBadge map={{ A: { label: "مؤرشف", tone: "gray" } }} value="A" />}</span>}
        subtitle={<span className="ltr">{d.employeeNumber}</span>}
        actions={
          <>
            {d.capabilities.update && <Button variant="secondary" icon="edit" onClick={() => setEditing(true)}>تعديل</Button>}
            {d.capabilities.archive && <Button variant="danger" icon="archive" onClick={() => void archive()}>أرشفة</Button>}
          </>
        }
      />
      {d.alerts.length > 0 && <div className="mb-6"><AlertList alerts={d.alerts} /></div>}

      <div className="grid grid-cols-1 gap-6 xl:grid-cols-3">
        <Card className="xl:col-span-2">
          <CardHeader title="بيانات الرخصة" />
          <div className="p-5">
            <DescList
              items={[
                { label: "رقم الرخصة", value: d.licenseNumber ? <span className="ltr">{d.licenseNumber}</span> : "—" },
                { label: "نوع الرخصة", value: d.licenseType ? LICENSE_TYPE[d.licenseType] : "—" },
                { label: "تاريخ الإصدار", value: formatDate(d.licenseIssueDate) },
                { label: "تاريخ الانتهاء", value: <ExpiryDate date={d.licenseExpiryDate} status={d.licenseStatus} daysLeft={d.licenseDaysLeft} /> },
              ]}
            />
            {d.notes && <p className="mt-5 rounded-lg bg-slate-50 p-4 text-sm whitespace-pre-line text-slate-700">{d.notes}</p>}
          </div>
        </Card>
        <Card>
          <CardHeader title="بيانات الموظف" />
          <div className="space-y-3 p-5 text-sm">
            <p>المشروع: <span className="font-medium">{d.projectId && can("projects.read") ? <Link to={`/projects/${d.projectId}`} className="text-brand-700 hover:underline">{d.projectName}</Link> : (d.projectName ?? "—")}</span></p>
            <p>الجوال: <span className="font-medium ltr">{d.phone ?? "—"}</span></p>
            <p>
              المركبة الحالية:{" "}
              {d.currentVehicleId ? <Link to={`/vehicles/${d.currentVehicleId}`} className="font-medium text-brand-700 hover:underline ltr">{d.currentVehiclePlate}</Link> : <span className="font-medium">لا توجد</span>}
            </p>
            {can("employees.read") && <Link to={`/employees/${d.employeeId}`} className="inline-flex items-center gap-1 font-medium text-brand-700 hover:underline">ملف الموظف <Icon name="back" className="size-4" /></Link>}
          </div>
        </Card>
      </div>

      <Card className="mt-6">
        <CardHeader title="سجل المركبات" subtitle="المركبات التي أُسندت لهذا السائق" />
        {d.history.length === 0 ? (
          <EmptyState icon="truck" title="لا يوجد سجل مركبات بعد" />
        ) : (
          <ul className="divide-y divide-slate-100">
            {d.history.map((h) => (
              <li key={h.id} className="flex flex-wrap items-center justify-between gap-2 px-5 py-3 text-sm">
                <span className="font-medium">
                  {h.vehicleId ? <Link to={`/vehicles/${h.vehicleId}`} className="text-brand-700 hover:underline ltr">{h.plateNumber}</Link> : <span className="text-slate-400">مركبة خارج نطاقك</span>}
                </span>
                <span className="text-slate-500">
                  {formatDateTime(h.assignedAt)} ← {h.unassignedAt ? formatDateTime(h.unassignedAt) : <span className="font-medium text-emerald-700">حالية</span>}
                </span>
              </li>
            ))}
          </ul>
        )}
      </Card>

      <div className="mt-6 grid grid-cols-1 gap-6 lg:grid-cols-3">
        <Later title="سجل التسليم والاستلام" />
        <Later title="الحوادث" />
        <Later title="المخالفات" />
      </div>

      <DriverFormModal open={editing} onClose={() => setEditing(false)} driver={d} onSaved={() => reload()} />
    </>
  );
}
