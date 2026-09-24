import { useState } from "react";
import { Link, useNavigate, useParams } from "react-router";
import { useConfirm, useToast } from "../../components/feedback";
import { Icon } from "../../components/icons";
import { Button, Card, CardHeader, DescList, EmptyState, Loading, PageHeader, StatusBadge } from "../../components/ui";
import { useApi } from "../../hooks/useApi";
import { api } from "../../lib/api";
import { formatDate, formatDateTime } from "../../lib/format";
import { errorMessage } from "../../lib/forms";
import { EMPLOYEE_STATUS } from "../../lib/labels";
import type { EmployeeDetail } from "../../lib/types";
import { DriverFormModal } from "../drivers/DriverFormModal";
import { EmployeeFormModal } from "./EmployeeFormModal";

export function EmployeeDetailPage() {
  const { id = "" } = useParams();
  const navigate = useNavigate();
  const toast = useToast();
  const confirm = useConfirm();
  const { data, loading, error, reload } = useApi<{ data: EmployeeDetail }>(`/employees/${id}`);
  const [editing, setEditing] = useState(false);
  const [creatingDriver, setCreatingDriver] = useState(false);

  if (loading) return <Loading />;
  if (error || !data) return <EmptyState icon="id" title={error?.status === 404 ? "الموظف غير موجود" : "تعذر تحميل الموظف"} description={error?.message} action={<Link to="/employees" className="text-sm text-brand-700">العودة للموظفين</Link>} />;
  const e = data.data;

  const archive = async () => {
    const ok = await confirm({ title: "أرشفة الموظف", message: `سيتم أرشفة ${e.fullName}${e.driver ? " وملف السائق المرتبط به" : ""}. لا يمكن تعديل الموظف بعد الأرشفة.`, confirmLabel: "أرشفة", danger: true });
    if (!ok) return;
    try {
      await api(`/employees/${id}/archive`, { method: "POST" });
      toast.success("تمت أرشفة الموظف");
      reload();
    } catch (err) {
      toast.error(errorMessage(err));
    }
  };

  return (
    <>
      <PageHeader
        back={<Link to="/employees" className="mb-2 inline-flex items-center gap-1 text-sm text-slate-500 hover:text-slate-700"><Icon name="chevron" className="size-4" /> الموظفون</Link>}
        title={<span className="flex flex-wrap items-center gap-3">{e.fullName} <StatusBadge map={EMPLOYEE_STATUS} value={e.status} /></span>}
        subtitle={<span className="ltr">{e.employeeNumber}</span>}
        actions={
          <>
            {e.capabilities.createDriver && <Button variant="secondary" icon="plus" onClick={() => setCreatingDriver(true)}>إنشاء ملف سائق</Button>}
            {e.capabilities.update && <Button variant="secondary" icon="edit" onClick={() => setEditing(true)}>تعديل</Button>}
            {e.capabilities.archive && <Button variant="danger" icon="archive" onClick={() => void archive()}>أرشفة</Button>}
          </>
        }
      />
      <div className="grid grid-cols-1 gap-6 xl:grid-cols-3">
        <Card className="xl:col-span-2">
          <CardHeader title="بيانات الموظف" />
          <div className="p-5">
            <DescList
              items={[
                { label: "رقم الهوية/الإقامة", value: e.nationalIdOrIqama ? <span className="ltr">{e.nationalIdOrIqama}</span> : "—" },
                { label: "الجوال", value: e.phone ? <span className="ltr">{e.phone}</span> : "—" },
                { label: "البريد الإلكتروني", value: e.email ? <span className="ltr break-all">{e.email}</span> : "—" },
                { label: "المسمى الوظيفي", value: e.jobTitle ?? "—" },
                { label: "المشروع", value: e.projectId ? <Link className="text-brand-700 hover:underline" to={`/projects/${e.projectId}`}>{e.projectName}</Link> : "بدون مشروع" },
                { label: "تاريخ المباشرة", value: formatDate(e.hireDate) },
                { label: "حساب الدخول المرتبط", value: e.linkedUser ? `${e.linkedUser.name}` : "لا يوجد" },
                { label: "آخر تحديث", value: formatDateTime(e.updatedAt) },
              ]}
            />
            {e.notes && <p className="mt-5 rounded-lg bg-slate-50 p-4 text-sm whitespace-pre-line text-slate-700">{e.notes}</p>}
          </div>
        </Card>
        <Card>
          <CardHeader title="ملف السائق" />
          {e.driver ? (
            <div className="space-y-3 p-5 text-sm">
              <p>تاريخ انتهاء الرخصة: <span className="font-medium">{formatDate(e.driver.licenseExpiryDate)}</span></p>
              <p>المركبة الحالية: <span className="font-medium ltr">{e.driver.currentVehiclePlate ?? "—"}</span></p>
              <Link to={`/drivers/${e.driver.id}`} className="inline-flex items-center gap-1 font-medium text-brand-700 hover:underline">عرض ملف السائق <Icon name="back" className="size-4" /></Link>
            </div>
          ) : (
            <EmptyState icon="user" title="ليس سائقًا" description="يمكن إنشاء ملف سائق لهذا الموظف إذا كان يقود مركبات الشركة." />
          )}
        </Card>
      </div>
      <EmployeeFormModal open={editing} onClose={() => setEditing(false)} employee={e} onSaved={() => reload()} />
      <DriverFormModal open={creatingDriver} onClose={() => setCreatingDriver(false)} employeeId={e.id} employeeName={e.fullName} onSaved={(driverId) => navigate(`/drivers/${driverId}`)} />
    </>
  );
}
