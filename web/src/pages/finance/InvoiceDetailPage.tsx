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
    if (!receipt) return setError("ارفع إيصال التحويل أولًا");
    if (!v.bank.trim() || !v.reference.trim()) return setError("البنك ورقم المرجع مطلوبان");
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
    <Modal open onClose={onClose} title={`تسجيل تحويل ${invLabel(inv.number)}`} footer={<><Button variant="secondary" onClick={onClose}>إلغاء</Button><Button loading={busy} onClick={submit}>تأكيد التحويل</Button></>}>
      <div className="space-y-4">
        {error && <Alert>{error}</Alert>}
        <Field label="إيصال التحويل" required>
          <input ref={file} type="file" accept="application/pdf,image/png,image/jpeg,image/webp" className="hidden" onChange={(e) => void upload(e.target.files?.[0])} />
          <div className="flex items-center gap-2">
            <Button variant="secondary" icon="plus" onClick={() => file.current?.click()} loading={busy && !receipt}>{receipt ? "تغيير الإيصال" : "رفع الإيصال"}</Button>
            {receipt && <span className="text-sm text-emerald-700">✓ {receipt.name}</span>}
          </div>
        </Field>
        <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
          <Field label="تاريخ التحويل" required htmlFor="t-date"><Input id="t-date" type="date" max={todayIso()} value={v.transferDate} onChange={set("transferDate")} /></Field>
          <Field label="المبلغ المحول" required htmlFor="t-amount" hint={`لا يتجاوز ${inv.total} ريال`}><Input id="t-amount" dir="ltr" value={v.amount} onChange={set("amount")} /></Field>
          <Field label="البنك" required htmlFor="t-bank"><Input id="t-bank" value={v.bank} onChange={set("bank")} /></Field>
          <Field label="رقم المرجع" required htmlFor="t-ref"><Input id="t-ref" dir="ltr" value={v.reference} onChange={set("reference")} /></Field>
        </div>
        <Field label="ملاحظات" htmlFor="t-notes"><Textarea id="t-notes" value={v.notes} onChange={set("notes")} /></Field>
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
  if (error || !data) return <Alert>{error?.message ?? "تعذر التحميل"}</Alert>;
  const inv = data.data;
  const has = (a: string) => inv.actions.includes(a);
  const act = async (path: string, label: string, question?: string) => {
    if (question && !(await confirm({ title: label, message: question }))) return;
    if (await run(path, () => api(`/invoices/${inv.id}/${path}`, { method: "POST" }), `تم: ${label}`)) reload();
  };
  const stepIdx = STEPS.indexOf(inv.status === "APPROVED" ? "TRANSFER_PENDING" : inv.status);

  return (
    <>
      <PageHeader
        back={<BackLink to="/finance/invoices" label="الفواتير" />}
        title={<span className="flex flex-wrap items-center gap-3"><span className="ltr">{invLabel(inv.number)}</span><StatusBadge map={INVOICE_STATUS} value={inv.status} />{inv.overdue && <Badge tone="red">متأخرة</Badge>}</span>}
        subtitle={inv.description ?? inv.projectName}
        actions={
          <>
            {has("edit") && <Button variant="secondary" icon="edit" onClick={() => { setEdit({ amount: inv.amount, tax: inv.tax, description: inv.description ?? "", dueDate: inv.dueDate ?? "" }); setEditing(true); }}>تعديل</Button>}
            {has("submit") && <Button icon="check" loading={busy === "submit"} onClick={() => act("submit", "تقديم الفاتورة", "سيتم إرسال الفاتورة للمالية للمراجعة.")}>تقديم للمراجعة</Button>}
            {has("startReview") && <Button variant="secondary" loading={busy === "start-review"} onClick={() => act("start-review", "بدء المراجعة")}>بدء المراجعة</Button>}
            {has("approve") && <Button icon="check" loading={busy === "approve"} onClick={() => act("approve", "اعتماد الفاتورة", "بعد الاعتماد تنتقل الفاتورة إلى «بانتظار التحويل».")}>اعتماد</Button>}
            {has("reject") && <Button variant="danger" onClick={() => setRejecting(true)}>رفض</Button>}
            {has("transfer") && <Button icon="receipt" onClick={() => setTransfer(true)}>تسجيل التحويل</Button>}
            {has("markPaid") && <Button variant="secondary" loading={busy === "mark-paid"} onClick={() => act("mark-paid", "إغلاق كمدفوعة")}>إغلاق كمدفوعة</Button>}
            {has("cancel") && <Button variant="ghost" loading={busy === "cancel"} onClick={() => act("cancel", "إلغاء الفاتورة", "لا يمكن التراجع عن الإلغاء.")}>إلغاء</Button>}
          </>
        }
      />
      {inv.status !== "REJECTED" && inv.status !== "CANCELLED" && (
        <ol className="mb-6 flex flex-wrap gap-2" aria-label="مراحل الفاتورة">
          {STEPS.map((s, i) => (
            <li key={s} className={`rounded-full px-3 py-1 text-xs font-medium ${i <= stepIdx ? "bg-brand-700 text-white" : "bg-slate-100 text-slate-500"}`}>{INVOICE_STATUS[s]!.label}</li>
          ))}
        </ol>
      )}
      {inv.status === "REJECTED" && inv.rejectionReason && <div className="mb-4"><Alert>سبب الرفض: {inv.rejectionReason}</Alert></div>}
      <div className="grid grid-cols-1 gap-6 lg:grid-cols-3">
        <div className="space-y-6 lg:col-span-2">
          <Card>
            <CardHeader title="بيانات الفاتورة" />
            <div className="p-5">
              <DescList
                items={[
                  { label: "المشروع", value: inv.projectName },
                  { label: "المورد", value: inv.vendorName },
                  { label: "رقم فاتورة المورد", value: inv.invoiceNumber ? <span className="ltr">{inv.invoiceNumber}</span> : null },
                  { label: "المركبة", value: inv.plateNumber ? <span className="ltr">{inv.plateNumber}</span> : null },
                  { label: "المبلغ", value: <Money value={inv.amount} /> },
                  { label: "الضريبة", value: <Money value={inv.tax} /> },
                  { label: "الإجمالي", value: <b><Money value={inv.total} /></b> },
                  { label: "تاريخ الفاتورة", value: formatDate(inv.invoiceDate) },
                  { label: "الاستحقاق", value: formatDate(inv.dueDate) },
                  { label: "المنشئ", value: inv.createdByName },
                ]}
              />
              <div className="mt-5 border-t border-slate-100 pt-4">
                <p className="mb-2 text-xs text-slate-500">ملف الفاتورة</p>
                <FileAttachment fileName={inv.fileName} downloadPath={`/invoices/${inv.id}/file`} uploadPath={`/invoices/${inv.id}/file`} canUpload={has("upload")} onUploaded={reload} />
              </div>
            </div>
          </Card>
          {inv.transfer && (
            <Card>
              <CardHeader title="بيانات التحويل" />
              <div className="p-5">
                <DescList
                  items={[
                    { label: "تاريخ التحويل", value: formatDate(inv.transfer.transferDate) },
                    { label: "المبلغ", value: <Money value={inv.transfer.amount} /> },
                    { label: "البنك", value: inv.transfer.bank },
                    { label: "رقم المرجع", value: <span className="ltr">{inv.transfer.reference}</span> },
                    { label: "بواسطة", value: `${inv.transfer.createdByName} — ${formatDateTime(inv.transfer.createdAt)}` },
                    { label: "ملاحظات", value: inv.transfer.notes },
                  ]}
                />
                <div className="mt-4"><FileAttachment fileName="إيصال التحويل" downloadPath={`/invoices/${inv.id}/receipt`} uploadPath="" canUpload={false} onUploaded={() => undefined} /></div>
              </div>
            </Card>
          )}
        </div>
        <Card>
          <CardHeader title="السجل" />
          <div className="p-5"><RecordTimeline rows={inv.timeline.map((t) => ({ ...t, userName: t.actor, oldValue: null, newValue: null }) as AuditRow)} /></div>
        </Card>
      </div>
      <ReasonModal open={rejecting} title="رفض الفاتورة" danger confirmLabel="رفض" onClose={() => setRejecting(false)} onSubmit={async (reason) => { await api(`/invoices/${inv.id}/reject`, { method: "POST", body: { reason } }); reload(); }} />
      {transfer && <TransferModal inv={inv} onClose={() => setTransfer(false)} onDone={reload} />}
      <Modal open={editing} onClose={() => setEditing(false)} title="تعديل الفاتورة" footer={<><Button variant="secondary" onClick={() => setEditing(false)}>إلغاء</Button><Button loading={busy === "edit"} onClick={async () => { if (await run("edit", () => api(`/invoices/${inv.id}`, { method: "PATCH", body: { amount: edit.amount, tax: edit.tax || "0", description: edit.description || null, dueDate: edit.dueDate || null } }), "تم حفظ التعديل")) { setEditing(false); reload(); } }}>حفظ</Button></>}>
        <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
          <Field label="المبلغ" htmlFor="e-amount"><Input id="e-amount" dir="ltr" value={edit.amount} onChange={(e) => setEdit({ ...edit, amount: e.target.value })} /></Field>
          <Field label="الضريبة" htmlFor="e-tax"><Input id="e-tax" dir="ltr" value={edit.tax} onChange={(e) => setEdit({ ...edit, tax: e.target.value })} /></Field>
          <Field label="الاستحقاق" htmlFor="e-due"><Input id="e-due" type="date" value={edit.dueDate} onChange={(e) => setEdit({ ...edit, dueDate: e.target.value })} /></Field>
          <div className="sm:col-span-2"><Field label="الوصف" htmlFor="e-desc"><Textarea id="e-desc" value={edit.description} onChange={(e) => setEdit({ ...edit, description: e.target.value })} /></Field></div>
        </div>
      </Modal>
    </>
  );
}
