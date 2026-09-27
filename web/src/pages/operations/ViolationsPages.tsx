import { useEffect, useState } from "react";
import { Link, useNavigate, useParams, useSearchParams } from "react-router";
import { FileAttachment } from "../../components/common";
import { DataList } from "../../components/DataList";
import { useToast } from "../../components/feedback";
import { BackLink, DateRange, FilterBar, Money, ProjectSelect, ReasonModal, RecordTimeline, todayIso, useAction, useProjects, useVehicles, VehicleSelect, type AuditRow } from "../../components/shared";
import { Alert, Button, Card, CardHeader, DescList, EmptyState, Field, Input, Loading, Modal, PageHeader, Pagination, Select, StatusBadge, Textarea } from "../../components/ui";
import { useApi } from "../../hooks/useApi";
import { api, type Paged } from "../../lib/api";
import { useAuth } from "../../lib/auth";
import { formatDate } from "../../lib/format";
import { errorMessage, fieldErrors } from "../../lib/forms";
import { VIOLATION_STATUS } from "../../lib/labels";
import type { ViolationRow } from "../../lib/types";
import { t } from "../../i18n";

function CreateViolationModal({ open, onClose, onCreated, vehicleId }: { open: boolean; onClose: () => void; onCreated: (id: string) => void; vehicleId?: string }) {
  const toast = useToast();
  const vehicles = useVehicles();
  const empty = { vehicleId: vehicleId ?? "", violationNumber: "", violationDate: todayIso(), type: "", amount: "", authority: t("violations.trafficAuthority"), notes: "" };
  const [v, setV] = useState(empty);
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  // eslint-disable-next-line react-hooks/exhaustive-deps
  useEffect(() => { if (open) { setV(empty); setErrors({}); setError(null); } }, [open]);
  const set = (k: keyof typeof v) => (e: { target: { value: string } }) => setV((s) => ({ ...s, [k]: e.target.value }));
  const save = async () => {
    const e: Record<string, string> = {};
    if (!v.vehicleId) e.vehicleId = t("common.selectAVehicle2");
    if (v.type.trim().length < 2) e.type = t("violations.violationTypeIsRequired");
    if (!/^\d+(\.\d{1,2})?$/.test(v.amount)) e.amount = t("violations.enterTheAmount");
    setErrors(e);
    if (Object.keys(e).length) return;
    setBusy(true);
    try {
      const r = await api<{ data: { id: string } }>("/violations", { method: "POST", body: { vehicleId: v.vehicleId, violationDate: v.violationDate, type: v.type.trim(), amount: v.amount, ...(v.violationNumber.trim() ? { violationNumber: v.violationNumber.trim() } : {}), ...(v.authority.trim() ? { authority: v.authority.trim() } : {}), ...(v.notes.trim() ? { notes: v.notes.trim() } : {}) } });
      toast.success(t("violations.violationRecordedTheDriverIs"));
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
    <Modal open={open} onClose={onClose} title={t("violations.recordViolation")} footer={<><Button variant="secondary" onClick={onClose}>{t("common.cancel")}</Button><Button loading={busy} onClick={save}>{t("common.save")}</Button></>}>
      <div className="space-y-4">
        {error && <Alert>{error}</Alert>}
        {!vehicleId && <Field label={t("common.vehicle")} required error={errors.vehicleId} htmlFor="v-vehicle"><VehicleSelect id="v-vehicle" value={v.vehicleId} onChange={(x) => setV((s) => ({ ...s, vehicleId: x }))} vehicles={vehicles} all={t("common.selectAVehicle3")} /></Field>}
        <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
          <Field label={t("violations.violationType")} required error={errors.type} htmlFor="v-type"><Input id="v-type" value={v.type} onChange={set("type")} placeholder={t("violations.exampleSpeeding")} /></Field>
          <Field label={t("common.amount")} required error={errors.amount} htmlFor="v-amount"><Input id="v-amount" dir="ltr" inputMode="decimal" value={v.amount} onChange={set("amount")} /></Field>
          <Field label={t("violations.violationDate")} required htmlFor="v-date"><Input id="v-date" type="date" max={todayIso()} value={v.violationDate} onChange={set("violationDate")} /></Field>
          <Field label={t("violations.violationNumber")} error={errors.violationNumber} htmlFor="v-no"><Input id="v-no" dir="ltr" value={v.violationNumber} onChange={set("violationNumber")} /></Field>
          <Field label={t("violations.authority")} htmlFor="v-auth"><Input id="v-auth" value={v.authority} onChange={set("authority")} /></Field>
        </div>
        <Field label={t("common.notes")} htmlFor="v-notes"><Textarea id="v-notes" value={v.notes} onChange={set("notes")} /></Field>
      </div>
    </Modal>
  );
}

export function ViolationsList({ vehicleId, embedded }: { vehicleId?: string; embedded?: boolean }) {
  const { can } = useAuth();
  const navigate = useNavigate();
  const [params] = useSearchParams();
  const projects = useProjects();
  const init = { q: "", status: params.get("status") ?? "", projectId: "", from: "", to: "" };
  const [f, setF] = useState(init);
  const [page, setPage] = useState(1);
  const [adding, setAdding] = useState(false);
  const { data, loading, error } = useApi<Paged<ViolationRow> & { summary: { openAmount: string; paidAmount: string } }>("/violations", { ...f, vehicleId, page, pageSize: 20 });
  const upd = (k: keyof typeof f, v: string) => { setF((s) => ({ ...s, [k]: v })); setPage(1); };
  const active = Object.entries(f).filter(([k, v]) => k !== "q" && v).length;
  return (
    <Card>
      <div className="flex flex-wrap items-center justify-between gap-2 border-b border-slate-100 px-4 py-3">
        <p className="text-sm text-slate-500">{data && <>{t("violations.unpaid")} <b className="text-red-700"><Money value={data.summary.openAmount} /></b> {t("violations.paid")} <b><Money value={data.summary.paidAmount} /></b></>}</p>
        {can("violations.create") && <Button icon="plus" onClick={() => setAdding(true)}>{t("violations.recordViolation")}</Button>}
      </div>
      {!embedded && (
        <FilterBar q={f.q} onQ={(v) => upd("q", v)} placeholder={t("violations.searchPlateViolationNumberType")} active={active} onClear={() => { setF({ ...init, q: f.q, status: "" }); setPage(1); }}>
          <Select value={f.status} onChange={(e) => upd("status", e.target.value)} aria-label={t("common.status")}><option value="">{t("common.allStatuses")}</option>{Object.entries(VIOLATION_STATUS).map(([k, l]) => <option key={k} value={k}>{l.label}</option>)}</Select>
          {projects.length > 0 && <ProjectSelect value={f.projectId} onChange={(v) => upd("projectId", v)} projects={projects} />}
          <DateRange from={f.from} to={f.to} onFrom={(v) => upd("from", v)} onTo={(v) => upd("to", v)} />
        </FilterBar>
      )}
      {loading ? <Loading /> : error ? <div className="p-4"><Alert>{error.message}</Alert></div> : !data?.data.length ? <EmptyState icon="ticket" title={t("violations.noViolations")} /> : (
        <>
          <DataList rows={data.data} rowKey={(r) => r.id} onRowClick={(r) => navigate(`/violations/${r.id}`)} columns={[
            { header: t("violations.violation"), primary: true, cell: (r) => <span className="flex gap-2"><Link to={`/violations/${r.id}`} onClick={(e) => e.stopPropagation()} className="font-semibold hover:text-brand-700">{r.type}</Link><span className="ltr text-slate-500">{r.plateNumber}</span></span> },
            { header: t("common.date"), cell: (r) => formatDate(r.violationDate) },
            { header: t("common.amount"), cell: (r) => <Money value={r.amount} /> },
            { header: t("common.status"), cell: (r) => <StatusBadge map={VIOLATION_STATUS} value={r.status} /> },
            { header: t("common.driver"), cell: (r) => r.driverName ?? "—", hideOnMobile: true },
            { header: t("common.number"), cell: (r) => (r.violationNumber ? <span className="ltr">{r.violationNumber}</span> : "—"), hideOnMobile: true },
          ]} />
          <Pagination {...data.meta} onPage={setPage} />
        </>
      )}
      <CreateViolationModal open={adding} onClose={() => setAdding(false)} onCreated={(id) => navigate(`/violations/${id}`)} vehicleId={vehicleId} />
    </Card>
  );
}

export function ViolationsPage() {
  return (
    <>
      <PageHeader title={t("violations.trafficViolations")} subtitle={t("violations.unpaidPaidDisputedCancelled")} />
      <ViolationsList />
    </>
  );
}

type ViolationDetail = ViolationRow & { projectId: string | null; createdByName: string; timeline: AuditRow[]; actions: string[] };

export function ViolationDetailPage() {
  const { id } = useParams();
  const { data, loading, error, reload } = useApi<{ data: ViolationDetail }>(`/violations/${id}`);
  const { busy, run } = useAction();
  const [modal, setModal] = useState<"dispute" | "cancel" | "pay" | null>(null);
  const [payDate, setPayDate] = useState(todayIso());
  if (loading) return <Loading />;
  if (error || !data) return <Alert>{error?.message ?? t("common.couldNotLoad")}</Alert>;
  const v = data.data;
  const has = (a: string) => v.actions.includes(a);
  return (
    <>
      <PageHeader
        back={<BackLink to="/violations" label={t("common.violations")} />}
        title={<span className="flex flex-wrap items-center gap-3">{v.type}<StatusBadge map={VIOLATION_STATUS} value={v.status} /></span>}
        subtitle={<>{t("common.vehicle")} <Link className="text-brand-700 ltr" to={`/vehicles/${v.vehicleId}`}>{v.plateNumber}</Link> — <Money value={v.amount} /></>}
        actions={
          <>
            {has("pay") && <Button icon="check" onClick={() => setModal("pay")}>{t("violations.recordPayment")}</Button>}
            {has("dispute") && <Button variant="secondary" onClick={() => setModal("dispute")}>{t("violations.dispute")}</Button>}
            {has("reopen") && <Button variant="secondary" loading={busy === "reopen"} onClick={async () => { if (await run("reopen", () => api(`/violations/${v.id}/reopen`, { method: "POST" }), t("violations.violationReopened"))) reload(); }}>{t("common.reopen")}</Button>}
            {has("cancel") && <Button variant="ghost" onClick={() => setModal("cancel")}>{t("common.cancel")}</Button>}
          </>
        }
      />
      <div className="grid grid-cols-1 gap-6 lg:grid-cols-3">
        <Card className="lg:col-span-2">
          <CardHeader title={t("violations.violationDetails")} />
          <div className="space-y-4 p-5">
            <DescList items={[
              { label: t("violations.violationNumber"), value: v.violationNumber ? <span className="ltr">{v.violationNumber}</span> : null },
              { label: t("common.date"), value: formatDate(v.violationDate) },
              { label: t("common.amount"), value: <Money value={v.amount} /> },
              { label: t("violations.authority"), value: v.authority },
              { label: t("common.driver"), value: v.driverName },
              { label: t("common.project"), value: v.projectName },
              { label: t("violations.paymentDate"), value: formatDate(v.paymentDate) },
              { label: t("violations.disputeReason"), value: v.disputeReason },
              { label: t("violations.recordedBy"), value: v.createdByName },
            ]} />
            {v.notes && <p className="text-sm whitespace-pre-line text-slate-600">{v.notes}</p>}
            <FileAttachment fileName={v.hasFile ? t("violations.violationPhotoFile") : null} downloadPath={`/violations/${v.id}/file`} uploadPath={`/violations/${v.id}/file`} canUpload={has("attach")} onUploaded={reload} />
          </div>
        </Card>
        <Card><CardHeader title={t("common.history")} /><div className="p-5"><RecordTimeline rows={v.timeline} /></div></Card>
      </div>
      <ReasonModal open={modal === "dispute"} title={t("violations.disputeTheViolation")} label={t("violations.disputeReason")} onClose={() => setModal(null)} onSubmit={async (reason) => { await api(`/violations/${v.id}/dispute`, { method: "POST", body: { reason } }); reload(); }} />
      <ReasonModal open={modal === "cancel"} title={t("violations.cancelViolation")} danger label={t("violations.cancellationReason")} onClose={() => setModal(null)} onSubmit={async (reason) => { await api(`/violations/${v.id}/cancel`, { method: "POST", body: { reason } }); reload(); }} />
      <Modal open={modal === "pay"} onClose={() => setModal(null)} title={t("violations.recordViolationPayment")} footer={<><Button variant="secondary" onClick={() => setModal(null)}>{t("common.cancel")}</Button><Button loading={busy === "pay"} onClick={async () => { if (await run("pay", () => api(`/violations/${v.id}/pay`, { method: "POST", body: { paymentDate: payDate } }), t("violations.paymentRecorded"))) { setModal(null); reload(); } }}>{t("common.confirm")}</Button></>}>
        <Field label={t("violations.paymentDate")} required htmlFor="pay-date"><Input id="pay-date" type="date" min={v.violationDate} max={todayIso()} value={payDate} onChange={(e) => setPayDate(e.target.value)} /></Field>
      </Modal>
    </>
  );
}
