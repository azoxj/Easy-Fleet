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
import { t } from "../../i18n";

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
    if (await run("add", () => api(`/employees/${employeeId}/documents`, { method: "POST", body }), t("common.documentAdded"))) {
      setAdding(false);
      setV({ documentType: "IQAMA", documentNumber: "", issueDate: "", expiryDate: "", notes: "" });
      reload();
    }
  };
  return (
    <Card className="mt-6">
      <CardHeader title={t("employeeDocuments.employeeDocuments")} subtitle={t("employeeDocuments.idIqamaPassportContractWith")} action={editable && <Button variant="secondary" icon="plus" onClick={() => setAdding(true)}>{t("common.addDocument")}</Button>} />
      {loading ? <Loading /> : error ? <div className="p-4"><Alert>{error.message}</Alert></div> : !data?.data.length ? <EmptyState icon="file" title={t("common.noDocuments")} /> : (
        <ul className="divide-y divide-slate-100">
          {data.data.map((d) => (
            <li key={d.id} className="flex flex-wrap items-center justify-between gap-3 px-5 py-3 text-sm">
              <div className="min-w-0">
                <p className="font-medium">{EMPLOYEE_DOC_TYPE[d.documentType]}{d.documentNumber && <span className="ms-2 text-slate-500 ltr">{d.documentNumber}</span>}</p>
                <p className="mt-0.5 flex flex-wrap items-center gap-2 text-xs text-slate-500">{t("employeeDocuments.expires")} {formatDate(d.expiryDate)} {d.expiryDate && <ExpiryBadge status={d.status} />}</p>
              </div>
              <div className="flex items-center gap-2">
                <FileAttachment fileName={d.hasFile ? t("employeeDocuments.file") : null} downloadPath={`/employee-documents/${d.id}/file`} uploadPath={`/employee-documents/${d.id}/file`} canUpload={editable} onUploaded={reload} />
                {can("documents.delete") && <Button variant="ghost" icon="trash" className="px-2 py-1 text-xs text-red-600" loading={busy === d.id} onClick={async () => { if (await confirm({ title: t("common.deleteDocument"), message: t("employeeDocuments.theDocumentWillBeDeleted"), danger: true })) { if (await run(d.id, () => api(`/employee-documents/${d.id}`, { method: "DELETE" }), t("common.deleted"))) reload(); } }}>{t("common.delete")}</Button>}
              </div>
            </li>
          ))}
        </ul>
      )}
      <Modal open={adding} onClose={() => setAdding(false)} title={t("common.addDocument")} footer={<><Button variant="secondary" onClick={() => setAdding(false)}>{t("common.cancel")}</Button><Button loading={busy === "add"} onClick={save}>{t("common.save")}</Button></>}>
        <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
          <Field label={t("common.type")} required htmlFor="ed-type"><Select id="ed-type" value={v.documentType} onChange={(e) => setV({ ...v, documentType: e.target.value })}>{Object.entries(EMPLOYEE_DOC_TYPE).map(([k, l]) => <option key={k} value={k}>{l}</option>)}</Select></Field>
          <Field label={t("common.number")} htmlFor="ed-no"><Input id="ed-no" dir="ltr" value={v.documentNumber} onChange={(e) => setV({ ...v, documentNumber: e.target.value })} /></Field>
          <Field label={t("common.issueDate")} htmlFor="ed-issue"><Input id="ed-issue" type="date" value={v.issueDate} onChange={(e) => setV({ ...v, issueDate: e.target.value })} /></Field>
          <Field label={t("common.expiryDate")} htmlFor="ed-exp"><Input id="ed-exp" type="date" value={v.expiryDate} onChange={(e) => setV({ ...v, expiryDate: e.target.value })} /></Field>
          <div className="sm:col-span-2"><Field label={t("common.notes")} htmlFor="ed-notes"><Textarea id="ed-notes" value={v.notes} onChange={(e) => setV({ ...v, notes: e.target.value })} /></Field></div>
        </div>
      </Modal>
    </Card>
  );
}
