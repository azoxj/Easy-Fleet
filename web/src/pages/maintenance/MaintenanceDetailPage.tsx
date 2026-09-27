import { useRef, useState } from "react";
import { Link, useParams } from "react-router";
import { FileAttachment } from "../../components/common";
import { DataList } from "../../components/DataList";
import { useConfirm, useToast } from "../../components/feedback";
import { Icon } from "../../components/icons";
import { Alert, Badge, Button, Card, CardHeader, DescList, EmptyState, Field, Input, Loading, Modal, PageHeader, Select, StatusBadge, Textarea, cx } from "../../components/ui";
import { useApi } from "../../hooks/useApi";
import { api, apiUpload, fileUrl } from "../../lib/api";
import { formatDate, formatDateTime, formatMoney, formatNumber } from "../../lib/format";
import { clean, errorMessage, fieldErrors } from "../../lib/forms";
import {
  ACTION_LABEL,
  ACTION_PATH,
  ATTACHMENT_CATEGORY,
  DANGER_ACTIONS,
  EVENT_LABEL,
  MAINTENANCE_PRIORITY,
  MAINTENANCE_STATUS,
  mrNumber,
  QUOTE_STATUS,
  REASON_ACTIONS,
  STEPS,
  stepIndex,
  sumMoney,
  validateLabor,
  validatePart,
  validateQuote,
  validateReason,
} from "../../lib/maintenance";
import type { MaintenanceDetail, MaintenanceQuote } from "../../lib/types";
import { t } from "../../i18n";

const todayIso = () => new Date().toISOString().slice(0, 10);

function Stepper({ status }: { status: string }) {
  if (status === "REJECTED") return <Alert tone="red">{t("maintenanceDetail.theMaintenanceRequestWasRejected")}</Alert>;
  const current = stepIndex(status);
  return (
    <ol className="flex flex-wrap gap-x-1 gap-y-2" aria-label={t("maintenanceDetail.requestStages")}>
      {STEPS.map((s, i) => {
        const done = i < current || status === "CLOSED";
        const here = Math.ceil(current) === i && status !== "CLOSED";
        return (
          <li key={s} className={cx("flex items-center gap-1.5 rounded-full px-2.5 py-1 text-xs font-medium", done ? "bg-emerald-50 text-emerald-700" : here ? "bg-brand-700 text-white" : "bg-slate-100 text-slate-500")}>
            {done && <Icon name="check" className="size-3.5" />}
            {MAINTENANCE_STATUS[s]!.label}
          </li>
        );
      })}
    </ol>
  );
}

function ReasonModal({ title, danger, onClose, onSubmit }: { title: string; danger?: boolean; onClose: () => void; onSubmit: (reason: string) => Promise<void> }) {
  const [reason, setReason] = useState("");
  const [err, setErr] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const submit = async () => {
    const e = validateReason(reason);
    setErr(e);
    if (e) return;
    setBusy(true);
    try {
      await onSubmit(reason.trim());
      onClose();
    } catch (x) {
      setErr(errorMessage(x));
    } finally {
      setBusy(false);
    }
  };
  return (
    <Modal open onClose={onClose} title={title} footer={<><Button variant="secondary" onClick={onClose}>{t("common.cancel")}</Button><Button variant={danger ? "danger" : "primary"} onClick={submit} loading={busy}>{t("common.confirm")}</Button></>}>
      <Field label={t("common.reason")} required error={err ?? undefined} htmlFor="reason">
        <Textarea id="reason" value={reason} onChange={(e) => setReason(e.target.value)} maxLength={1000} placeholder={t("maintenanceDetail.exampleTheBrakesAreStill")} />
      </Field>
    </Modal>
  );
}

