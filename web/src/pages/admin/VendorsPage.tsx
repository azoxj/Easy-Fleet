import { useState } from "react";
import { DataList } from "../../components/DataList";
import { useToast } from "../../components/feedback";
import { Alert, Button, Card, EmptyState, Field, Input, Loading, Modal, PageHeader, Select, StatusBadge, Textarea } from "../../components/ui";
import { useApi } from "../../hooks/useApi";
import { api } from "../../lib/api";
import { useAuth } from "../../lib/auth";
import { errorMessage, fieldErrors } from "../../lib/forms";
import type { Vendor } from "../../lib/types";
import { t } from "../../i18n";

const STATUS = { ACTIVE: { get label() { return t("enums.status.ACTIVE"); }, tone: "green" as const }, INACTIVE: { get label() { return t("enums.status.INACTIVE"); }, tone: "gray" as const } };

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
      toast.success(t("vendors.vendorSaved"));
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
      <PageHeader title={t("vendors.vendorsWorkshops")} actions={canManage && <Button icon="plus" onClick={() => setEdit({ status: "ACTIVE" })}>{t("vendors.newVendor")}</Button>} />
      <Card>
        <div className="flex flex-wrap gap-2 border-b border-slate-100 p-4">
          <Input className="max-w-md" placeholder={t("vendors.searchByNameTaxNumber")} value={q} onChange={(e) => setQ(e.target.value)} aria-label={t("common.search")} />
          <Select className="w-40" value={status} onChange={(e) => setStatus(e.target.value)} aria-label={t("common.status")}><option value="ALL">{t("common.all")}</option><option value="ACTIVE">{t("vendors.active")}</option><option value="INACTIVE">{t("vendors.suspended")}</option></Select>
        </div>
        {loading ? <Loading /> : error ? <div className="p-4"><Alert>{error.message}</Alert></div> : !data?.data.length ? <EmptyState icon="building" title={t("vendors.noVendors")} /> : (
          <DataList rows={data.data} rowKey={(r) => r.id} onRowClick={canManage ? (r) => setEdit(r) : undefined} columns={[
            { header: t("common.vendor"), primary: true, cell: (r) => r.name },
            { header: t("vendors.taxNumber"), cell: (r) => (r.taxNumber ? <span className="ltr">{r.taxNumber}</span> : "—") },
            { header: t("common.mobile"), cell: (r) => (r.phone ? <span className="ltr">{r.phone}</span> : "—") },
            { header: t("common.address"), cell: (r) => r.address ?? "—", hideOnMobile: true },
            { header: t("common.status"), cell: (r) => <StatusBadge map={STATUS} value={r.status} /> },
          ]} />
        )}
      </Card>
      <Modal open={!!edit} onClose={() => setEdit(null)} title={edit?.id ? t("vendors.editVendor") : t("vendors.newVendor")} footer={<><Button variant="secondary" onClick={() => setEdit(null)}>{t("common.cancel")}</Button><Button loading={busy} onClick={save}>{t("common.save")}</Button></>}>
        {edit && (
          <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
            <Field label={t("common.name")} required error={errors.name} htmlFor="vd-name"><Input id="vd-name" value={edit.name ?? ""} onChange={(e) => setEdit({ ...edit, name: e.target.value })} /></Field>
            <Field label={t("vendors.taxNumber")} error={errors.taxNumber} htmlFor="vd-tax"><Input id="vd-tax" dir="ltr" value={edit.taxNumber ?? ""} onChange={(e) => setEdit({ ...edit, taxNumber: e.target.value })} /></Field>
            <Field label={t("common.mobile")} error={errors.phone} htmlFor="vd-phone"><Input id="vd-phone" dir="ltr" value={edit.phone ?? ""} onChange={(e) => setEdit({ ...edit, phone: e.target.value })} /></Field>
            <Field label={t("vendors.email")} error={errors.email} htmlFor="vd-email"><Input id="vd-email" dir="ltr" value={edit.email ?? ""} onChange={(e) => setEdit({ ...edit, email: e.target.value })} /></Field>
            <div className="sm:col-span-2"><Field label={t("common.address")} htmlFor="vd-addr"><Input id="vd-addr" value={edit.address ?? ""} onChange={(e) => setEdit({ ...edit, address: e.target.value })} /></Field></div>
            {edit.id && <Field label={t("common.status")} htmlFor="vd-status"><Select id="vd-status" value={edit.status} onChange={(e) => setEdit({ ...edit, status: e.target.value })}><option value="ACTIVE">{t("common.active")}</option><option value="INACTIVE">{t("common.suspended")}</option></Select></Field>}
            <div className="sm:col-span-2"><Field label={t("common.notes")} htmlFor="vd-notes"><Textarea id="vd-notes" value={edit.notes ?? ""} onChange={(e) => setEdit({ ...edit, notes: e.target.value })} /></Field></div>
          </div>
        )}
      </Modal>
    </>
  );
}
