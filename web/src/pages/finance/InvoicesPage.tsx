import { useEffect, useState } from "react";
import { Link, useNavigate, useSearchParams } from "react-router";
import { DataList } from "../../components/DataList";
import { useToast } from "../../components/feedback";
import { DateRange, FilterBar, Money, ProjectSelect, todayIso, useProjects } from "../../components/shared";
import { Alert, Badge, Button, Card, EmptyState, Field, Input, Loading, Modal, PageHeader, Pagination, Select, StatusBadge, Textarea } from "../../components/ui";
import { useApi } from "../../hooks/useApi";
import { api, type Paged } from "../../lib/api";
import { useAuth } from "../../lib/auth";
import { formatDate } from "../../lib/format";
import { errorMessage, fieldErrors } from "../../lib/forms";
import { INVOICE_STATUS } from "../../lib/labels";
import type { InvoiceRow, Vehicle, Vendor } from "../../lib/types";

export const invLabel = (n: number) => `INV-${n}`;

export function CreateInvoiceModal({ open, onClose, onCreated, maintenanceRequestId }: { open: boolean; onClose: () => void; onCreated: (id: string) => void; maintenanceRequestId?: string }) {
  const toast = useToast();
  const projects = useProjects();
  const empty = { projectId: "", vehicleId: "", vendorId: "", invoiceNumber: "", description: "", amount: "", tax: "", invoiceDate: todayIso(), dueDate: "" };
  const [v, setV] = useState(empty);
  const [vehicles, setVehicles] = useState<Vehicle[]>([]);
  const [vendors, setVendors] = useState<Vendor[]>([]);
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    if (!open) return;
    setV(empty);
    setErrors({});
    setError(null);
    api<{ data: Vendor[] }>("/vendors").then((r) => setVendors(r.data)).catch(() => setVendors([]));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);
  useEffect(() => {
    if (!v.projectId) return setVehicles([]);
    api<Paged<Vehicle>>("/vehicles", { query: { projectId: v.projectId, pageSize: 100 } }).then((r) => setVehicles(r.data)).catch(() => setVehicles([]));
  }, [v.projectId]);
  const set = (k: keyof typeof v) => (e: { target: { value: string } }) => setV((s) => ({ ...s, [k]: e.target.value }));
  const total = (Number(v.amount || 0) + Number(v.tax || 0)).toFixed(2);

  const save = async () => {
    const e: Record<string, string> = {};
    if (!maintenanceRequestId && !v.projectId) e.projectId = "اختر المشروع";
    if (!/^\d+(\.\d{1,2})?$/.test(v.amount)) e.amount = "أدخل مبلغًا صحيحًا";
    if (v.tax && !/^\d+(\.\d{1,2})?$/.test(v.tax)) e.tax = "ضريبة غير صحيحة";
    if (!v.invoiceDate) e.invoiceDate = "التاريخ مطلوب";
    setErrors(e);
    if (Object.keys(e).length) return;
    setBusy(true);
    setError(null);
    try {
      const body: Record<string, unknown> = { amount: v.amount, invoiceDate: v.invoiceDate };
      if (maintenanceRequestId) body.maintenanceRequestId = maintenanceRequestId;
      else body.projectId = v.projectId;
      if (v.tax) body.tax = v.tax;
      if (v.vehicleId) body.vehicleId = v.vehicleId;
      if (v.vendorId) body.vendorId = v.vendorId;
      if (v.invoiceNumber.trim()) body.invoiceNumber = v.invoiceNumber.trim();
      if (v.description.trim()) body.description = v.description.trim();
      if (v.dueDate) body.dueDate = v.dueDate;
      const r = await api<{ data: { id: string } }>("/invoices", { method: "POST", body });
      toast.success("تم إنشاء الفاتورة كمسودة — أرفق ملفها ثم قدّمها");
      onCreated(r.data.id);
      onClose();
    } catch (err) {
      setErrors(fieldErrors(err));
      setError(errorMessage(err));
    } finally {
      setBusy(false);
    }
  };

  return (
    <Modal open={open} onClose={onClose} title="فاتورة جديدة" size="lg" footer={<><Button variant="secondary" onClick={onClose}>إلغاء</Button><Button loading={busy} onClick={save}>حفظ كمسودة</Button></>}>
      <div className="space-y-4">
        {error && <Alert>{error}</Alert>}
        <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
          {!maintenanceRequestId && (
            <Field label="المشروع" required error={errors.projectId} htmlFor="inv-project">
              <ProjectSelect id="inv-project" value={v.projectId} onChange={(x) => setV((s) => ({ ...s, projectId: x, vehicleId: "" }))} projects={projects} all="اختر المشروع..." />
            </Field>
          )}
          {!maintenanceRequestId && (
            <Field label="المركبة (اختياري)" htmlFor="inv-vehicle">
              <Select id="inv-vehicle" value={v.vehicleId} onChange={set("vehicleId")} disabled={!v.projectId}>
                <option value="">—</option>
                {vehicles.map((x) => <option key={x.id} value={x.id}>{x.plateNumber}</option>)}
              </Select>
            </Field>
          )}
          <Field label="المورد" htmlFor="inv-vendor">
            <Select id="inv-vendor" value={v.vendorId} onChange={set("vendorId")}>
              <option value="">—</option>
              {vendors.map((x) => <option key={x.id} value={x.id}>{x.name}</option>)}
            </Select>
          </Field>
          <Field label="رقم فاتورة المورد" error={errors.invoiceNumber} htmlFor="inv-no"><Input id="inv-no" dir="ltr" value={v.invoiceNumber} onChange={set("invoiceNumber")} maxLength={60} /></Field>
          <Field label="المبلغ قبل الضريبة" required error={errors.amount} htmlFor="inv-amount"><Input id="inv-amount" dir="ltr" inputMode="decimal" value={v.amount} onChange={set("amount")} /></Field>
          <Field label="الضريبة" error={errors.tax} htmlFor="inv-tax" hint={`الإجمالي: ${total} ريال (يُحسب في الخادم)`}><Input id="inv-tax" dir="ltr" inputMode="decimal" value={v.tax} onChange={set("tax")} /></Field>
          <Field label="تاريخ الفاتورة" required error={errors.invoiceDate} htmlFor="inv-date"><Input id="inv-date" type="date" value={v.invoiceDate} onChange={set("invoiceDate")} /></Field>
          <Field label="تاريخ الاستحقاق" error={errors.dueDate} htmlFor="inv-due"><Input id="inv-due" type="date" value={v.dueDate} onChange={set("dueDate")} /></Field>
        </div>
        <Field label="الوصف" error={errors.description} htmlFor="inv-desc"><Textarea id="inv-desc" value={v.description} onChange={set("description")} /></Field>
      </div>
    </Modal>
  );
}

