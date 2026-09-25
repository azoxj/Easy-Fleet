import { useState } from "react";
import { ExpiryBadge, FileAttachment } from "../../components/common";
import { useConfirm } from "../../components/feedback";
import { useAction } from "../../components/shared";
import { Alert, Button, Card, CardHeader, EmptyState, Field, Input, Loading, Modal, Select, Textarea } from "../../components/ui";
import { useApi } from "../../hooks/useApi";
import { api } from "../../lib/api";
import { useAuth } from "../../lib/auth";
import { formatDate } from "../../lib/format";
import { EMPLOYEE_DOC_TYPE } from "../../lib/labels";
import type { ExpiryStatus } from "../../lib/types";

type Doc = { id: string; documentType: string; documentNumber: string | null; issueDate: string | null; expiryDate: string | null; notes: string | null; hasFile: boolean; status: ExpiryStatus };

export function EmployeeDocuments({ employeeId, canEdit }: { employeeId: string; canEdit: boolean }) {
  const { can } = useAuth();
  const { data, loading, error, reload } = useApi<{ data: Doc[] }>(`/employees/${employeeId}/documents`);
  const confirm = useConfirm();
  const { busy, run } = useAction();
  const [adding, setAdding] = useState(false);
  const [v, setV] = useState({ documentType: "IQAMA", documentNumber: "", issueDate: "", expiryDate: "", notes: "" });
  const editable = canEdit && can("documents.upload");
  const save = async () => {
    const body = { documentType: v.documentType, ...(v.documentNumber.trim() ? { documentNumber: v.documentNumber.trim() } : {}), ...(v.issueDate ? { issueDate: v.issueDate } : {}), ...(v.expiryDate ? { expiryDate: v.expiryDate } : {}), ...(v.notes.trim() ? { notes: v.notes.trim() } : {}) };
    if (await run("add", () => api(`/employees/${employeeId}/documents`, { method: "POST", body }), "تمت إضافة المستند")) {
      setAdding(false);
      setV({ documentType: "IQAMA", documentNumber: "", issueDate: "", expiryDate: "", notes: "" });
      reload();
    }
  };
  return (
    <Card className="mt-6">
      <CardHeader title="مستندات الموظف" subtitle="الهوية/الإقامة، الجواز، العقد... مع تنبيه قبل الانتهاء" action={editable && <Button variant="secondary" icon="plus" onClick={() => setAdding(true)}>إضافة مستند</Button>} />
      {loading ? <Loading /> : error ? <div className="p-4"><Alert>{error.message}</Alert></div> : !data?.data.length ? <EmptyState icon="file" title="لا توجد مستندات" /> : (
        <ul className="divide-y divide-slate-100">
          {data.data.map((d) => (
            <li key={d.id} className="flex flex-wrap items-center justify-between gap-3 px-5 py-3 text-sm">
              <div className="min-w-0">
                <p className="font-medium">{EMPLOYEE_DOC_TYPE[d.documentType]}{d.documentNumber && <span className="ms-2 text-slate-500 ltr">{d.documentNumber}</span>}</p>
                <p className="mt-0.5 flex flex-wrap items-center gap-2 text-xs text-slate-500">تنتهي: {formatDate(d.expiryDate)} {d.expiryDate && <ExpiryBadge status={d.status} />}</p>
              </div>
              <div className="flex items-center gap-2">
                <FileAttachment fileName={d.hasFile ? "الملف" : null} downloadPath={`/employee-documents/${d.id}/file`} uploadPath={`/employee-documents/${d.id}/file`} canUpload={editable} onUploaded={reload} />
                {can("documents.delete") && <Button variant="ghost" icon="trash" className="px-2 py-1 text-xs text-red-600" loading={busy === d.id} onClick={async () => { if (await confirm({ title: "حذف المستند", message: "سيُحذف المستند (حذف منطقي مع بقاء السجل في التدقيق).", danger: true })) { if (await run(d.id, () => api(`/employee-documents/${d.id}`, { method: "DELETE" }), "تم الحذف")) reload(); } }}>حذف</Button>}
              </div>
            </li>
          ))}
        </ul>
      )}
      <Modal open={adding} onClose={() => setAdding(false)} title="إضافة مستند" footer={<><Button variant="secondary" onClick={() => setAdding(false)}>إلغاء</Button><Button loading={busy === "add"} onClick={save}>حفظ</Button></>}>
        <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
          <Field label="النوع" required htmlFor="ed-type"><Select id="ed-type" value={v.documentType} onChange={(e) => setV({ ...v, documentType: e.target.value })}>{Object.entries(EMPLOYEE_DOC_TYPE).map(([k, l]) => <option key={k} value={k}>{l}</option>)}</Select></Field>
          <Field label="الرقم" htmlFor="ed-no"><Input id="ed-no" dir="ltr" value={v.documentNumber} onChange={(e) => setV({ ...v, documentNumber: e.target.value })} /></Field>
          <Field label="تاريخ الإصدار" htmlFor="ed-issue"><Input id="ed-issue" type="date" value={v.issueDate} onChange={(e) => setV({ ...v, issueDate: e.target.value })} /></Field>
          <Field label="تاريخ الانتهاء" htmlFor="ed-exp"><Input id="ed-exp" type="date" value={v.expiryDate} onChange={(e) => setV({ ...v, expiryDate: e.target.value })} /></Field>
          <div className="sm:col-span-2"><Field label="ملاحظات" htmlFor="ed-notes"><Textarea id="ed-notes" value={v.notes} onChange={(e) => setV({ ...v, notes: e.target.value })} /></Field></div>
        </div>
      </Modal>
    </Card>
  );
}