function AssignModal({ id, current, onClose, onDone }: { id: string; current: string | null; onClose: () => void; onDone: () => void }) {
  const toast = useToast();
  const { data, loading } = useApi<{ data: { id: string; name: string; email: string }[] }>(`/maintenance/${id}/technicians`);
  const [tech, setTech] = useState(current ?? "");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const save = async () => {
    setBusy(true);
    setErr(null);
    try {
      await api(`/maintenance/${id}/assign`, { method: "POST", body: { technicianId: tech } });
      toast.success(t("maintenanceDetail.technicianAssigned"));
      onDone();
      onClose();
    } catch (x) {
      setErr(errorMessage(x));
    } finally {
      setBusy(false);
    }
  };
  return (
    <Modal open onClose={onClose} title={t("maintenanceDetail.assignTechnician")} footer={<><Button variant="secondary" onClick={onClose}>{t("common.cancel")}</Button><Button onClick={save} loading={busy} disabled={!tech || tech === current}>{t("common.assign")}</Button></>}>
      <div className="space-y-3">
        {err && <Alert>{err}</Alert>}
        <Alert tone="blue">{t("maintenanceDetail.onlyUsersAllowedToCarry")}</Alert>
        {loading ? <Loading /> : (
          <Field label={t("common.technician")} htmlFor="tech">
            <Select id="tech" value={tech} onChange={(e) => setTech(e.target.value)}>
              <option value="">{t("common.select")}</option>
              {data?.data.map((u) => <option key={u.id} value={u.id}>{u.name}</option>)}
            </Select>
          </Field>
        )}
      </div>
    </Modal>
  );
}

function TextSection({ label, field, value, editable, id, onSaved, placeholder }: { label: string; field: string; value: string | null; editable: boolean; id: string; onSaved: () => void; placeholder?: string }) {
  const toast = useToast();
  const [editing, setEditing] = useState(false);
  const [text, setText] = useState(value ?? "");
  const [busy, setBusy] = useState(false);
  const save = async () => {
    setBusy(true);
    try {
      await api(`/maintenance/${id}`, { method: "PATCH", body: { [field]: text.trim() || null } });
      toast.success(t("common.saved"));
      setEditing(false);
      onSaved();
    } catch (x) {
      toast.error(errorMessage(x));
    } finally {
      setBusy(false);
    }
  };
  return (
    <div>
      <div className="mb-1 flex items-center justify-between">
        <p className="text-xs text-slate-500">{label}</p>
        {editable && !editing && <button className="text-xs font-medium text-brand-700 hover:underline" onClick={() => { setText(value ?? ""); setEditing(true); }}>{value ? t("common.edit") : t("common.add")}</button>}
      </div>
      {editing ? (
        <div className="space-y-2">
          <Textarea value={text} onChange={(e) => setText(e.target.value)} placeholder={placeholder} maxLength={4000} aria-label={label} />
          <div className="flex gap-2"><Button onClick={save} loading={busy}>{t("common.save")}</Button><Button variant="ghost" onClick={() => setEditing(false)}>{t("common.cancel")}</Button></div>
        </div>
      ) : (
        <p className="text-sm whitespace-pre-line text-slate-800">{value || <span className="text-slate-400">—</span>}</p>
      )}
    </div>
  );
}

