import { useEffect, useState } from "react";
import { useSearchParams } from "react-router";
import { FileAttachment } from "../../components/common";
import { DataList } from "../../components/DataList";
import { useToast } from "../../components/feedback";
import { DateRange, FilterBar, Money, ProjectSelect, ReasonModal, todayIso, useAction, useProjects } from "../../components/shared";
import { Alert, Button, Card, EmptyState, Field, Input, Loading, Modal, PageHeader, Pagination, Select, StatusBadge, Textarea } from "../../components/ui";
import { useApi } from "../../hooks/useApi";
import { api, type Paged } from "../../lib/api";
import { useAuth } from "../../lib/auth";
import { formatDate } from "../../lib/format";
import { errorMessage, fieldErrors } from "../../lib/forms";
import { COST_CATEGORY, EXPENSE_STATUS } from "../../lib/labels";
import type { ExpenseRow, Vehicle, Vendor } from "../../lib/types";

function CreateExpenseModal({ open, onClose, onCreated, vehicleId, projectId }: { open: boolean; onClose: () => void; onCreated: () => void; vehicleId?: string; projectId?: string }) {
  const toast = useToast();
  const projects = useProjects();
  const empty = { projectId: projectId ?? "", vehicleId: vehicleId ?? "", vendorId: "", category: "OTHER", amount: "", expenseDate: todayIso(), description: "" };
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
    if (!v.projectId || vehicleId) return;
    api<Paged<Vehicle>>("/vehicles", { query: { projectId: v.projectId, pageSize: 100 } }).then((r) => setVehicles(r.data)).catch(() => setVehicles([]));
  }, [v.projectId, vehicleId]);
  const set = (k: keyof typeof v) => (e: { target: { value: string } }) => setV((s) => ({ ...s, [k]: e.target.value }));
  const save = async () => {
    const e: Record<string, string> = {};
    if (!v.projectId) e.projectId = "اختر المشروع";
    if (!/^\d+(\.\d{1,2})?$/.test(v.amount) || Number(v.amount) <= 0) e.amount = "أدخل مبلغًا صحيحًا";
    setErrors(e);
    if (Object.keys(e).length) return;
    setBusy(true);
    try {
      await api("/expenses", { method: "POST", body: { projectId: v.projectId, category: v.category, amount: v.amount, expenseDate: v.expenseDate, ...(v.vehicleId ? { vehicleId: v.vehicleId } : {}), ...(v.vendorId ? { vendorId: v.vendorId } : {}), ...(v.description.trim() ? { description: v.description.trim() } : {}) } });
      toast.success("تم تسجيل المصروف وإرساله للاعتماد");
      onCreated();
      onClose();
    } catch (err) {
      setErrors(fieldErrors(err));
      setError(errorMessage(err));
    } finally {
      setBusy(false);
    }
  };
  return (
    <Modal open={open} onClose={onClose} title="مصروف جديد" footer={<><Button variant="secondary" onClick={onClose}>إلغاء</Button><Button loading={busy} onClick={save}>حفظ</Button></>}>
      <div className="space-y-4">
        {error && <Alert>{error}</Alert>}
        {!projectId && <Field label="المشروع" required error={errors.projectId} htmlFor="x-project"><ProjectSelect id="x-project" value={v.projectId} onChange={(x) => setV((s) => ({ ...s, projectId: x, vehicleId: "" }))} projects={projects} all="اختر المشروع..." /></Field>}
        {!vehicleId && (
          <Field label="المركبة (اختياري)" htmlFor="x-vehicle">
            <Select id="x-vehicle" value={v.vehicleId} onChange={set("vehicleId")} disabled={!v.projectId}>
              <option value="">—</option>
              {vehicles.map((x) => <option key={x.id} value={x.id}>{x.plateNumber}</option>)}
            </Select>
          </Field>
        )}
        <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
          <Field label="الفئة" required htmlFor="x-cat"><Select id="x-cat" value={v.category} onChange={set("category")}>{Object.entries(COST_CATEGORY).map(([k, l]) => <option key={k} value={k}>{l}</option>)}</Select></Field>
          <Field label="المبلغ" required error={errors.amount} htmlFor="x-amount"><Input id="x-amount" dir="ltr" inputMode="decimal" value={v.amount} onChange={set("amount")} /></Field>
          <Field label="التاريخ" required htmlFor="x-date"><Input id="x-date" type="date" max={todayIso()} value={v.expenseDate} onChange={set("expenseDate")} /></Field>
          <Field label="المورد" htmlFor="x-vendor"><Select id="x-vendor" value={v.vendorId} onChange={set("vendorId")}><option value="">—</option>{vendors.map((x) => <option key={x.id} value={x.id}>{x.name}</option>)}</Select></Field>
        </div>
        <Field label="الوصف" htmlFor="x-desc"><Textarea id="x-desc" value={v.description} onChange={set("description")} /></Field>
      </div>
    </Modal>
  );
}

