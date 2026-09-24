import { useState } from "react";
import { ExpiryDate, FileAttachment } from "../../../components/common";
import { useToast } from "../../../components/feedback";
import { Alert, Button, Card, CardHeader, DescList, EmptyState, Field, Input, Loading, Modal, Textarea } from "../../../components/ui";
import { useApi } from "../../../hooks/useApi";
import { api } from "../../../lib/api";
import { useAuth } from "../../../lib/auth";
import { formatDate } from "../../../lib/format";
import { clean, errorMessage, fieldErrors } from "../../../lib/forms";
import type { VehicleDocument } from "../../../lib/types";

type Data = { current: VehicleDocument | null; history: VehicleDocument[] };

function RegistrationModal({ open, onClose, vehicleId, current, mode, onSaved }: { open: boolean; onClose: () => void; vehicleId: string; current: VehicleDocument | null; mode: "new" | "edit"; onSaved: () => void }) {
  const toast = useToast();
  const init = mode === "edit" && current
    ? { documentNumber: current.documentNumber ?? "", issueDate: current.issueDate ?? "", expiryDate: current.expiryDate ?? "", issuer: current.issuer ?? "", notes: current.notes ?? "" }
    : { documentNumber: "", issueDate: "", expiryDate: "", issuer: "", notes: "" };
  const [v, setV] = useState(init);
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const set = (k: keyof typeof init) => (e: { target: { value: string } }) => setV((s) => ({ ...s, [k]: e.target.value }));

  const save = async () => {
    const e: Record<string, string> = {};
    if (v.documentNumber.trim().length < 2) e.documentNumber = "رقم الاستمارة مطلوب";
    if (!v.expiryDate) e.expiryDate = "تاريخ الانتهاء مطلوب";
    if (v.issueDate && v.expiryDate && v.expiryDate < v.issueDate) e.expiryDate = "يجب أن يكون بعد تاريخ الإصدار";
    setErrors(e);
    if (Object.keys(e).length) return;
    setBusy(true);
    setError(null);
    try {
      const body = clean(v);
      if (mode === "edit" && current) await api(`/vehicle-documents/${current.id}`, { method: "PATCH", body });
      else await api(`/vehicles/${vehicleId}/registration`, { method: "POST", body });
      toast.success(mode === "edit" ? "تم تحديث الاستمارة" : current ? "تم تجديد الاستمارة" : "تمت إضافة الاستمارة");
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
    <Modal open={open} onClose={onClose} title={mode === "edit" ? "تعديل الاستمارة" : current ? "تجديد الاستمارة" : "إضافة استمارة"} footer={<><Button variant="secondary" onClick={onClose}>إلغاء</Button><Button onClick={save} loading={busy}>حفظ</Button></>}>
      <div className="space-y-4">
        {error && <Alert>{error}</Alert>}
        {mode === "new" && current && <Alert tone="blue">ستصبح الاستمارة الحالية نسخة سابقة وتبقى في السجل.</Alert>}
        <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
          <Field label="رقم الاستمارة" required error={errors.documentNumber} htmlFor="r-num"><Input id="r-num" dir="ltr" value={v.documentNumber} onChange={set("documentNumber")} /></Field>
          <Field label="جهة الإصدار" error={errors.issuer} htmlFor="r-issuer"><Input id="r-issuer" value={v.issuer} onChange={set("issuer")} /></Field>
          <Field label="تاريخ الإصدار" error={errors.issueDate} htmlFor="r-issue"><Input id="r-issue" type="date" value={v.issueDate} onChange={set("issueDate")} /></Field>
          <Field label="تاريخ الانتهاء" required error={errors.expiryDate} htmlFor="r-exp"><Input id="r-exp" type="date" value={v.expiryDate} onChange={set("expiryDate")} /></Field>
        </div>
        <Field label="ملاحظات" error={errors.notes} htmlFor="r-notes"><Textarea id="r-notes" value={v.notes} onChange={set("notes")} /></Field>
        <p className="text-xs text-slate-500">يمكن إرفاق صورة الاستمارة بعد الحفظ.</p>
      </div>
    </Modal>
  );
}

export function RegistrationTab({ vehicleId, onChanged }: { vehicleId: string; onChanged?: () => void }) {
  const { can } = useAuth();
  const { data, loading, error, reload } = useApi<{ data: Data }>(`/vehicles/${vehicleId}/registration`);
  const [modal, setModal] = useState<"new" | "edit" | null>(null);
  const canCreate = can("registration.create", "PROJECT");
  const canUpdate = can("registration.update", "PROJECT");
  if (loading) return <Loading />;
  if (error) return <Alert>{error.message}</Alert>;
  const { current, history } = data!.data;
  const refresh = () => { reload(); onChanged?.(); };

  return (
    <div className="space-y-6">
      <Card>
        <CardHeader
          title="الاستمارة الحالية"
          action={
            <div className="flex gap-2">
              {current && canUpdate && <Button variant="secondary" icon="edit" onClick={() => setModal("edit")}>تعديل</Button>}
              {canCreate && <Button icon="plus" onClick={() => setModal("new")}>{current ? "تجديد" : "إضافة استمارة"}</Button>}
            </div>
          }
        />
        {current ? (
          <div className="space-y-5 p-5">
            <DescList
              items={[
                { label: "رقم الاستمارة", value: <span className="ltr">{current.documentNumber}</span> },
                { label: "تاريخ الإصدار", value: formatDate(current.issueDate) },
                { label: "تاريخ الانتهاء", value: <ExpiryDate date={current.expiryDate} status={current.status} daysLeft={current.daysLeft} /> },
                { label: "جهة الإصدار", value: current.issuer ?? "—" },
                { label: "أضيفت بواسطة", value: current.createdByName ?? "—" },
              ]}
            />
            {current.notes && <p className="rounded-lg bg-slate-50 p-3 text-sm text-slate-700">{current.notes}</p>}
            <div>
              <p className="mb-1 text-xs text-slate-500">المرفق</p>
              <FileAttachment fileName={current.fileName} downloadPath={`/vehicle-documents/${current.id}/file`} uploadPath={`/vehicle-documents/${current.id}/file`} canUpload={canUpdate} onUploaded={refresh} />
            </div>
          </div>
        ) : (
          <EmptyState icon="file" title="لا توجد استمارة مسجلة" description={canCreate ? "أضف بيانات الاستمارة لمتابعة تاريخ انتهائها." : undefined} />
        )}
      </Card>
      {history.length > 0 && (
        <Card>
          <CardHeader title="النسخ السابقة" />
          <ul className="divide-y divide-slate-100">
            {history.map((h) => (
              <li key={h.id} className="flex flex-wrap items-center justify-between gap-2 px-5 py-3 text-sm">
                <span className="font-medium ltr">{h.documentNumber}</span>
                <span className="text-slate-500">انتهت/تنتهي {formatDate(h.expiryDate)}</span>
                <FileAttachment fileName={h.fileName} downloadPath={`/vehicle-documents/${h.id}/file`} uploadPath="" canUpload={false} onUploaded={() => undefined} />
              </li>
            ))}
          </ul>
        </Card>
      )}
      {modal && <RegistrationModal open onClose={() => setModal(null)} vehicleId={vehicleId} current={current} mode={modal} onSaved={refresh} />}
    </div>
  );
}
