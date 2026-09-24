import { useState } from "react";
import { ExpiryDate, FileAttachment } from "../../../components/common";
import { useToast } from "../../../components/feedback";
import { Alert, Button, Card, CardHeader, DescList, EmptyState, Field, Input, Loading, Modal, Select, Textarea } from "../../../components/ui";
import { useApi } from "../../../hooks/useApi";
import { api } from "../../../lib/api";
import { useAuth } from "../../../lib/auth";
import { formatDate, formatMoney } from "../../../lib/format";
import { clean, errorMessage, fieldErrors } from "../../../lib/forms";
import { COVERAGE_TYPE } from "../../../lib/labels";
import type { InsurancePolicy } from "../../../lib/types";

type Data = { current: InsurancePolicy | null; history: InsurancePolicy[] };

function InsuranceModal({ onClose, vehicleId, current, mode, onSaved }: { onClose: () => void; vehicleId: string; current: InsurancePolicy | null; mode: "new" | "edit"; onSaved: () => void }) {
  const toast = useToast();
  const init =
    mode === "edit" && current
      ? { provider: current.provider, policyNumber: current.policyNumber, issueDate: current.issueDate ?? "", expiryDate: current.expiryDate, premiumAmount: current.premiumAmount ?? "", coverageType: current.coverageType, notes: current.notes ?? "" }
      : { provider: current?.provider ?? "", policyNumber: "", issueDate: "", expiryDate: "", premiumAmount: "", coverageType: current?.coverageType ?? "COMPREHENSIVE", notes: "" };
  const [v, setV] = useState(init);
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const set = (k: keyof typeof init) => (e: { target: { value: string } }) => setV((s) => ({ ...s, [k]: e.target.value }));

  const save = async () => {
    const e: Record<string, string> = {};
    if (v.provider.trim().length < 2) e.provider = "مطلوب";
    if (v.policyNumber.trim().length < 2) e.policyNumber = "مطلوب";
    if (!v.expiryDate) e.expiryDate = "مطلوب";
    if (v.issueDate && v.expiryDate && v.expiryDate < v.issueDate) e.expiryDate = "يجب أن يكون بعد تاريخ الإصدار";
    if (v.premiumAmount && !/^\d{1,12}(\.\d{1,2})?$/.test(v.premiumAmount.trim())) e.premiumAmount = "مبلغ غير صالح";
    setErrors(e);
    if (Object.keys(e).length) return;
    setBusy(true);
    setError(null);
    try {
      const body = clean(v);
      if (mode === "edit" && current) await api(`/insurance/${current.id}`, { method: "PATCH", body });
      else await api(`/vehicles/${vehicleId}/insurance`, { method: "POST", body });
      toast.success(mode === "edit" ? "تم تحديث وثيقة التأمين" : current ? "تم تجديد التأمين" : "تمت إضافة وثيقة التأمين");
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
    <Modal open onClose={onClose} size="lg" title={mode === "edit" ? "تعديل وثيقة التأمين" : current ? "تجديد التأمين" : "إضافة وثيقة تأمين"} footer={<><Button variant="secondary" onClick={onClose}>إلغاء</Button><Button onClick={save} loading={busy}>حفظ</Button></>}>
      <div className="space-y-4">
        {error && <Alert>{error}</Alert>}
        {mode === "new" && current && <Alert tone="blue">ستصبح الوثيقة الحالية نسخة سابقة وتبقى في السجل.</Alert>}
        <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-3">
          <Field label="شركة التأمين" required error={errors.provider} htmlFor="i-prov"><Input id="i-prov" value={v.provider} onChange={set("provider")} /></Field>
          <Field label="رقم الوثيقة" required error={errors.policyNumber} htmlFor="i-num"><Input id="i-num" dir="ltr" value={v.policyNumber} onChange={set("policyNumber")} /></Field>
          <Field label="نوع التغطية" required error={errors.coverageType} htmlFor="i-cov">
            <Select id="i-cov" value={v.coverageType} onChange={set("coverageType")}>
              {Object.entries(COVERAGE_TYPE).map(([k, l]) => <option key={k} value={k}>{l}</option>)}
            </Select>
          </Field>
          <Field label="تاريخ الإصدار" error={errors.issueDate} htmlFor="i-issue"><Input id="i-issue" type="date" value={v.issueDate} onChange={set("issueDate")} /></Field>
          <Field label="تاريخ الانتهاء" required error={errors.expiryDate} htmlFor="i-exp"><Input id="i-exp" type="date" value={v.expiryDate} onChange={set("expiryDate")} /></Field>
          <Field label="قيمة القسط (ريال)" error={errors.premiumAmount} htmlFor="i-prem"><Input id="i-prem" dir="ltr" inputMode="decimal" value={v.premiumAmount} onChange={set("premiumAmount")} /></Field>
        </div>
        <Field label="ملاحظات" error={errors.notes} htmlFor="i-notes"><Textarea id="i-notes" value={v.notes} onChange={set("notes")} /></Field>
      </div>
    </Modal>
  );
}

export function InsuranceTab({ vehicleId, onChanged }: { vehicleId: string; onChanged?: () => void }) {
  const { can } = useAuth();
  const { data, loading, error, reload } = useApi<{ data: Data }>(`/vehicles/${vehicleId}/insurance`);
  const [modal, setModal] = useState<"new" | "edit" | null>(null);
  const canCreate = can("insurance.create", "PROJECT");
  const canUpdate = can("insurance.update", "PROJECT");
  if (loading) return <Loading />;
  if (error) return <Alert>{error.message}</Alert>;
  const { current, history } = data!.data;
  const refresh = () => { reload(); onChanged?.(); };

  return (
    <div className="space-y-6">
      <Card>
        <CardHeader
          title="وثيقة التأمين الحالية"
          action={
            <div className="flex gap-2">
              {current && canUpdate && <Button variant="secondary" icon="edit" onClick={() => setModal("edit")}>تعديل</Button>}
              {canCreate && <Button icon="plus" onClick={() => setModal("new")}>{current ? "تجديد" : "إضافة تأمين"}</Button>}
            </div>
          }
        />
        {current ? (
          <div className="space-y-5 p-5">
            <DescList
              items={[
                { label: "شركة التأمين", value: current.provider },
                { label: "رقم الوثيقة", value: <span className="ltr">{current.policyNumber}</span> },
                { label: "نوع التغطية", value: COVERAGE_TYPE[current.coverageType] ?? current.coverageType },
                { label: "تاريخ الإصدار", value: formatDate(current.issueDate) },
                { label: "تاريخ الانتهاء", value: <ExpiryDate date={current.expiryDate} status={current.status} daysLeft={current.daysLeft} /> },
                { label: "قيمة القسط", value: formatMoney(current.premiumAmount) },
              ]}
            />
            {current.notes && <p className="rounded-lg bg-slate-50 p-3 text-sm text-slate-700">{current.notes}</p>}
            <div>
              <p className="mb-1 text-xs text-slate-500">المرفق</p>
              <FileAttachment fileName={current.fileName} downloadPath={`/insurance/${current.id}/file`} uploadPath={`/insurance/${current.id}/file`} canUpload={canUpdate} onUploaded={refresh} />
            </div>
          </div>
        ) : (
          <EmptyState icon="shield" title="لا توجد وثيقة تأمين" description={canCreate ? "أضف وثيقة التأمين لمتابعة تاريخ انتهائها." : undefined} />
        )}
      </Card>
      {history.length > 0 && (
        <Card>
          <CardHeader title="الوثائق السابقة" />
          <ul className="divide-y divide-slate-100">
            {history.map((h) => (
              <li key={h.id} className="flex flex-wrap items-center justify-between gap-2 px-5 py-3 text-sm">
                <span className="font-medium">{h.provider} — <span className="ltr">{h.policyNumber}</span></span>
                <span className="text-slate-500">انتهت/تنتهي {formatDate(h.expiryDate)}</span>
              </li>
            ))}
          </ul>
        </Card>
      )}
      {modal && <InsuranceModal onClose={() => setModal(null)} vehicleId={vehicleId} current={current} mode={modal} onSaved={refresh} />}
    </div>
  );
}
