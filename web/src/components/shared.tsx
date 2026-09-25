import { useState, type ReactNode } from "react";
import { Link } from "react-router";
import { useApi } from "../hooks/useApi";
import type { Paged } from "../lib/api";
import { useAuth } from "../lib/auth";
import { formatDateTime } from "../lib/format";
import { errorMessage } from "../lib/forms";
import { AUDIT_ACTION } from "../lib/labels";
import type { Project, Vehicle } from "../lib/types";
import { useToast } from "./feedback";
import { Icon } from "./icons";
import { Alert, Button, EmptyState, Field, Input, Modal, Select, Textarea } from "./ui";

export const todayIso = () => {
  const d = new Date();
  return new Date(d.getTime() - d.getTimezoneOffset() * 60_000).toISOString().slice(0, 10);
};

export const nowLocalInput = () => {
  const d = new Date();
  return new Date(d.getTime() - d.getTimezoneOffset() * 60_000).toISOString().slice(0, 16);
};

/** datetime-local value → ISO string with the browser offset. */
export const localToIso = (v: string) => new Date(v).toISOString();

export function BackLink({ to, label }: { to: string; label: string }) {
  return (
    <Link to={to} className="mb-2 inline-flex items-center gap-1 text-sm text-slate-500 hover:text-slate-700">
      <Icon name="chevron" className="size-4" /> {label}
    </Link>
  );
}

/** Asks for a reason/notes before running an action. */
export function ReasonModal({
  open,
  title,
  label = "السبب",
  required = true,
  danger,
  confirmLabel = "تأكيد",
  onClose,
  onSubmit,
  children,
}: {
  open: boolean;
  title: string;
  label?: string;
  required?: boolean;
  danger?: boolean;
  confirmLabel?: string;
  onClose: () => void;
  onSubmit: (reason: string) => Promise<void>;
  children?: ReactNode;
}) {
  const [reason, setReason] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const submit = async () => {
    if (required && reason.trim().length < 3) return setError("يرجى كتابة السبب (3 أحرف على الأقل)");
    setBusy(true);
    setError(null);
    try {
      await onSubmit(reason.trim());
      setReason("");
      onClose();
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setBusy(false);
    }
  };
  return (
    <Modal open={open} onClose={onClose} title={title} footer={<><Button variant="secondary" onClick={onClose}>إلغاء</Button><Button variant={danger ? "danger" : "primary"} loading={busy} onClick={submit}>{confirmLabel}</Button></>}>
      <div className="space-y-4">
        {error && <Alert>{error}</Alert>}
        {children}
        <Field label={label} required={required} htmlFor="reason-input">
          <Textarea id="reason-input" value={reason} onChange={(e) => setReason(e.target.value)} maxLength={1000} />
        </Field>
      </div>
    </Modal>
  );
}

/** Search box + collapsible filters. */
export function FilterBar({ q, onQ, placeholder, active, children, onClear }: { q?: string; onQ?: (v: string) => void; placeholder?: string; active: number; children: ReactNode; onClear: () => void }) {
  const [open, setOpen] = useState(false);
  return (
    <div className="space-y-3 border-b border-slate-100 p-4">
      <div className="flex gap-2">
        {onQ && <Input placeholder={placeholder ?? "بحث..."} value={q ?? ""} onChange={(e) => onQ(e.target.value)} aria-label="بحث" />}
        <Button variant="secondary" onClick={() => setOpen((s) => !s)} aria-expanded={open} className={onQ ? "" : "w-full sm:w-auto"}>
          الفلاتر{active ? ` (${active})` : ""}
        </Button>
      </div>
      {open && (
        <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-4">
          {children}
          {active > 0 && <Button variant="ghost" onClick={onClear}>مسح الفلاتر</Button>}
        </div>
      )}
    </div>
  );
}

export function useProjects() {
  const { can } = useAuth();
  return useApi<Paged<Project>>(can("projects.read") ? "/projects" : null, { pageSize: 100 }).data?.data ?? [];
}

