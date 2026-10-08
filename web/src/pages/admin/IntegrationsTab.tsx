import { useEffect, useState } from "react";
import { useToast } from "../../components/feedback";
import { Alert, Badge, Button, Card, CardHeader, Field, Input, Loading } from "../../components/ui";
import { useApi } from "../../hooks/useApi";
import { api, ApiError } from "../../lib/api";
import { formatDateTime } from "../../lib/format";
import type { Tone } from "../../lib/labels";
import { t, tDynamic } from "../../i18n";
import { Switch } from "./EmailSettingsTab";

type Run = { id: string; status: string; startedAt: string; completedAt: string | null; message: string | null; errorSummary: string | null; recordsProcessed: number; recordsCreated: number; recordsUpdated: number; recordsSkipped: number };
type View = {
  enabled: boolean;
  status: string;
  statusMessage: string | null;
  baseUrl: string | null;
  clientId: string | null;
  apiKeySaved: boolean;
  clientSecretSaved: boolean;
  canStoreSecrets: boolean;
  lastTest: { at: string; status: string | null; message: string | null } | null;
  lastSyncAt: string | null;
  pendingReview: number;
};

const TONE: Record<string, Tone> = { DISABLED: "gray", WAITING_FOR_API: "amber", READY: "green", OK: "green", FAILED: "red", STARTED: "blue", COMPLETED: "green" };
const API = "/integrations/bright-washing";

