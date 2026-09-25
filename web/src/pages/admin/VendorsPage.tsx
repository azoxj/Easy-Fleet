import { useState } from "react";
import { DataList } from "../../components/DataList";
import { useToast } from "../../components/feedback";
import { Alert, Button, Card, EmptyState, Field, Input, Loading, Modal, PageHeader, Select, StatusBadge, Textarea } from "../../components/ui";
import { useApi } from "../../hooks/useApi";
import { api } from "../../lib/api";
import { useAuth } from "../../lib/auth";
import { errorMessage, fieldErrors } from "../../lib/forms";
import type { Vendor } from "../../lib/types";

const STATUS = { ACTIVE: { label: "نشط", tone: "green" as const }, INACTIVE: { label: "موقوف", tone: "gray" as const } };

export function VendorsPage() {
  const { can } = useAuth();
  const toast = useToast();
  const [q, setQ] = useState("");
  const [status, setStatus] = useState("ALL");
  const { data, loading, error, reload } = useApi<{ data: Vendor[] }>("/vendors", { q, status });
  const [edit, setEdit] = useState<Partial<Vendor> | null>(null);
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState(false);
  const canManage = can("vendors.manage", "PROJECT") || can("maintenance.quote.create", "PROJECT");
  const save = async () => {
    if (!edit) return;
    setBusy(true);
    setErrors({});
    const body = { name: edit.name ?? "", phone: edit.phone ?? "", email: edit.email ?? "", taxNumber: edit.taxNumber ?? "", address: edit.address ?? "", notes: edit.notes ?? "", ...(edit.id ? { status: edit.status } : {}) };
    try {
      await api(edit.id ? `/vendors/${edit.id}` : "/vendors", { method: edit.id ? "PATCH" : "POST", body });
      toast.success("تم حفظ المورد");
      setEdit(null);
      reload();
    } catch (err) {
      setErrors(fieldErrors(err));
      toast.error(errorMessage(err));
    } finally {
      setBusy(false);
    }
  };
  return (
    <>
      <PageHeader title="الموردون والورش" actions={canManage && <Button icon="plus" onClick={() => setEdit({ status: "ACTIVE" })}>مورد جديد</Button>} />
      <Card>
        <div className="flex flex-wrap gap-2 border-b border-slate-100 p-4">
          <Input className="max-w-md" placeholder="بحث بالاسم أو الرقم الضريبي أو الجوال" value={q} onChange={(e) => setQ(e.target.value)} aria-label="بحث" />
          <Select className="w-40" value={status} onChange={(e) => setStatus(e.target.value)} aria-label="الحالة"><option value="ALL">الكل</option><option value="ACTIVE">النشطون</option><option value="INACTIVE">الموقوفون</option></Select>
        </div>
        {loading ? <Loading /> : error ? <div className="p-4"><Alert>{error.message}</Alert></div> : !data?.data.length ? <EmptyState icon="building" title="لا يوجد موردون" /> : (
          <DataList rows={data.data} rowKey={(r) => r.id} onRowClick={canManage ? (r) => setEdit(r) : undefined} columns={[
            { header: "المورد", primary: true, cell: (r) => r.name },
            { header: "الرقم الضريبي", cell: (r) => (r.taxNumber ? <span className="ltr">{r.taxNumber}</span> : "—") },
            { header: "الجوال", cell: (r) => (r.phone ? <span className="ltr">{r.phone}</span> : "—") },
            { header: "العنوان", cell: (r) => r.address ?? "—", hideOnMobile: true },
            { header: "الحالة", cell: (r) => <StatusBadge map={STATUS} value={r.status} /> },
          ]} />
        )}
      </Card>
      <Modal open={!!edit} onClose={() => setEdit(null)} title={edit?.id ? "تعديل المورد" : "مورد جديد"} footer={<><Button variant="secondary" onClick={() => setEdit(null)}>إلغاء</Button><Button loading={busy} onClick={save}>حفظ</Button></>}>
        {edit && (
          <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
            <Field label="الاسم" required error={errors.name} htmlFor="vd-name"><Input id="vd-name" value={edit.name ?? ""} onChange={(e) => setEdit({ ...edit, name: e.target.value })} /></Field>
            <Field label="الرقم الضريبي" error={errors.taxNumber} htmlFor="vd-tax"><Input id="vd-tax" dir="ltr" value={edit.taxNumber ?? ""} onChange={(e) => setEdit({ ...edit, taxNumber: e.target.value })} /></Field>
            <Field label="الجوال" error={errors.phone} htmlFor="vd-phone"><Input id="vd-phone" dir="ltr" value={edit.phone ?? ""} onChange={(e) => setEdit({ ...edit, phone: e.target.value })} /></Field>
            <Field label="البريد" error={errors.email} htmlFor="vd-email"><Input id="vd-email" dir="ltr" value={edit.email ?? ""} onChange={(e) => setEdit({ ...edit, email: e.target.value })} /></Field>
            <div className="sm:col-span-2"><Field label="العنوان" htmlFor="vd-addr"><Input id="vd-addr" value={edit.address ?? ""} onChange={(e) => setEdit({ ...edit, address: e.target.value })} /></Field></div>
            {edit.id && <Field label="الحالة" htmlFor="vd-status"><Select id="vd-status" value={edit.status} onChange={(e) => setEdit({ ...edit, status: e.target.value })}><option value="ACTIVE">نشط</option><option value="INACTIVE">موقوف</option></Select></Field>}
            <div className="sm:col-span-2"><Field label="ملاحظات" htmlFor="vd-notes"><Textarea id="vd-notes" value={edit.notes ?? ""} onChange={(e) => setEdit({ ...edit, notes: e.target.value })} /></Field></div>
          </div>
        )}
      </Modal>
    </>
  );
}
