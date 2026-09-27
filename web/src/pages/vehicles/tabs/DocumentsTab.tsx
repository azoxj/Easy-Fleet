import { useState } from "react";
import { ExpiryDate, FileAttachment } from "../../../components/common";
import { DataList } from "../../../components/DataList";
import { useConfirm, useToast } from "../../../components/feedback";
import { Icon } from "../../../components/icons";
import { Alert, Button, Card, CardHeader, EmptyState, Field, Input, Loading, Modal, Select, Textarea } from "../../../components/ui";
import { useApi } from "../../../hooks/useApi";
import { api } from "../../../lib/api";
import { useAuth } from "../../../lib/auth";
import { clean, errorMessage, fieldErrors } from "../../../lib/forms";
import { DOCUMENT_TYPE } from "../../../lib/labels";
import type { VehicleDocument } from "../../../lib/types";
import { t } from "../../../i18n";

const OTHER_TYPES = ["LICENSE", "WARRANTY", "OWNERSHIP", "OTHER"];

function DocModal({ onClose, vehicleId, doc, onSaved }: { onClose: () => void; vehicleId: string; doc: VehicleDocument | null; onSaved: () => void }) {
  const toast = useToast();
  const init = { documentType: doc?.documentType ?? "OTHER", documentNumber: doc?.documentNumber ?? "", issuer: doc?.issuer ?? "", issueDate: doc?.issueDate ?? "", expiryDate: doc?.expiryDate ?? "", notes: doc?.notes ?? "" };
  const [v, setV] = useState(init);
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const set = (k: keyof typeof init) => (e: { target: { value: string } }) => setV((s) => ({ ...s, [k]: e.target.value }));

  const save = async () => {
    if (v.issueDate && v.expiryDate && v.expiryDate < v.issueDate) return setErrors({ expiryDate: t("common.mustBeAfterTheIssue") });
    setBusy(true);
    setError(null);
    try {
      const { documentType, ...rest } = clean(v);
      if (doc) await api(`/vehicle-documents/${doc.id}`, { method: "PATCH", body: rest });
      else await api(`/vehicles/${vehicleId}/documents`, { method: "POST", body: { documentType, ...rest } });
      toast.success(doc ? t("vehicleDocuments.documentUpdated") : t("common.documentAdded"));
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
    <Modal open onClose={onClose} title={doc ? t("vehicleDocuments.editDocument") : t("common.addDocument")} footer={<><Button variant="secondary" onClick={onClose}>{t("common.cancel")}</Button><Button onClick={save} loading={busy}>{t("common.save")}</Button></>}>
      <div className="space-y-4">
        {error && <Alert>{error}</Alert>}
        <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
          <Field label={t("vehicleDocuments.documentType")} required htmlFor="d-type" hint={!doc ? t("vehicleDocuments.registrationAndInsuranceHaveTheir") : undefined}>
            <Select id="d-type" value={v.documentType} onChange={set("documentType")} disabled={!!doc}>
              {(doc ? [doc.documentType] : OTHER_TYPES).map((item) => <option key={item} value={item}>{DOCUMENT_TYPE[item]}</option>)}
            </Select>
          </Field>
          <Field label={t("vehicleDocuments.documentNumber")} error={errors.documentNumber} htmlFor="d-num"><Input id="d-num" dir="ltr" value={v.documentNumber} onChange={set("documentNumber")} /></Field>
          <Field label={t("common.issuer")} error={errors.issuer} htmlFor="d-issuer"><Input id="d-issuer" value={v.issuer} onChange={set("issuer")} /></Field>
          <Field label={t("common.issueDate")} error={errors.issueDate} htmlFor="d-issue"><Input id="d-issue" type="date" value={v.issueDate} onChange={set("issueDate")} /></Field>
          <Field label={t("common.expiryDate")} error={errors.expiryDate} htmlFor="d-exp"><Input id="d-exp" type="date" value={v.expiryDate} onChange={set("expiryDate")} /></Field>
        </div>
        <Field label={t("common.notes")} error={errors.notes} htmlFor="d-notes"><Textarea id="d-notes" value={v.notes} onChange={set("notes")} /></Field>
      </div>
    </Modal>
  );
}

export function DocumentsTab({ vehicleId }: { vehicleId: string }) {
  const { can } = useAuth();
  const toast = useToast();
  const confirm = useConfirm();
  const { data, loading, error, reload } = useApi<{ data: VehicleDocument[] }>(`/vehicles/${vehicleId}/documents`);
  const [modal, setModal] = useState<VehicleDocument | "new" | null>(null);
  const canCreate = can("vehicle_documents.create", "PROJECT");
  const canUpdate = (d: VehicleDocument) => d.isCurrent && (d.documentType === "REGISTRATION" ? can("registration.update", "PROJECT") : can("vehicle_documents.update", "PROJECT"));
  const canDelete = can("vehicle_documents.delete", "PROJECT");

  const remove = async (d: VehicleDocument) => {
    if (!(await confirm({ title: t("common.deleteDocument"), message: t("vehicleDocuments.willBeDeletedATrace", { value: DOCUMENT_TYPE[d.documentType], value2: d.documentNumber ? t("vehicleDocuments.number", { documentNumber: d.documentNumber }) : "" }), confirmLabel: t("common.delete"), danger: true }))) return;
    try {
      await api(`/vehicle-documents/${d.id}`, { method: "DELETE" });
      toast.success(t("vehicleDocuments.documentDeleted"));
      reload();
    } catch (err) {
      toast.error(errorMessage(err));
    }
  };

  return (
    <Card>
      <CardHeader title={t("vehicleDocuments.vehicleDocuments")} subtitle={t("vehicleDocuments.theStatusIsCalculatedAutomatically")} action={canCreate && <Button icon="plus" onClick={() => setModal("new")}>{t("common.addDocument")}</Button>} />
      {loading ? <Loading /> : error ? <div className="p-4"><Alert>{error.message}</Alert></div> : !data?.data.length ? (
        <EmptyState icon="file" title={t("common.noDocuments")} />
      ) : (
        <DataList
          rows={data.data}
          rowKey={(d) => d.id}
          columns={[
            { header: t("common.type"), primary: true, cell: (d) => <span className="font-medium">{DOCUMENT_TYPE[d.documentType]} {!d.isCurrent && <span className="text-xs text-slate-400">{t("vehicleDocuments.previous")}</span>}</span> },
            { header: t("common.number"), cell: (d) => (d.documentNumber ? <span className="ltr">{d.documentNumber}</span> : "—") },
            { header: t("common.issuer"), cell: (d) => d.issuer ?? "—", hideOnMobile: true },
            { header: t("common.expiry"), cell: (d) => <ExpiryDate date={d.expiryDate} status={d.expiryDate ? d.status : null} daysLeft={d.daysLeft} /> },
            {
              header: t("common.attachment"),
              cell: (d) => <FileAttachment fileName={d.fileName} downloadPath={`/vehicle-documents/${d.id}/file`} uploadPath={`/vehicle-documents/${d.id}/file`} canUpload={canUpdate(d)} onUploaded={reload} />,
            },
            {
              header: t("vehicleDocuments.actions"),
              cell: (d) => (
                <div className="flex gap-1">
                  {canUpdate(d) && d.documentType !== "REGISTRATION" && (
                    <button onClick={() => setModal(d)} className="rounded p-1.5 text-slate-500 hover:bg-slate-100" aria-label={t("common.edit")}><Icon name="edit" className="size-4" /></button>
                  )}
                  {canDelete && (
                    <button onClick={() => void remove(d)} className="rounded p-1.5 text-red-500 hover:bg-red-50" aria-label={t("common.delete")}><Icon name="trash" className="size-4" /></button>
                  )}
                </div>
              ),
            },
          ]}
        />
      )}
      {modal && <DocModal onClose={() => setModal(null)} vehicleId={vehicleId} doc={modal === "new" ? null : modal} onSaved={reload} />}
    </Card>
  );
}