export function InvoicesPage() {
  const { can } = useAuth();
  const navigate = useNavigate();
  const [params] = useSearchParams();
  const projects = useProjects();
  const init = { q: "", status: params.get("status") ?? "", projectId: "", overdue: params.get("overdue") ?? "", mine: "", from: "", to: "" };
  const [f, setF] = useState(init);
  const [page, setPage] = useState(1);
  const [creating, setCreating] = useState(false);
  const { data, loading, error } = useApi<Paged<InvoiceRow>>("/invoices", { ...f, page, pageSize: 20 });
  const upd = (k: keyof typeof f, v: string) => { setF((s) => ({ ...s, [k]: v })); setPage(1); };
  const active = Object.entries(f).filter(([k, v]) => k !== "q" && v).length;

  return (
    <>
      <PageHeader title="الفواتير" subtitle="دورة الفاتورة: مسودة ← مقدمة ← مراجعة ← اعتماد ← تحويل ← مدفوعة" actions={can("invoices.create") && <Button icon="plus" onClick={() => setCreating(true)}>فاتورة جديدة</Button>} />
      <Card>
        <FilterBar q={f.q} onQ={(v) => upd("q", v)} placeholder="بحث: INV-رقم، رقم فاتورة المورد، المورد، الوصف" active={active} onClear={() => { setF({ ...init, q: f.q, status: "", overdue: "" }); setPage(1); }}>
          <Select value={f.status} onChange={(e) => upd("status", e.target.value)} aria-label="الحالة">
            <option value="">كل الحالات</option>
            {Object.entries(INVOICE_STATUS).map(([k, l]) => <option key={k} value={k}>{l.label}</option>)}
          </Select>
          {projects.length > 0 && <ProjectSelect value={f.projectId} onChange={(v) => upd("projectId", v)} projects={projects} />}
          <Select value={f.overdue} onChange={(e) => upd("overdue", e.target.value)} aria-label="التأخير">
            <option value="">الكل</option>
            <option value="true">المتأخرة فقط</option>
          </Select>
          <Select value={f.mine} onChange={(e) => upd("mine", e.target.value)} aria-label="المنشئ">
            <option value="">كل الفواتير</option>
            <option value="true">فواتيري</option>
          </Select>
          <DateRange from={f.from} to={f.to} onFrom={(v) => upd("from", v)} onTo={(v) => upd("to", v)} />
        </FilterBar>
        {loading ? <Loading /> : error ? <div className="p-4"><Alert>{error.message}</Alert></div> : !data?.data.length ? (
          <EmptyState icon="receipt" title="لا توجد فواتير" description={active || f.q ? "جرّب تغيير معايير البحث" : "لا توجد فواتير ضمن نطاقك"} />
        ) : (
          <>
            <DataList
              rows={data.data}
              rowKey={(r) => r.id}
              onRowClick={(r) => navigate(`/finance/invoices/${r.id}`)}
              columns={[
                { header: "الفاتورة", primary: true, cell: (r) => <span className="flex flex-wrap items-center gap-2"><Link to={`/finance/invoices/${r.id}`} onClick={(e) => e.stopPropagation()} className="font-semibold text-slate-900 ltr hover:text-brand-700">{invLabel(r.number)}</Link><span className="text-slate-600">{r.description ?? r.vendorName ?? ""}</span></span> },
                { header: "المشروع", cell: (r) => r.projectName },
                { header: "المورد", cell: (r) => r.vendorName ?? "—", hideOnMobile: true },
                { header: "الإجمالي", cell: (r) => <Money value={r.total} /> },
                { header: "الحالة", cell: (r) => <span className="flex items-center gap-1"><StatusBadge map={INVOICE_STATUS} value={r.status} />{r.overdue && <Badge tone="red">متأخرة</Badge>}</span> },
                { header: "الاستحقاق", cell: (r) => formatDate(r.dueDate), hideOnMobile: true },
                { header: "المنشئ", cell: (r) => r.createdByName, hideOnMobile: true },
              ]}
            />
            <Pagination {...data.meta} onPage={setPage} />
          </>
        )}
      </Card>
      <CreateInvoiceModal open={creating} onClose={() => setCreating(false)} onCreated={(id) => navigate(`/finance/invoices/${id}`)} />
    </>
  );
}
