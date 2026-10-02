import { useEffect, useState } from "react";
import { DataList, ListBody } from "../../components/DataList";
import { useToast } from "../../components/feedback";
import { Icon } from "../../components/icons";
import { Alert, Badge, Button, Card, CardHeader, Field, Input, Loading, Pagination, Select } from "../../components/ui";
import { useApi } from "../../hooks/useApi";
import { useListState } from "../../hooks/useListState";
import { api, ApiError } from "../../lib/api";
import { formatDateTime } from "../../lib/format";
import { NOTIFICATION_CATEGORY, type Tone } from "../../lib/labels";
import { t, tDynamic } from "../../i18n";

type EmailView = {
  effective: { configured: boolean; problem: string | null; host: string | null; port: number; security: string; user: string | null; fromEmail: string | null; fromName: string; supportEmail: string | null; passwordSet: boolean; source: { host: string; password: string } };
  saved: { smtpHost: string | null; smtpPort: number | null; smtpUser: string | null; smtpSecurity: string | null; fromName: string | null; fromEmail: string | null; supportEmail: string | null; passwordSaved: boolean; notificationsEnabled: boolean; categories: Record<string, boolean>; updatedAt: string | null };
  canStorePassword: boolean;
};
type LogRow = { id: string; recipient: string; type: string; category: string | null; subject: string; status: string; attempts: number; failureReason: string | null; createdAt: string; sentAt: string | null };

const STATUS_TONE: Record<string, Tone> = { SENT: "green", FAILED: "red", QUEUED: "blue", SENDING: "blue", SKIPPED: "gray" };
const statusLabel = (s: string) => tDynamic(`emailSettings.status.${s}`, s);
const typeLabel = (s: string) => tDynamic(`emailSettings.type.${s}`, s);

