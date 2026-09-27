import { useRef, useState } from "react";
import { useParams } from "react-router";
import { FileAttachment } from "../../components/common";
import { useConfirm } from "../../components/feedback";
import { BackLink, Money, ReasonModal, RecordTimeline, todayIso, useAction, type AuditRow } from "../../components/shared";
import { Alert, Badge, Button, Card, CardHeader, DescList, Field, Input, Loading, Modal, PageHeader, StatusBadge, Textarea } from "../../components/ui";
import { useApi } from "../../hooks/useApi";
import { api, apiUpload } from "../../lib/api";
import { formatDate, formatDateTime } from "../../lib/format";
import { errorMessage } from "../../lib/forms";
import { INVOICE_STATUS } from "../../lib/labels";
import type { InvoiceDetail } from "../../lib/types";
import { invLabel } from "./InvoicesPage";
import { t } from "../../i18n";

const STEPS = ["DRAFT", "SUBMITTED", "UNDER_REVIEW", "TRANSFER_PENDING", "TRANSFERRED", "PAID"];

function TransferModal({ inv, onClose, onDone }: { inv: InvoiceDetail; onClose: () => void; onDone: () => void }) {
  const file = useRef<HTMLInputElement>(null);
  const [v, setV] = useState({ transferDate: todayIso(), amount: inv.total, bank: "", reference: "", notes: "" });
  const [receipt, setReceipt] = useState<{ id: string; name: string } | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const set = (k: keyof typeof v) => (e: { target: { value: string } }) => setV((s) => ({ ...s, [k]: e.target.value }));
  const upload = async (f: File | undefined) => {
    if (!f) return;
    setBusy(true);
    setError(null);
    try {
      const r = await apiUpload<{ data: { receiptFileId: string } }>(`/invoices/${inv.id}/receipt`, f, fetch, "POST");
      setReceipt({ id: r.data.receiptFileId, name: f.name });
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setBusy(false);
    }
  };
  const submit = async () => {
    if (!receipt) return setError(t("invoiceDetail.uploadTheTransferReceiptFirst"));
    if (!v.bank.trim() || !v.reference.trim()) return setError(t("invoiceDetail.bankAndReferenceNumberAre"));
    setBusy(true);
    setError(null);
    try {
      await api(`/invoices/${inv.id}/transfer`, { method: "POST", body: { transferDate: v.transferDate, amount: v.amount, bank: v.bank.trim(), reference: v.reference.trim(), receiptFileId: receipt.id, ...(v.notes.trim() ? { notes: v.notes.trim() } : {}) } });
      onDone();
      onClose();
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setBusy(false);
    }
  };
  return (
    <Modal open onClose={onClose} title={t("invoiceDetail.recordTransfer", { number: invLabel(inv.number) })} footer={<><Button variant="secondary" onClick={onClose}>{t("common.cancel")}</Button><Button loading={busy} onClick={submit}>{t("invoiceDetail.confirmTransfer")}</Button></>}>
      <div className="space-y-4">
        {error && <Alert>{error}</Alert>}
        <Field label={t("invoiceDetail.transferReceipt")} required>
          <input ref={file} type="file" accept="application/pdf,image/png,image/jpeg,image/webp" className="hidden" onChange={(e) => void upload(e.target.files?.[0])} />
          <div className="flex items-center gap-2">
            <Button variant="secondary" icon="plus" onClick={() => file.current?.click()} loading={busy && !receipt}>{receipt ? t("invoiceDetail.changeReceipt") : t("invoiceDetail.uploadReceipt")}</Button>
            {receipt && <span className="text-sm text-emerald-700">✓ {receipt.name}</span>}
          </div>
        </Field>
        <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
          <Field label={t("invoiceDetail.transferDate")} required htmlFor="t-date"><Input id="t-date" type="date" max={todayIso()} value={v.transferDate} onChange={set("transferDate")} /></Field>
          <Field label={t("invoiceDetail.amountTransferred")} required htmlFor="t-amount" hint={t("invoiceDetail.mustNotExceedSar", { total: inv.total })}><Input id="t-amount" dir="ltr" value={v.amount} onChange={set("amount")} /></Field>
          <Field label={t("invoiceDetail.bank")} required htmlFor="t-bank"><Input id="t-bank" value={v.bank} onChange={set("bank")} /></Field>
          <Field label={t("invoiceDetail.referenceNumber")} required htmlFor="t-ref"><Input id="t-ref" dir="ltr" value={v.reference} onChange={set("reference")} /></Field>
        </div>
        <Field label={t("common.notes")} htmlFor="t-notes"><Textarea id="t-notes" value={v.notes} onChange={set("notes")} /></Field>
      </div>
    </Modal>
  );
}