function PartModal({ id, onClose, onDone }: { id: string; onClose: () => void; onDone: () => void }) {
  const toast = useToast();
  const vendors = useApi<{ data: { id: string; name: string }[] }>("/vendors");
  const [v, setV] = useState({ partName: "", partNumber: "", quantity: "1", unitPrice: "", vendorId: "", notes: "" });
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState(false);
  const set = (k: keyof typeof v) => (e: { target: { value: string } }) => setV((s) => ({ ...s, [k]: e.target.value }));
  const total = Number(v.quantity) > 0 && v.unitPrice ? sumMoney([String(Number(v.quantity) * Number(v.unitPrice))]) : null;
  const save = async () => {
    const e = validatePart(v);
    setErrors(e);
    if (Object.keys(e).length) return;
    setBusy(true);
    try {
      await api(`/maintenance/${id}/parts`, { method: "POST", body: clean(v) });
      toast.success(t("maintenanceDetail.partAdded"));
      onDone();
      onClose();
    } catch (x) {
      setErrors(fieldErrors(x));
      toast.error(errorMessage(x));
    } finally {
      setBusy(false);
    }
  };
  return (
    <Modal open onClose={onClose} title={t("maintenanceDetail.addSparePart")} footer={<><Button variant="secondary" onClick={onClose}>{t("common.cancel")}</Button><Button onClick={save} loading={busy}>{t("common.add")}</Button></>}>
      <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
        <Field label={t("maintenanceDetail.partName")} required error={errors.partName} htmlFor="p-name"><Input id="p-name" value={v.partName} onChange={set("partName")} /></Field>
        <Field label={t("maintenanceDetail.partNumber")} htmlFor="p-num"><Input id="p-num" dir="ltr" value={v.partNumber} onChange={set("partNumber")} /></Field>
        <Field label={t("maintenanceDetail.quantity")} required error={errors.quantity} htmlFor="p-qty"><Input id="p-qty" dir="ltr" inputMode="decimal" value={v.quantity} onChange={set("quantity")} /></Field>
        <Field label={t("maintenanceDetail.unitPriceSar")} required error={errors.unitPrice} htmlFor="p-price"><Input id="p-price" dir="ltr" inputMode="decimal" value={v.unitPrice} onChange={set("unitPrice")} /></Field>
        <Field label={t("common.vendor")} htmlFor="p-vendor">
          <Select id="p-vendor" value={v.vendorId} onChange={set("vendorId")}>
            <option value="">{t("common.none2")}</option>
            {vendors.data?.data.map((x) => <option key={x.id} value={x.id}>{x.name}</option>)}
          </Select>
        </Field>
        <div className="flex items-end text-sm text-slate-600">{t("maintenanceDetail.estimatedTotal")} <span className="ms-1 font-semibold">{total ? formatMoney(total) : "—"}</span></div>
      </div>
      <p className="mt-3 text-xs text-slate-500">{t("maintenanceDetail.theFinalTotalIsCalculated")}</p>
    </Modal>
  );
}

function LaborModal({ id, onClose, onDone }: { id: string; onClose: () => void; onDone: () => void }) {
  const toast = useToast();
  const [v, setV] = useState({ description: "", hours: "", hourlyRate: "" });
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState(false);
  const set = (k: keyof typeof v) => (e: { target: { value: string } }) => setV((s) => ({ ...s, [k]: e.target.value }));
  const save = async () => {
    const e = validateLabor(v);
    setErrors(e);
    if (Object.keys(e).length) return;
    setBusy(true);
    try {
      await api(`/maintenance/${id}/labor`, { method: "POST", body: clean(v) });
      toast.success(t("maintenanceDetail.laborAdded"));
      onDone();
      onClose();
    } catch (x) {
      setErrors(fieldErrors(x));
      toast.error(errorMessage(x));
    } finally {
      setBusy(false);
    }
  };
  return (
    <Modal open onClose={onClose} title={t("maintenanceDetail.addLabor")} footer={<><Button variant="secondary" onClick={onClose}>{t("common.cancel")}</Button><Button onClick={save} loading={busy}>{t("common.add")}</Button></>}>
      <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
        <div className="sm:col-span-2"><Field label={t("common.description")} required error={errors.description} htmlFor="l-desc"><Input id="l-desc" value={v.description} onChange={set("description")} /></Field></div>
        <Field label={t("maintenanceDetail.hours")} required error={errors.hours} htmlFor="l-hours"><Input id="l-hours" dir="ltr" inputMode="decimal" value={v.hours} onChange={set("hours")} /></Field>
        <Field label={t("maintenanceDetail.hourlyRateSar")} required error={errors.hourlyRate} htmlFor="l-rate"><Input id="l-rate" dir="ltr" inputMode="decimal" value={v.hourlyRate} onChange={set("hourlyRate")} /></Field>
      </div>
    </Modal>
  );
}