/** Settings → "إعدادات البريد الإلكتروني" (administrators). The SMTP password is write-only. */
export function EmailSettingsTab() {
  const toast = useToast();
  const { data, loading, error, reload, setData } = useApi<{ data: EmailView }>("/settings/email");
  const [form, setForm] = useState<Record<string, string>>({});
  const [password, setPassword] = useState("");
  const [busy, setBusy] = useState<string | null>(null);
  const [testTo, setTestTo] = useState("");
  const [errors, setErrors] = useState<Record<string, string>>({});

  useEffect(() => {
    if (!data) return;
    const s = data.data.saved;
    setForm({ smtpHost: s.smtpHost ?? "", smtpPort: s.smtpPort ? String(s.smtpPort) : "", smtpUser: s.smtpUser ?? "", smtpSecurity: s.smtpSecurity ?? "", fromName: s.fromName ?? "", fromEmail: s.fromEmail ?? "", supportEmail: s.supportEmail ?? "" });
  }, [data]);

  if (loading && !data) return <Loading />;
  if (error || !data) return <Alert>{error?.message ?? t("common.couldNotLoad")}</Alert>;
  const v = data.data;
  const set = (k: string) => (e: { target: { value: string } }) => setForm((f) => ({ ...f, [k]: e.target.value }));

  const save = async (extra: Record<string, unknown> = {}, label = "save") => {
    setBusy(label);
    setErrors({});
    try {
      const body: Record<string, unknown> = { ...form, smtpPort: form.smtpPort ? Number(form.smtpPort) : null, smtpSecurity: form.smtpSecurity || null, ...extra };
      if (password) body.smtpPassword = password;
      const r = await api<{ data: EmailView }>("/settings/email", { method: "PUT", body });
      setData(r);
      setPassword("");
      toast.success(t("emailSettings.saved"));
    } catch (err) {
      if (err instanceof ApiError) {
        setErrors(Object.fromEntries(((err.details as { path: string; message: string }[] | undefined) ?? []).map((d) => [d.path, d.message])));
        toast.error(err.message);
      } else toast.error(t("emailSettings.couldNotSave"));
    } finally {
      setBusy(null);
    }
  };

  const sendTest = async () => {
    setBusy("test");
    try {
      await api("/settings/email/test", { method: "POST", body: testTo.trim() ? { to: testTo.trim() } : {} });
      toast.success(t("emailSettings.testSent"));
    } catch (err) {
      toast.error(err instanceof ApiError ? err.message : t("emailSettings.testFailed"));
    } finally {
      setBusy(null);
      reload();
    }
  };

  return (
    <div className="space-y-6">
      <Card>
        <CardHeader title={t("emailSettings.title")} subtitle={t("emailSettings.subtitle")} />
        <div className="space-y-4 p-5">
          <div className={`flex items-start gap-3 rounded-xl p-4 text-sm ring-1 ${v.effective.configured ? "bg-emerald-50 text-emerald-900 ring-emerald-200" : "bg-amber-50 text-amber-900 ring-amber-200"}`} role="status">
            <Icon name={v.effective.configured ? "check" : "alert"} className="mt-0.5 size-5 shrink-0" />
            <div className="min-w-0 space-y-1">
              <p className="font-semibold">{v.effective.configured ? t("emailSettings.configured") : t("emailSettings.notConfigured")}</p>
              {!v.effective.configured && v.effective.problem && <p className="ltr text-xs opacity-80">{v.effective.problem}</p>}
              <p className="text-xs opacity-80">
                {t("emailSettings.effective", { host: v.effective.host ?? "—", port: v.effective.port, security: v.effective.security })} · {t("emailSettings.passwordStatus", { status: v.effective.passwordSet ? (v.effective.source.password === "env" ? t("emailSettings.passwordFromEnv") : t("emailSettings.passwordSaved")) : t("emailSettings.passwordNone") })}
              </p>
            </div>
          </div>

          <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
            <Field label={t("emailSettings.smtpHost")} htmlFor="smtp-host" error={errors.smtpHost} hint={!form.smtpHost && v.effective.source.host === "env" ? t("emailSettings.usingEnv") : undefined}>
              <Input id="smtp-host" dir="ltr" placeholder="smtp.example.com" value={form.smtpHost ?? ""} onChange={set("smtpHost")} />
            </Field>
            <div className="grid grid-cols-2 gap-3">
              <Field label={t("emailSettings.smtpPort")} htmlFor="smtp-port" error={errors.smtpPort}>
                <Input id="smtp-port" dir="ltr" inputMode="numeric" placeholder="587" value={form.smtpPort ?? ""} onChange={set("smtpPort")} />
              </Field>
              <Field label={t("emailSettings.security")} htmlFor="smtp-sec">
                <Select id="smtp-sec" value={form.smtpSecurity ?? ""} onChange={set("smtpSecurity")}>
                  <option value="">{t("emailSettings.securityAuto")}</option>
                  <option value="STARTTLS">STARTTLS (587)</option>
                  <option value="TLS">SSL/TLS (465)</option>
                  <option value="NONE">{t("emailSettings.securityNone")}</option>
                </Select>
              </Field>
            </div>
            <Field label={t("emailSettings.smtpUser")} htmlFor="smtp-user" error={errors.smtpUser}>
              <Input id="smtp-user" dir="ltr" autoComplete="off" value={form.smtpUser ?? ""} onChange={set("smtpUser")} />
            </Field>
            <Field
              label={t("emailSettings.smtpPassword")}
              htmlFor="smtp-pass"
              error={errors.smtpPassword}
              hint={v.canStorePassword ? (v.saved.passwordSaved ? t("emailSettings.passwordKeepHint") : t("emailSettings.passwordNewHint")) : t("emailSettings.passwordEnvOnly")}
            >
              <Input id="smtp-pass" type="password" dir="ltr" autoComplete="new-password" disabled={!v.canStorePassword} placeholder={v.saved.passwordSaved ? "••••••••" : ""} value={password} onChange={(e) => setPassword(e.target.value)} />
            </Field>
            <Field label={t("emailSettings.fromName")} htmlFor="from-name" error={errors.fromName}>
              <Input id="from-name" placeholder="Easy Fleet" value={form.fromName ?? ""} onChange={set("fromName")} />
            </Field>
            <Field label={t("emailSettings.fromEmail")} htmlFor="from-email" error={errors.fromEmail}>
              <Input id="from-email" type="email" dir="ltr" placeholder="no-reply@example.com" value={form.fromEmail ?? ""} onChange={set("fromEmail")} />
            </Field>
            <Field label={t("emailSettings.supportEmail")} htmlFor="support-email" error={errors.supportEmail} hint={t("emailSettings.supportHint")}>
              <Input id="support-email" type="email" dir="ltr" value={form.supportEmail ?? ""} onChange={set("supportEmail")} />
            </Field>
          </div>
          <div className="flex flex-wrap items-center gap-2">
            <Button loading={busy === "save"} onClick={() => void save()}>{t("common.save")}</Button>
            {v.saved.passwordSaved && <Button variant="ghost" loading={busy === "clearpw"} onClick={() => void save({ smtpPassword: "" }, "clearpw")}>{t("emailSettings.removePassword")}</Button>}
          </div>
        </div>
      </Card>

      <Card>
        <CardHeader title={t("emailSettings.testTitle")} subtitle={t("emailSettings.testSubtitle")} />
        <div className="flex flex-col gap-3 p-5 sm:flex-row sm:items-end">
          <div className="min-w-0 flex-1">
            <Field label={t("emailSettings.testTo")} htmlFor="test-to" hint={t("emailSettings.testToHint")}>
              <Input id="test-to" type="email" dir="ltr" value={testTo} onChange={(e) => setTestTo(e.target.value)} />
            </Field>
          </div>
          <Button icon="send" variant="secondary" loading={busy === "test"} disabled={!v.effective.configured} onClick={() => void sendTest()}>{t("emailSettings.sendTest")}</Button>
        </div>
      </Card>

      <Card>
        <CardHeader title={t("emailSettings.categoriesTitle")} subtitle={t("emailSettings.categoriesSubtitle")} />
        <ul className="divide-y divide-slate-100">
          <li className="flex items-center justify-between gap-3 px-5 py-3">
            <span className="text-sm font-medium">{t("emailSettings.masterSwitch")}</span>
            <Switch checked={v.saved.notificationsEnabled} disabled={busy !== null} onChange={(on) => void save({ notificationsEnabled: on }, "master")} label={t("emailSettings.masterSwitch")} />
          </li>
          {Object.entries(v.saved.categories).map(([c, on]) => (
            <li key={c} className="flex items-center justify-between gap-3 px-5 py-3">
              <span className="text-sm">{NOTIFICATION_CATEGORY[c] ?? c}</span>
              <Switch checked={on && v.saved.notificationsEnabled} disabled={busy !== null || !v.saved.notificationsEnabled} onChange={(next) => void save({ categories: { [c]: next } }, c)} label={NOTIFICATION_CATEGORY[c] ?? c} />
            </li>
          ))}
          <li className="px-5 py-3 text-xs text-slate-500">
            <Icon name="shield" className="me-1 inline size-4 align-text-bottom" />
            {t("emailSettings.securityAlwaysOn")}
          </li>
        </ul>
      </Card>

      <EmailLog />
    </div>
  );
}