/** Settings → "تكامل API". Secrets are write-only: the server only says whether one is saved. */
export function IntegrationsTab() {
  const toast = useToast();
  const { data, loading, error, setData } = useApi<{ data: View }>(API);
  const runs = useApi<{ data: Run[] }>(data?.data.enabled ? `${API}/runs` : null);
  const [form, setForm] = useState({ baseUrl: "", clientId: "" });
  const [apiKey, setApiKey] = useState("");
  const [clientSecret, setClientSecret] = useState("");
  const [busy, setBusy] = useState<string | null>(null);

  useEffect(() => {
    if (data) setForm({ baseUrl: data.data.baseUrl ?? "", clientId: data.data.clientId ?? "" });
  }, [data]);

  if (loading && !data) return <Loading />;
  if (error || !data) return <Alert>{error?.message ?? t("common.couldNotLoad")}</Alert>;
  const v = data.data;

  const save = async (body: Record<string, unknown>, label: string, done: string) => {
    setBusy(label);
    try {
      const r = await api<{ data: View }>(API, { method: "PUT", body });
      setData(r);
      setApiKey("");
      setClientSecret("");
      toast.success(done);
    } catch (err) {
      toast.error(err instanceof ApiError ? err.message : t("integrations.couldNotSave"));
    } finally {
      setBusy(null);
    }
  };

  const saveSettings = () => {
    const body: Record<string, unknown> = { baseUrl: form.baseUrl.trim() || null, clientId: form.clientId.trim() || null };
    if (apiKey) body.apiKey = apiKey;
    if (clientSecret) body.clientSecret = clientSecret;
    return save(body, "save", t("integrations.saved"));
  };

  const act = async (kind: "test" | "sync") => {
    setBusy(kind);
    try {
      await api(`${API}/${kind}`, { method: "POST" });
    } catch (err) {
      toast.error(err instanceof ApiError ? err.message : t("integrations.actionFailed"));
    } finally {
      const r = await api<{ data: View }>(API).catch(() => null);
      if (r) setData(r);
      runs.reload();
      setBusy(null);
    }
  };

  const statusLabel = (s: string) => tDynamic(`integrations.status.${s}`, s);

  return (
    <div className="space-y-6">
      <section aria-labelledby="int-available">
        <h2 id="int-available" className="mb-3 text-base font-semibold">{t("integrations.available")}</h2>
        <Card>
          <div className="flex flex-wrap items-center justify-between gap-4 p-5">
            <div className="min-w-0 flex-1">
              <h3 className="font-semibold">{t("integrations.brightWashing")}</h3>
              <p className="mt-1 text-sm text-slate-600">{t("integrations.brightWashingDesc")}</p>
            </div>
            <Switch checked={v.enabled} disabled={busy !== null} onChange={(on) => void save({ enabled: on }, "toggle", on ? t("integrations.enabledToast") : t("integrations.disabledToast"))} label={t("integrations.brightWashing")} />
          </div>
        </Card>
      </section>

      {v.enabled && (
        <>
          <Card>
            <CardHeader
              title={t("integrations.brightWashing")}
              subtitle={<span className="flex flex-wrap items-center gap-2">{t("integrations.connectionStatus")}: <Badge tone={TONE[v.status] ?? "gray"} dot>{statusLabel(v.status)}</Badge>{v.statusMessage && <span className="text-xs text-slate-500">{v.statusMessage}</span>}</span>}
              action={<Button loading={busy === "save"} onClick={() => void saveSettings()}>{t("integrations.saveSettings")}</Button>}
            />
            <div className="grid grid-cols-1 gap-4 p-5 sm:grid-cols-2">
              <div className="sm:col-span-2">
                <Field label={t("integrations.baseUrl")} htmlFor="i-url"><Input id="i-url" dir="ltr" inputMode="url" placeholder="https://" value={form.baseUrl} onChange={(e) => setForm({ ...form, baseUrl: e.target.value })} /></Field>
              </div>
              <Field label={t("integrations.apiKey")} hint={v.apiKeySaved ? t("integrations.secretSaved") : t("integrations.secretNotSaved")} htmlFor="i-key"><Input id="i-key" dir="ltr" type="password" autoComplete="off" value={apiKey} onChange={(e) => setApiKey(e.target.value)} placeholder={v.apiKeySaved ? "••••••••" : ""} /></Field>
              <Field label={t("integrations.clientId")} htmlFor="i-cid"><Input id="i-cid" dir="ltr" autoComplete="off" value={form.clientId} onChange={(e) => setForm({ ...form, clientId: e.target.value })} /></Field>
              <Field label={t("integrations.clientSecret")} hint={v.clientSecretSaved ? t("integrations.secretSaved") : t("integrations.secretNotSaved")} htmlFor="i-sec"><Input id="i-sec" dir="ltr" type="password" autoComplete="off" value={clientSecret} onChange={(e) => setClientSecret(e.target.value)} placeholder={v.clientSecretSaved ? "••••••••" : ""} /></Field>
              <p className="self-end text-xs text-slate-500">{v.canStoreSecrets ? t("integrations.secretsHint") : t("integrations.noServerKey")}</p>
            </div>
            <div className="flex flex-wrap items-center gap-3 border-t border-slate-100 p-5">
              <Button variant="secondary" loading={busy === "test"} disabled={busy !== null} onClick={() => void act("test")}>{t("integrations.testConnection")}</Button>
              <Button loading={busy === "sync"} disabled={busy !== null} onClick={() => void act("sync")}>{t("integrations.syncNow")}</Button>
              <dl className="ms-auto flex flex-wrap gap-x-6 gap-y-1 text-sm text-slate-600">
                <div><dt className="inline">{t("integrations.lastTest")}: </dt><dd className="inline">{v.lastTest ? `${statusLabel(v.lastTest.status ?? "")} · ${formatDateTime(v.lastTest.at)}` : t("integrations.never")}</dd></div>
                <div><dt className="inline">{t("integrations.lastSync")}: </dt><dd className="inline">{v.lastSyncAt ? formatDateTime(v.lastSyncAt) : t("integrations.never")}</dd></div>
                <div><dt className="inline">{t("integrations.pendingReview")}: </dt><dd className="inline">{v.pendingReview}</dd></div>
              </dl>
            </div>
          </Card>

          <Card>
            <CardHeader title={t("integrations.runs")} />
            {!runs.data ? <Loading /> : runs.data.data.length === 0 ? <p className="p-5 text-sm text-slate-500">{t("integrations.noRuns")}</p> : (
              <ul className="divide-y divide-slate-100">
                {runs.data.data.map((r) => (
                  <li key={r.id} className="flex flex-wrap items-center gap-3 px-5 py-3 text-sm">
                    <Badge tone={TONE[r.status] ?? "gray"}>{tDynamic(`integrations.run.${r.status}`, r.status)}</Badge>
                    <span className="text-slate-600">{formatDateTime(r.startedAt)}</span>
                    <span className="text-xs text-slate-500">{r.message ?? r.errorSummary ?? t("integrations.recordsDetail", { processed: r.recordsProcessed, created: r.recordsCreated, updated: r.recordsUpdated, skipped: r.recordsSkipped })}</span>
                  </li>
                ))}
              </ul>
            )}
          </Card>
        </>
      )}
    </div>
  );
}