/** Expense list; `vehicleId` embeds it in the vehicle page. */
export function ExpensesList({ vehicleId, projectId, embedded }: { vehicleId?: string; projectId?: string; embedded?: boolean }) {
  const { can, me } = useAuth();
  const projects = useProjects();
  const [params] = useSearchParams();
  const [f, setF] = useState({ status: "", category: "", projectId: projectId ?? "", from: "", to: "" });
  const [page, setPage] = useState(1);
  const [creating, setCreating] = useState(false);
  const [rejecting, setRejecting] = useState<ExpenseRow | null>(null);
  const [open, setOpen] = useState<string | null>(params.get("focus"));
  const { busy, run } = useAction();
  const { data, loading, error, reload } = useApi<Paged<ExpenseRow>>("/expenses", { ...f, vehicleId, page, pageSize: 20 });
  const upd = (k: keyof typeof f, v: string) => { setF((s) => ({ ...s, [k]: v })); setPage(1); };
  const canApprove = can("finance.approve");
  const active = Object.values(f).filter(Boolean).length - (projectId ? 1 : 0);
  const focused = data?.data.find((r) => r.id === open);

  return (
    <Card>
      {!embedded || can("finance.create") ? (
        <div className="flex items-center justify-between gap-2 border-b border-slate-100 px-4 py-3">
          <p className="text-sm text-slate-500">المصروفات اليدوية تدخل التكاليف بعد اعتمادها من المالية.</p>
          {can("finance.create") && <Button icon="plus" onClick={() => setCreating(true)}>مصروف جديد</Button>}
        </div>
      ) : null}
      {!embedded && (
        <FilterBar active={active} onClear={() => { setF({ status: "", category: "", projectId: projectId ?? "", from: "", to: "" }); setPage(1); }}>
          <Select value={f.status} onChange={(e) => upd("status", e.target.value)} aria-label="الحالة"><option value="">كل الحالات</option>{Object.entries(EXPENSE_STATUS).map(([k, l]) => <option key={k} value={k}>{l.label}</option>)}</Select>
          <Select value={f.category} onChange={(e) => upd("category", e.target.value)} aria-label="الفئة"><option value="">كل الفئات</option>{Object.entries(COST_CATEGORY).map(([k, l]) => <option key={k} value={k}>{l}</option>)}</Select>
          {projects.length > 0 && !projectId && <ProjectSelect value={f.projectId} onChange={(v) => upd("projectId", v)} projects={projects} />}
          <DateRange from={f.from} to={f.to} onFrom={(v) => upd("from", v)} onTo={(v) => upd("to", v)} />
        </FilterBar>
      )}
      {loading ? <Loading /> : error ? <div className="p-4"><Alert>{error.message}</Alert></div> : !data?.data.length ? (
        <EmptyState icon="receipt" title="لا توجد مصروفات" />
      ) : (
        <>
          <DataList
            rows={data.data}
            rowKey={(r) => r.id}
            onRowClick={(r) => setOpen(r.id)}
            columns={[
              { header: "المصروف", primary: true, cell: (r) => <span>{COST_CATEGORY[r.category] ?? r.category}{r.description ? ` — ${r.description}` : ""}</span> },
              { header: "المبلغ", cell: (r) => <Money value={r.amount} /> },
              { header: "التاريخ", cell: (r) => formatDate(r.expenseDate) },
              { header: "المشروع", cell: (r) => r.projectName, hideOnMobile: true },
              { header: "المركبة", cell: (r) => (r.plateNumber ? <span className="ltr">{r.plateNumber}</span> : "—"), hideOnMobile: true },
              { header: "الحالة", cell: (r) => <StatusBadge map={EXPENSE_STATUS} value={r.status} /> },
              {
                header: "إجراء",
                cell: (r) =>
                  canApprove && r.status === "SUBMITTED" && r.createdBy !== me?.id ? (
                    <span className="flex gap-1" onClick={(e) => e.stopPropagation()}>
                      <Button className="px-2 py-1 text-xs" loading={busy === r.id} onClick={async () => { if (await run(r.id, () => api(`/expenses/${r.id}/approve`, { method: "POST" }), "تم اعتماد المصروف")) reload(); }}>اعتماد</Button>
                      <Button variant="danger" className="px-2 py-1 text-xs" onClick={() => setRejecting(r)}>رفض</Button>
                    </span>
                  ) : <span className="text-xs text-slate-400">—</span>,
              },
            ]}
          />
          <Pagination {...data.meta} onPage={setPage} />
        </>
      )}
      <CreateExpenseModal open={creating} onClose={() => setCreating(false)} onCreated={reload} vehicleId={vehicleId} projectId={projectId} />
      <ReasonModal open={!!rejecting} title="رفض المصروف" danger confirmLabel="رفض" onClose={() => setRejecting(null)} onSubmit={async (reason) => { await api(`/expenses/${rejecting!.id}/reject`, { method: "POST", body: { reason } }); reload(); }} />
      <Modal open={!!focused} onClose={() => setOpen(null)} title="تفاصيل المصروف">
        {focused && (
          <div className="space-y-3 text-sm">
            <p><b>{COST_CATEGORY[focused.category]}</b> — <Money value={focused.amount} /> — {formatDate(focused.expenseDate)}</p>
            <p>المشروع: {focused.projectName} {focused.plateNumber && <>· المركبة: <span className="ltr">{focused.plateNumber}</span></>}</p>
            <p>الحالة: <StatusBadge map={EXPENSE_STATUS} value={focused.status} /> {focused.reviewReason && `— ${focused.reviewReason}`}</p>
            <p>بواسطة: {focused.createdByName}</p>
            <FileAttachment fileName={focused.hasReceipt ? "الإيصال" : null} downloadPath={`/expenses/${focused.id}/receipt`} uploadPath={`/expenses/${focused.id}/receipt`} canUpload={focused.createdBy === me?.id && focused.status === "SUBMITTED"} onUploaded={reload} />
          </div>
        )}
      </Modal>
    </Card>
  );
}

export function ExpensesPage() {
  return (
    <>
      <PageHeader title="المصروفات" subtitle="مصروفات المركبات والمشاريع حسب الفئة" />
      <ExpensesList />
    </>
  );
}