export function Switch({ checked, onChange, disabled, label }: { checked: boolean; onChange: (v: boolean) => void; disabled?: boolean; label: string }) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={checked}
      aria-label={label}
      disabled={disabled}
      onClick={() => onChange(!checked)}
      className={`relative inline-flex h-6 w-11 shrink-0 items-center rounded-full transition-colors focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-brand-600 disabled:opacity-50 ${checked ? "bg-brand-600" : "bg-slate-300"}`}
    >
      <span className={`inline-block size-5 rounded-full bg-white shadow transition-transform ${checked ? "translate-x-[1.375rem] rtl:-translate-x-[1.375rem]" : "translate-x-0.5 rtl:-translate-x-0.5"}`} />
    </button>
  );
}

function EmailLog() {
  const list = useListState({ status: "" }, { pageSize: 15, persist: false });
  const { data, loading, error, reload } = useApi<{ data: LogRow[]; meta: { page: number; pageSize: number; total: number }; summary: Record<string, number> }>("/settings/email/log", list.query);
  return (
    <Card>
      <CardHeader
        title={t("emailSettings.logTitle")}
        subtitle={data ? t("emailSettings.logSummary", { sent: data.summary.SENT ?? 0, failed: data.summary.FAILED ?? 0, skipped: data.summary.SKIPPED ?? 0 }) : t("emailSettings.logSubtitle")}
        action={
          <div className="flex gap-2">
            <Select value={list.f.status} onChange={list.bind("status")} aria-label={t("common.status")} className="w-36">
              <option value="">{t("common.allStatuses")}</option>
              {["SENT", "FAILED", "QUEUED", "SKIPPED"].map((s) => <option key={s} value={s}>{statusLabel(s)}</option>)}
            </Select>
            <Button variant="secondary" icon="refresh" onClick={reload} aria-label={t("fleetMap.refreshNow")} />
          </div>
        }
      />
      <ListBody loading={loading} error={error} hasData={!!data} cols={5} empty={data && !data.data.length ? <p className="p-6 text-center text-sm text-slate-500">{t("emailSettings.logEmpty")}</p> : null}>
        {data && (
          <>
            <DataList
              rows={data.data}
              rowKey={(r) => r.id}
              columns={[
                { header: t("emailSettings.colRecipient"), primary: true, cell: (r) => <span className="ltr">{r.recipient}</span> },
                { header: t("emailSettings.colType"), cell: (r) => typeLabel(r.type) },
                { header: t("common.status"), cell: (r) => <span className="flex flex-wrap items-center gap-1"><Badge tone={STATUS_TONE[r.status] ?? "gray"} dot>{statusLabel(r.status)}</Badge>{r.failureReason && <span className="ltr max-w-56 truncate text-xs text-slate-500" title={r.failureReason}>{r.failureReason}</span>}</span> },
                { header: t("emailSettings.colSubject"), cell: (r) => <span className="block max-w-72 truncate" title={r.subject}>{r.subject}</span>, hideOnMobile: true },
                { header: t("emailSettings.colTime"), cell: (r) => formatDateTime(r.sentAt ?? r.createdAt) },
              ]}
            />
            <Pagination {...data.meta} onPage={list.setPage} />
          </>
        )}
      </ListBody>
    </Card>
  );
}