function QuoteModal({ id, onClose, onDone }: { id: string; onClose: () => void; onDone: () => void }) {
  const toast = useToast();
  const vendors = useApi<{ data: { id: string; name: string }[] }>("/vendors");
  const [v, setV] = useState({ vendorId: "", quoteNumber: "", amount: "", validUntil: "", notes: "" });
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState(false);
  const set = (k: keyof typeof v) => (e: { target: { value: string } }) => setV((s) => ({ ...s, [k]: e.target.value }));
  const save = async () => {
    const e = validateQuote(v, todayIso());
    setErrors(e);
    if (Object.keys(e).length) return;
    setBusy(true);
    try {
      await api(`/maintenance/${id}/quotes`, { method: "POST", body: clean(v) });
      toast.success(t("maintenanceDetail.quoteSavedAsADraft"));
      onDone();
      onClose();
    } catch (x) {
      setErrors(fieldErrors(x));
      toast.error(errorMessage(x));
    } finally {
      setBusy(false);
    }
  };
  return (
    <Modal open onClose={onClose} title={t("maintenanceDetail.newQuote")} footer={<><Button variant="secondary" onClick={onClose}>{t("common.cancel")}</Button><Button onClick={save} loading={busy}>{t("common.saveAsDraft")}</Button></>}>
      <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
        <Field label={t("common.vendor")} htmlFor="q-vendor">
          <Select id="q-vendor" value={v.vendorId} onChange={set("vendorId")}>
            <option value="">{t("common.none2")}</option>
            {vendors.data?.data.map((x) => <option key={x.id} value={x.id}>{x.name}</option>)}
          </Select>
        </Field>
        <Field label={t("maintenanceDetail.quoteNumber")} htmlFor="q-num"><Input id="q-num" dir="ltr" value={v.quoteNumber} onChange={set("quoteNumber")} /></Field>
        <Field label={t("maintenanceDetail.amountSar")} required error={errors.amount} htmlFor="q-amount"><Input id="q-amount" dir="ltr" inputMode="decimal" value={v.amount} onChange={set("amount")} /></Field>
        <Field label={t("maintenanceDetail.validUntil")} error={errors.validUntil} htmlFor="q-valid"><Input id="q-valid" type="date" value={v.validUntil} onChange={set("validUntil")} /></Field>
        <div className="sm:col-span-2"><Field label={t("common.notes")} htmlFor="q-notes"><Textarea id="q-notes" value={v.notes} onChange={set("notes")} /></Field></div>
      </div>
    </Modal>
  );
}

function Attachments({ d, reload }: { d: MaintenanceDetail; reload: () => void }) {
  const toast = useToast();
  const input = useRef<HTMLInputElement>(null);
  const [category, setCategory] = useState("DAMAGE_PHOTO");
  const [busy, setBusy] = useState(false);
  const upload = async (file: File | undefined) => {
    if (!file) return;
    setBusy(true);
    try {
      await apiUpload(`/maintenance/${d.id}/attachments?category=${category}`, file, fetch, "POST");
      toast.success(t("common.attachmentUploaded"));
      reload();
    } catch (x) {
      toast.error(errorMessage(x, t("common.couldNotUploadTheFile")));
    } finally {
      setBusy(false);
      if (input.current) input.current.value = "";
    }
  };
  return (
    <Card>
      <CardHeader
        title={t("maintenanceDetail.attachments")}
        action={
          d.capabilities.upload && (
            <div className="flex flex-wrap items-center gap-2">
              <Select value={category} onChange={(e) => setCategory(e.target.value)} aria-label={t("common.attachmentType")} className="w-auto">
                {Object.entries(ATTACHMENT_CATEGORY).map(([k, l]) => <option key={k} value={k}>{l}</option>)}
              </Select>
              <input ref={input} type="file" accept="application/pdf,image/png,image/jpeg,image/webp" className="hidden" onChange={(e) => void upload(e.target.files?.[0])} />
              <Button variant="secondary" icon="plus" loading={busy} onClick={() => input.current?.click()}>{t("maintenanceDetail.upload")}</Button>
            </div>
          )
        }
      />
      {d.attachments.length === 0 ? <EmptyState icon="file" title={t("common.noAttachments")} /> : (
        <ul className="divide-y divide-slate-100">
          {d.attachments.map((a) => (
            <li key={a.id} className="flex flex-wrap items-center justify-between gap-2 px-5 py-3 text-sm">
              <a href={fileUrl(`/maintenance-attachments/${a.id}/file`)} download className="inline-flex min-w-0 items-center gap-1.5 font-medium text-brand-700 hover:underline">
                <Icon name="file" className="size-4 shrink-0" /><span className="truncate">{a.fileName}</span>
              </a>
              <span className="flex items-center gap-2 text-xs text-slate-500"><Badge tone="slate">{ATTACHMENT_CATEGORY[a.category]}</Badge>{a.uploadedByName} · {formatDateTime(a.createdAt)}</span>
            </li>
          ))}
        </ul>
      )}
    </Card>
  );
}