export function useVehicles(query: Record<string, string | undefined> = {}) {
  const { can } = useAuth();
  return useApi<Paged<Vehicle>>(can("vehicles.read") ? "/vehicles" : null, { pageSize: 100, ...query }).data?.data ?? [];
}

export function ProjectSelect({ value, onChange, projects, all = "كل المشاريع", id }: { value: string; onChange: (v: string) => void; projects: Project[]; all?: string | null; id?: string }) {
  return (
    <Select id={id} value={value} onChange={(e) => onChange(e.target.value)} aria-label="المشروع">
      {all !== null && <option value="">{all}</option>}
      {projects.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}
    </Select>
  );
}

export function VehicleSelect({ value, onChange, vehicles, all = "كل المركبات", id }: { value: string; onChange: (v: string) => void; vehicles: Vehicle[]; all?: string | null; id?: string }) {
  return (
    <Select id={id} value={value} onChange={(e) => onChange(e.target.value)} aria-label="المركبة">
      {all !== null && <option value="">{all}</option>}
      {vehicles.map((v) => <option key={v.id} value={v.id}>{v.plateNumber} — {v.make} {v.model}</option>)}
    </Select>
  );
}

export function DateRange({ from, to, onFrom, onTo }: { from: string; to: string; onFrom: (v: string) => void; onTo: (v: string) => void }) {
  return (
    <>
      <label className="flex items-center gap-2 text-sm text-slate-500">من <Input type="date" value={from} onChange={(e) => onFrom(e.target.value)} aria-label="من تاريخ" /></label>
      <label className="flex items-center gap-2 text-sm text-slate-500">إلى <Input type="date" value={to} onChange={(e) => onTo(e.target.value)} aria-label="إلى تاريخ" /></label>
    </>
  );
}

export type AuditRow = { id: number; action: string; metadata: Record<string, unknown> | null; oldValue: Record<string, unknown> | null; newValue: Record<string, unknown> | null; createdAt: string; userName: string | null };

/** Read-only history of one record (append-only audit trail). */
export function RecordTimeline({ rows }: { rows: AuditRow[] }) {
  if (!rows.length) return <EmptyState icon="clock" title="لا يوجد سجل" />;
  return (
    <ol className="relative ms-3 border-s border-slate-200">
      {rows.map((e) => (
        <li key={e.id} className="ms-6 pb-5">
          <span className="absolute -start-1.5 mt-1.5 size-3 rounded-full border-2 border-white bg-brand-600" />
          <p className="text-sm font-medium text-slate-800">{AUDIT_ACTION[e.action] ?? e.action}</p>
          {e.newValue && Object.keys(e.newValue).length > 0 && (
            <p className="mt-0.5 text-xs break-words text-slate-500">
              {Object.entries(e.newValue).map(([k, v]) => `${k}: ${e.oldValue?.[k] !== undefined ? `${String(e.oldValue[k] ?? "—")} ← ` : ""}${String(v ?? "—")}`).join(" · ")}
            </p>
          )}
          {typeof e.metadata?.reason === "string" && <p className="mt-0.5 text-xs text-slate-600">السبب: {e.metadata.reason}</p>}
          <p className="mt-0.5 text-xs text-slate-400">{e.userName ?? "النظام/رابط السائق"} · {formatDateTime(e.createdAt)}</p>
        </li>
      ))}
    </ol>
  );
}

/** Runs an async action with a toast and busy state. */
export function useAction() {
  const toast = useToast();
  const [busy, setBusy] = useState<string | null>(null);
  const run = async (key: string, fn: () => Promise<unknown>, success: string) => {
    setBusy(key);
    try {
      await fn();
      toast.success(success);
      return true;
    } catch (err) {
      toast.error(errorMessage(err));
      return false;
    } finally {
      setBusy(null);
    }
  };
  return { busy, run };
}

export function Money({ value }: { value: string | number | null | undefined }) {
  if (value === null || value === undefined || value === "") return <span className="text-slate-400">—</span>;
  return <span className="whitespace-nowrap">{new Intl.NumberFormat("ar-SA-u-nu-latn", { maximumFractionDigits: 2 }).format(Number(value))} <span className="text-xs text-slate-500">ريال</span></span>;
}
