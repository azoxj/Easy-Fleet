import { useEffect, useState } from "react";
import { useToast } from "../../components/feedback";
import { Alert, Button, Field, Input, Modal, Select, Textarea } from "../../components/ui";
import { api } from "../../lib/api";
import { clean, errorMessage, fieldErrors } from "../../lib/forms";
import { LICENSE_TYPE } from "../../lib/labels";
import type { DriverDetail } from "../../lib/types";

const empty = { licenseNumber: "", licenseType: "", licenseIssueDate: "", licenseExpiryDate: "", status: "ACTIVE", notes: "" };

type Props = { open: boolean; onClose: () => void; onSaved: (id: string) => void; driver?: DriverDetail | null; employeeId?: string; employeeName?: string };

export function DriverFormModal({ open, onClose, onSaved, driver, employeeId, employeeName }: Props) {
  const toast = useToast();
  const [v, setV] = useState(empty);
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    if (!open) return;
    setErrors({});
    setError(null);
    setV(
      driver
        ? {
            licenseNumber: driver.licenseNumber ?? "",
            licenseType: driver.licenseType ?? "",
            licenseIssueDate: driver.licenseIssueDate ?? "",
            licenseExpiryDate: driver.licenseExpiryDate ?? "",
            status: driver.storedStatus,
            notes: driver.notes ?? "",
          }
        : empty,
    );
  }, [open, driver]);

  const set = (k: keyof typeof empty) => (e: { target: { value: string } }) => setV((s) => ({ ...s, [k]: e.target.value }));

  const save = async () => {
    if (v.licenseIssueDate && v.licenseExpiryDate && v.licenseExpiryDate < v.licenseIssueDate) {
      setErrors({ licenseExpiryDate: "يجب أن يكون بعد تاريخ الإصدار" });
      return;
    }
    setBusy(true);
    setError(null);
    try {
      const c = clean(v);
      const { status, ...license } = c;
      const res = driver
        ? await api<{ data: { id: string } }>(`/drivers/${driver.id}`, { method: "PATCH", body: { ...license, status } })
        : await api<{ data: { id: string } }>("/drivers", { method: "POST", body: { ...license, employeeId } });
      toast.success(driver ? "تم حفظ بيانات السائق" : "تم إنشاء ملف السائق");
      onSaved(res.data.id);
      onClose();
    } catch (err) {
      setErrors(fieldErrors(err));
      setError(errorMessage(err));
    } finally {
      setBusy(false);
    }
  };

  return (
    <Modal open={open} onClose={onClose} title={driver ? "تعديل بيانات السائق" : `ملف سائق — ${employeeName ?? ""}`} footer={<><Button variant="secondary" onClick={onClose}>إلغاء</Button><Button onClick={save} loading={busy}>حفظ</Button></>}>
      <div className="space-y-4">
        {error && <Alert>{error}</Alert>}
        <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
          <Field label="رقم الرخصة" error={errors.licenseNumber} htmlFor="d-num"><Input id="d-num" dir="ltr" value={v.licenseNumber} onChange={set("licenseNumber")} /></Field>
          <Field label="نوع الرخصة" error={errors.licenseType} htmlFor="d-type">
            <Select id="d-type" value={v.licenseType} onChange={set("licenseType")}>
              <option value="">— غير محدد —</option>
              {Object.entries(LICENSE_TYPE).map(([k, l]) => <option key={k} value={k}>{l}</option>)}
            </Select>
          </Field>
          <Field label="تاريخ الإصدار" error={errors.licenseIssueDate} htmlFor="d-issue"><Input id="d-issue" type="date" value={v.licenseIssueDate} onChange={set("licenseIssueDate")} /></Field>
          <Field label="تاريخ الانتهاء" error={errors.licenseExpiryDate} htmlFor="d-exp"><Input id="d-exp" type="date" value={v.licenseExpiryDate} onChange={set("licenseExpiryDate")} /></Field>
          {driver && (
            <Field label="الحالة الإدارية" error={errors.status} htmlFor="d-status" hint="حالة «رخصة منتهية» تُحسب تلقائيًا من تاريخ الانتهاء">
              <Select id="d-status" value={v.status} onChange={set("status")}>
                <option value="ACTIVE">نشط</option>
                <option value="SUSPENDED">موقوف</option>
                <option value="INACTIVE">غير نشط</option>
              </Select>
            </Field>
          )}
        </div>
        <Field label="ملاحظات" error={errors.notes} htmlFor="d-notes"><Textarea id="d-notes" value={v.notes} onChange={set("notes")} /></Field>
      </div>
    </Modal>
  );
}