export function InvoiceDetailPage() {
  const { id } = useParams();
  const { data, loading, error, reload } = useApi<{ data: InvoiceDetail }>(`/invoices/${id}`);
  const confirm = useConfirm();
  const { busy, run } = useAction();
  const [rejecting, setRejecting] = useState(false);
  const [transfer, setTransfer] = useState(false);
  const [editing, setEditing] = useState(false);
  const [edit, setEdit] = useState({ amount: "", tax: "", description: "", dueDate: "" });
  if (loading) return <Loading />;
  if (error || !data) return <Alert>{error?.message ?? t("common.couldNotLoad")}</Alert>;
  const inv = data.data;
  const has = (a: string) => inv.actions.includes(a);
  const act = async (path: string, label: string, question?: string) => {
    if (question && !(await confirm({ title: label, message: question }))) return;
    if (await run(path, () => api(`/invoices/${inv.id}/${path}`, { method: "POST" }), t("invoiceDetail.done", { label }))) reload();
  };
  const stepIdx = STEPS.indexOf(inv.status === "APPROVED" ? "TRANSFER_PENDING" : inv.status);

  return (
    <>
      <PageHeader
        back={<BackLink to="/finance/invoices" label={t("common.invoices")} />}
        title={<span className="flex flex-wrap items-center gap-3"><span className="ltr">{invLabel(inv.number)}</span><StatusBadge map={INVOICE_STATUS} value={inv.status} />{inv.overdue && <Badge tone="red">{t("common.overdue")}</Badge>}</span>}
        subtitle={inv.description ?? inv.projectName}
        actions={
          <>
            {has("edit") && <Button variant="secondary" icon="edit" onClick={() => { setEdit({ amount: inv.amount, tax: inv.tax, description: inv.description ?? "", dueDate: inv.dueDate ?? "" }); setEditing(true); }}>{t("common.edit")}</Button>}
            {has("submit") && <Button icon="check" loading={busy === "submit"} onClick={() => act("submit", t("invoiceDetail.submitInvoice"), t("invoiceDetail.theInvoiceWillBeSent"))}>{t("invoiceDetail.submitForReview")}</Button>}
            {has("startReview") && <Button variant="secondary" loading={busy === "start-review"} onClick={() => act("start-review", t("common.startReview"))}>{t("common.startReview")}</Button>}
            {has("approve") && <Button icon="check" loading={busy === "approve"} onClick={() => act("approve", t("invoiceDetail.approveInvoice"), t("invoiceDetail.afterApprovalTheInvoiceMoves"))}>{t("common.approve")}</Button>}
            {has("reject") && <Button variant="danger" onClick={() => setRejecting(true)}>{t("common.reject")}</Button>}
            {has("transfer") && <Button icon="receipt" onClick={() => setTransfer(true)}>{t("invoiceDetail.recordTransfer2")}</Button>}
            {has("markPaid") && <Button variant="secondary" loading={busy === "mark-paid"} onClick={() => act("mark-paid", t("invoiceDetail.closeAsPaid"))}>{t("invoiceDetail.closeAsPaid")}</Button>}
            {has("cancel") && <Button variant="ghost" loading={busy === "cancel"} onClick={() => act("cancel", t("invoiceDetail.cancelInvoice"), t("invoiceDetail.cancellationCannotBeUndone"))}>{t("common.cancel")}</Button>}
          </>
        }
      />
      {inv.status !== "REJECTED" && inv.status !== "CANCELLED" && (
        <ol className="mb-6 flex flex-wrap gap-2" aria-label={t("invoiceDetail.invoiceStages")}>
          {STEPS.map((s, i) => (
            <li key={s} className={`rounded-full px-3 py-1 text-xs font-medium ${i <= stepIdx ? "bg-brand-700 text-white" : "bg-slate-100 text-slate-500"}`}>{INVOICE_STATUS[s]!.label}</li>
          ))}
        </ol>
      )}
      {inv.status === "REJECTED" && inv.rejectionReason && <div className="mb-4"><Alert>{t("invoiceDetail.rejectionReason", { rejectionReason: inv.rejectionReason })}</Alert></div>}
      <div className="grid grid-cols-1 gap-6 lg:grid-cols-3">
        <div className="space-y-6 lg:col-span-2">
          <Card>
            <CardHeader title={t("invoiceDetail.invoiceDetails")} />
            <div className="p-5">
              <DescList
                items={[
                  { label: t("common.project"), value: inv.projectName },
                  { label: t("common.vendor"), value: inv.vendorName },
                  { label: t("common.vendorInvoiceNumber"), value: inv.invoiceNumber ? <span className="ltr">{inv.invoiceNumber}</span> : null },
                  { label: t("common.vehicle"), value: inv.plateNumber ? <span className="ltr">{inv.plateNumber}</span> : null },
                  { label: t("common.amount"), value: <Money value={inv.amount} /> },
                  { label: t("common.tax"), value: <Money value={inv.tax} /> },
                  { label: t("common.total"), value: <b><Money value={inv.total} /></b> },
                  { label: t("common.invoiceDate"), value: formatDate(inv.invoiceDate) },
                  { label: t("common.dueDate2"), value: formatDate(inv.dueDate) },
                  { label: t("common.createdBy"), value: inv.createdByName },
                ]}
              />
              <div className="mt-5 border-t border-slate-100 pt-4">
                <p className="mb-2 text-xs text-slate-500">{t("invoiceDetail.invoiceFile")}</p>
                <FileAttachment fileName={inv.fileName} downloadPath={`/invoices/${inv.id}/file`} uploadPath={`/invoices/${inv.id}/file`} canUpload={has("upload")} onUploaded={reload} />
              </div>
            </div>
          </Card>
          {inv.transfer && (
            <Card>
              <CardHeader title={t("invoiceDetail.transferDetails")} />
              <div className="p-5">
                <DescList
                  items={[
                    { label: t("invoiceDetail.transferDate"), value: formatDate(inv.transfer.transferDate) },
                    { label: t("common.amount"), value: <Money value={inv.transfer.amount} /> },
                    { label: t("invoiceDetail.bank"), value: inv.transfer.bank },
                    { label: t("invoiceDetail.referenceNumber"), value: <span className="ltr">{inv.transfer.reference}</span> },
                    { label: t("common.by"), value: `${inv.transfer.createdByName} — ${formatDateTime(inv.transfer.createdAt)}` },
                    { label: t("common.notes"), value: inv.transfer.notes },
                  ]}
                />
                <div className="mt-4"><FileAttachment fileName={t("invoiceDetail.transferReceipt")} downloadPath={`/invoices/${inv.id}/receipt`} uploadPath="" canUpload={false} onUploaded={() => undefined} /></div>
              </div>
            </Card>
          )}
        </div>
        <Card>
          <CardHeader title={t("common.history")} />
          <div className="p-5"><RecordTimeline rows={inv.timeline.map((item) => ({ ...item, userName: item.actor, oldValue: null, newValue: null }) as AuditRow)} /></div>
        </Card>
      </div>
      <ReasonModal open={rejecting} title={t("invoiceDetail.rejectInvoice")} danger confirmLabel={t("common.reject")} onClose={() => setRejecting(false)} onSubmit={async (reason) => { await api(`/invoices/${inv.id}/reject`, { method: "POST", body: { reason } }); reload(); }} />
      {transfer && <TransferModal inv={inv} onClose={() => setTransfer(false)} onDone={reload} />}
      <Modal open={editing} onClose={() => setEditing(false)} title={t("invoiceDetail.editInvoice")} footer={<><Button variant="secondary" onClick={() => setEditing(false)}>{t("common.cancel")}</Button><Button loading={busy === "edit"} onClick={async () => { if (await run("edit", () => api(`/invoices/${inv.id}`, { method: "PATCH", body: { amount: edit.amount, tax: edit.tax || "0", description: edit.description || null, dueDate: edit.dueDate || null } }), t("invoiceDetail.changesSaved"))) { setEditing(false); reload(); } }}>{t("common.save")}</Button></>}>
        <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
          <Field label={t("common.amount")} htmlFor="e-amount"><Input id="e-amount" dir="ltr" value={edit.amount} onChange={(e) => setEdit({ ...edit, amount: e.target.value })} /></Field>
          <Field label={t("common.tax")} htmlFor="e-tax"><Input id="e-tax" dir="ltr" value={edit.tax} onChange={(e) => setEdit({ ...edit, tax: e.target.value })} /></Field>
          <Field label={t("common.dueDate2")} htmlFor="e-due"><Input id="e-due" type="date" value={edit.dueDate} onChange={(e) => setEdit({ ...edit, dueDate: e.target.value })} /></Field>
          <div className="sm:col-span-2"><Field label={t("common.description")} htmlFor="e-desc"><Textarea id="e-desc" value={edit.description} onChange={(e) => setEdit({ ...edit, description: e.target.value })} /></Field></div>
        </div>
      </Modal>
    </>
  );
}