export function MaintenanceDetailPage() {
  const { id = "" } = useParams();
  const toast = useToast();
  const confirm = useConfirm();
  const { data, loading, error, reload } = useApi<{ data: MaintenanceDetail }>(`/maintenance/${id}`);
  const [modal, setModal] = useState<string | null>(null);
  const [quoteReject, setQuoteReject] = useState<MaintenanceQuote | null>(null);
  const [busy, setBusy] = useState<string | null>(null);

  if (loading && !data) return <Loading />;
  if (error || !data) return <EmptyState icon="wrench" title={error?.status === 404 ? t("maintenanceDetail.maintenanceRequestNotFound") : error?.status === 403 ? t("maintenanceDetail.youDoNotHavePermission") : t("maintenanceDetail.couldNotLoadTheRequest")} description={error?.message} action={<Link to="/maintenance" className="text-sm text-brand-700">{t("maintenanceDetail.backToMaintenance")}</Link>} />;
  const d = data.data;

  const runAction = async (action: string, reason?: string) => {
    await api(`/maintenance/${id}/${ACTION_PATH[action]}`, { method: "POST", body: reason ? { reason } : undefined });
    toast.success(t("maintenanceDetail.done", { value: ACTION_LABEL[action] }));
    reload();
  };

  const onAction = async (action: string) => {
    if (action === "assign" || REASON_ACTIONS.has(action)) return setModal(action);
    if (!(await confirm({ title: ACTION_LABEL[action]!, message: t("maintenanceDetail.doYouWantToFor", { value: ACTION_LABEL[action], number: mrNumber(d.number) }), confirmLabel: t("common.confirm") }))) return;
    setBusy(action);
    try {
      await runAction(action);
    } catch (x) {
      toast.error(errorMessage(x));
    } finally {
      setBusy(null);
    }
  };

  const quoteAction = async (q: MaintenanceQuote, action: "submit" | "review" | "approve") => {
    const labels = { submit: t("maintenanceDetail.submitQuote"), review: t("common.startReview"), approve: t("maintenanceDetail.approveQuote") };
    if (action !== "review" && !(await confirm({ title: labels[action], message: t("maintenanceDetail.for", { value: labels[action], amount: formatMoney(q.amount) }) }))) return;
    try {
      await api(`/maintenance-quotes/${q.id}/${action}`, { method: "POST" });
      toast.success(t("maintenanceDetail.done", { value: labels[action] }));
      reload();
    } catch (x) {
      toast.error(errorMessage(x));
    }
  };

  const removeItem = async (kind: "parts" | "labor", itemId: string) => {
    if (!(await confirm({ title: t("maintenanceDetail.deleteItem"), message: t("maintenanceDetail.theItemWillBeDeleted"), danger: true, confirmLabel: t("common.delete") }))) return;
    try {
      await api(`/maintenance-${kind === "parts" ? "parts" : "labor"}/${itemId}`, { method: "DELETE" });
      toast.success(t("common.deleted"));
      reload();
    } catch (x) {
      toast.error(errorMessage(x));
    }
  };

  return (
    <>
      <PageHeader
        back={<Link to="/maintenance" className="mb-2 inline-flex items-center gap-1 text-sm text-slate-500 hover:text-slate-700"><Icon name="chevron" className="size-4" /> {t("common.maintenance")}</Link>}
        title={<span className="flex flex-wrap items-center gap-3"><span className="ltr">{mrNumber(d.number)}</span> <StatusBadge map={MAINTENANCE_STATUS} value={d.status} /> <StatusBadge map={MAINTENANCE_PRIORITY} value={d.priority} /></span>}
        subtitle={d.issue}
        actions={d.actions.map((a) => (
          <Button key={a} variant={DANGER_ACTIONS.has(a) ? "danger" : a === "assign" ? "secondary" : "primary"} loading={busy === a} onClick={() => void onAction(a)}>
            {ACTION_LABEL[a] ?? a}
          </Button>
        ))}
      />
      <div className="mb-6 space-y-3">
        <Stepper status={d.status} />
        {d.rejectionReason && (d.status === "REJECTED" || d.status === "IN_REPAIR") && (
          <Alert tone={d.status === "REJECTED" ? "red" : "amber"}>{d.status === "REJECTED" ? t("maintenanceDetail.rejectionReason") : t("maintenanceDetail.returnedForRepairTime", { handoverRejections: d.handoverRejections })}: {d.rejectionReason}</Alert>
        )}
      </div>

      <div className="grid grid-cols-1 gap-6 xl:grid-cols-3">
        <div className="space-y-6 xl:col-span-2">
          <Card>
            <CardHeader title={t("maintenanceDetail.requestDetails")} />
            <div className="space-y-5 p-5">
              <DescList
                items={[
                  { label: t("common.vehicle"), value: <Link to={`/vehicles/${d.vehicleId}`} className="text-brand-700 hover:underline ltr">{d.plateNumber}</Link> },
                  { label: t("common.project"), value: d.projectId ? <Link to={`/projects/${d.projectId}`} className="text-brand-700 hover:underline">{d.projectName}</Link> : "—" },
                  { label: t("maintenanceDetail.requestedBy"), value: d.requestedByName },
                  { label: t("common.technician"), value: d.technicianName ?? t("common.unassigned") },
                  { label: t("common.odometer"), value: d.odometer !== null ? t("maintenanceDetail.km", { odometer: formatNumber(d.odometer) }) : "—" },
                  { label: t("maintenanceDetail.requestDate"), value: formatDateTime(d.createdAt) },
                  { label: t("maintenanceDetail.completionDate"), value: formatDateTime(d.completedAt) },
                  { label: t("maintenanceDetail.actualCost"), value: d.cost !== null ? formatMoney(d.cost) : "—" },
                ]}
              />
              <TextSection id={id} label={t("maintenanceDetail.issueDescription")} field="description" value={d.description} editable={!!d.capabilities.edit.description} onSaved={reload} />
            </div>
          </Card>
          <Card>
            <CardHeader title={t("maintenanceDetail.technicalDetails")} />
            <div className="space-y-5 p-5">
              <TextSection id={id} label={t("maintenanceDetail.diagnosis")} field="diagnosis" value={d.diagnosis} editable={!!d.capabilities.edit.diagnosis} onSaved={reload} placeholder={t("maintenanceDetail.inspectionResultAndCause")} />
              <TextSection id={id} label={t("maintenanceDetail.workPerformed")} field="workPerformed" value={d.workPerformed} editable={!!d.capabilities.edit.workPerformed} onSaved={reload} />
              <TextSection id={id} label={t("common.notes")} field="notes" value={d.notes} editable={!!d.capabilities.edit.notes} onSaved={reload} />
            </div>
          </Card>

          {d.parts && (
            <Card>
              <CardHeader title={t("maintenanceDetail.spareParts")} subtitle={t("maintenanceDetail.total", { value: formatMoney(sumMoney(d.parts.map((p) => p.total))) })} action={d.capabilities.manageParts && <Button variant="secondary" icon="plus" onClick={() => setModal("part")}>{t("maintenanceDetail.addPart")}</Button>} />
              {d.parts.length === 0 ? <EmptyState icon="wrench" title={t("maintenanceDetail.noParts")} /> : (
                <DataList
                  rows={d.parts}
                  rowKey={(p) => p.id}
                  columns={[
                    { header: t("maintenanceDetail.part"), primary: true, cell: (p) => <span>{p.partName}{p.partNumber && <span className="ms-2 text-xs text-slate-400 ltr">{p.partNumber}</span>}</span> },
                    { header: t("maintenanceDetail.quantity"), cell: (p) => formatNumber(p.quantity) },
                    { header: t("maintenanceDetail.unitPrice"), cell: (p) => formatMoney(p.unitPrice) },
                    { header: t("common.total"), cell: (p) => <span className="font-medium">{formatMoney(p.total)}</span> },
                    { header: t("common.vendor"), cell: (p) => p.vendorName ?? "—", hideOnMobile: true },
                    ...(d.capabilities.manageParts ? [{ header: "", cell: (p: { id: string }) => <button onClick={() => void removeItem("parts", p.id)} className="rounded p-1.5 text-red-500 hover:bg-red-50" aria-label={t("common.delete")}><Icon name="trash" className="size-4" /></button> }] : []),
                  ]}
                />
              )}
            </Card>
          )}

          {d.labor && (
            <Card>
              <CardHeader title={t("maintenanceDetail.labor")} subtitle={t("maintenanceDetail.total", { value: formatMoney(sumMoney(d.labor.map((l) => l.total))) })} action={d.capabilities.manageLabor && <Button variant="secondary" icon="plus" onClick={() => setModal("labor")}>{t("maintenanceDetail.addLabor")}</Button>} />
              {d.labor.length === 0 ? <EmptyState icon="clock" title={t("maintenanceDetail.noWorkRecorded")} /> : (
                <DataList
                  rows={d.labor}
                  rowKey={(l) => l.id}
                  columns={[
                    { header: t("common.description"), primary: true, cell: (l) => l.description },
                    { header: t("maintenanceDetail.hours"), cell: (l) => formatNumber(l.hours) },
                    { header: t("maintenanceDetail.hourlyRate"), cell: (l) => formatMoney(l.hourlyRate) },
                    { header: t("common.total"), cell: (l) => <span className="font-medium">{formatMoney(l.total)}</span> },
                    ...(d.capabilities.manageLabor ? [{ header: "", cell: (l: { id: string }) => <button onClick={() => void removeItem("labor", l.id)} className="rounded p-1.5 text-red-500 hover:bg-red-50" aria-label={t("common.delete")}><Icon name="trash" className="size-4" /></button> }] : []),
                  ]}
                />
              )}
            </Card>
          )}

          {d.quotes && (
            <Card>
              <CardHeader title={t("maintenanceDetail.quotesApproval")} action={d.capabilities.createQuote && <Button variant="secondary" icon="plus" onClick={() => setModal("quote")}>{t("maintenanceDetail.quote")}</Button>} />
              {d.quotes.length === 0 ? <EmptyState icon="receipt" title={t("maintenanceDetail.noQuotes")} /> : (
                <ul className="divide-y divide-slate-100">
                  {d.quotes.map((q) => (
                    <li key={q.id} className="space-y-2 px-5 py-4">
                      <div className="flex flex-wrap items-center justify-between gap-2">
                        <span className="flex flex-wrap items-center gap-2 font-medium">
                          {formatMoney(q.amount)} <StatusBadge map={QUOTE_STATUS} value={q.status} />
                          {q.vendorName && <span className="text-sm text-slate-500">{q.vendorName}</span>}
                          {q.quoteNumber && <span className="text-xs text-slate-400 ltr">{q.quoteNumber}</span>}
                        </span>
                        <span className="flex flex-wrap gap-1">
                          {q.status === "DRAFT" && d.capabilities.createQuote && <Button variant="secondary" onClick={() => void quoteAction(q, "submit")}>{t("maintenanceDetail.submit")}</Button>}
                          {q.status === "SUBMITTED" && d.capabilities.approveQuote && <Button variant="ghost" onClick={() => void quoteAction(q, "review")}>{t("common.startReview")}</Button>}
                          {["SUBMITTED", "UNDER_REVIEW"].includes(q.status) && d.capabilities.approveQuote && <Button onClick={() => void quoteAction(q, "approve")}>{t("common.approve")}</Button>}
                          {["SUBMITTED", "UNDER_REVIEW"].includes(q.status) && d.capabilities.rejectQuote && <Button variant="danger" onClick={() => setQuoteReject(q)}>{t("common.reject")}</Button>}
                        </span>
                      </div>
                      <p className="text-xs text-slate-500">{t("maintenanceDetail.validUntilCreatedBy", { validUntil: formatDate(q.validUntil), createdByName: q.createdByName, value: q.reviewReason ? ` · ${q.reviewReason}` : "" })}</p>
                      <FileAttachment fileName={q.fileName} downloadPath={`/maintenance-quotes/${q.id}/file`} uploadPath={`/maintenance-quotes/${q.id}/file`} canUpload={d.capabilities.createQuote && ["DRAFT", "SUBMITTED"].includes(q.status)} onUploaded={reload} />
                    </li>
                  ))}
                </ul>
              )}
            </Card>
          )}
          <Attachments d={d} reload={reload} />
        </div>

        <Card className="h-fit">
          <CardHeader title={t("maintenanceDetail.timeline")} />
          {d.timeline.length === 0 ? <EmptyState icon="clock" title={t("maintenanceDetail.noEvents")} /> : (
            <ol className="relative ms-7 me-4 my-4 border-s border-slate-200">
              {d.timeline.map((e) => (
                <li key={e.id} className="ms-5 pb-5">
                  <span className="absolute -start-1.5 mt-1.5 size-3 rounded-full border-2 border-white bg-brand-600" />
                  <p className="text-sm font-medium text-slate-800">{EVENT_LABEL[e.type] ?? e.type}</p>
                  {e.toStatus && e.fromStatus && <p className="text-xs text-slate-500">{MAINTENANCE_STATUS[e.fromStatus]?.label} ← {MAINTENANCE_STATUS[e.toStatus]?.label}</p>}
                  {e.reason && <p className="mt-0.5 text-xs text-red-700">{t("common.reason2", { reason: e.reason })}</p>}
                  <p className="text-xs text-slate-400">{e.actor ?? t("common.system")} · {formatDateTime(e.createdAt)}</p>
                </li>
              ))}
            </ol>
          )}
        </Card>
      </div>

      {modal === "assign" && <AssignModal id={id} current={d.assignedTo} onClose={() => setModal(null)} onDone={reload} />}
      {modal && REASON_ACTIONS.has(modal) && <ReasonModal title={ACTION_LABEL[modal]!} danger onClose={() => setModal(null)} onSubmit={(r) => runAction(modal, r)} />}
      {modal === "part" && <PartModal id={id} onClose={() => setModal(null)} onDone={reload} />}
      {modal === "labor" && <LaborModal id={id} onClose={() => setModal(null)} onDone={reload} />}
      {modal === "quote" && <QuoteModal id={id} onClose={() => setModal(null)} onDone={reload} />}
      {quoteReject && (
        <ReasonModal
          title={t("maintenanceDetail.rejectQuote")}
          danger
          onClose={() => setQuoteReject(null)}
          onSubmit={async (reason) => {
            await api(`/maintenance-quotes/${quoteReject.id}/reject`, { method: "POST", body: { reason } });
            toast.success(t("maintenanceDetail.quoteRejected2"));
            reload();
          }}
        />
      )}
    </>
  );
}
