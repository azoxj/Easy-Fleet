import { useEffect, useState, type FormEvent } from "react";
import { Link, useLocation } from "react-router";
import { Icon } from "../components/icons";
import { Alert, Button, Field, Input, Loading } from "../components/ui";
import { api, ApiError } from "../lib/api";
import { t } from "../i18n";
import { AuthBrand, AuthShell } from "./LoginPage";

/** Mirrors the server policy (≥ 10 characters, 3 of: lowercase, uppercase, digits, symbols). */
export function passwordChecks(pw: string) {
  const v = pw.replace(/[٠-٩]/g, (d) => String(d.charCodeAt(0) - 0x0660)).replace(/[۰-۹]/g, (d) => String(d.charCodeAt(0) - 0x06f0));
  const classes = [/[a-z]/, /[A-Z]/, /[0-9]/, /[^A-Za-z0-9]/].filter((re) => re.test(v)).length;
  return { length: v.length >= 10, classes: classes >= 3, ok: v.length >= 10 && v.length <= 128 && classes >= 3 };
}

/** "نسيت كلمة المرور؟" — always ends on the same neutral message, whatever the email. */
export function ForgotPasswordPage() {
  const location = useLocation();
  const [email, setEmail] = useState(((location.state as { email?: string } | null)?.email ?? "").trim());
  const [done, setDone] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setError(null);
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email.trim())) return setError(t("passwordReset.enterValidEmail"));
    setBusy(true);
    try {
      const r = await api<{ data: { message: string } }>("/auth/forgot-password", { method: "POST", body: { email: email.trim() } });
      setDone(r.data.message);
    } catch (err) {
      // rate limit or network: never says anything about the account
      setError(err instanceof ApiError && err.status === 429 ? t("passwordReset.tooManyRequests") : t("passwordReset.couldNotSend"));
    } finally {
      setBusy(false);
    }
  };

  return (
    <AuthShell>
      <div className="w-full max-w-sm space-y-5">
        <AuthBrand />
        <div>
          <h1 className="text-2xl font-bold text-slate-900">{t("passwordReset.forgotTitle")}</h1>
          <p className="mt-1 text-sm text-slate-500">{t("passwordReset.forgotSubtitle")}</p>
        </div>
        {done ? (
          <div className="ef-fade-up space-y-4" role="status">
            <div className="flex gap-3 rounded-xl bg-emerald-50 p-4 text-sm leading-relaxed text-emerald-900 ring-1 ring-emerald-200">
              <Icon name="check" className="mt-0.5 size-5 shrink-0" />
              <p>{done}</p>
            </div>
            <p className="text-xs leading-relaxed text-slate-500">{t("passwordReset.checkSpam")}</p>
            <Link to="/login" className="flex items-center justify-center gap-1.5 text-sm font-medium text-brand-700 hover:underline">
              <Icon name="back" className="size-4" />
              {t("passwordReset.backToLogin")}
            </Link>
          </div>
        ) : (
          <form onSubmit={submit} className="space-y-5" noValidate>
            {error && <Alert>{error}</Alert>}
            <Field label={t("common.email")} htmlFor="reset-email">
              <Input id="reset-email" type="email" autoComplete="username" dir="ltr" required autoFocus value={email} onChange={(e) => setEmail(e.target.value)} />
            </Field>
            <Button type="submit" className="w-full py-2.5" loading={busy} disabled={!email.trim()}>
              {t("passwordReset.sendLink")}
            </Button>
            <p className="text-center text-sm">
              <Link to="/login" className="font-medium text-brand-700 hover:underline">{t("passwordReset.backToLogin")}</Link>
            </p>
          </form>
        )}
      </div>
    </AuthShell>
  );
}

/**
 * Reset page opened from the email link (/reset-password#token=…). The token is
 * read from the URL fragment (never sent to the server in the URL) and removed
 * from the address bar and history right away.
 */
export function ResetPasswordPage() {
  const [token] = useState(() => new URLSearchParams(window.location.hash.slice(1)).get("token") ?? "");
  const [valid, setValid] = useState<boolean | null>(null);
  const [password, setPassword] = useState("");
  const [confirm, setConfirm] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [done, setDone] = useState(false);

  useEffect(() => {
    if (window.location.hash) window.history.replaceState(window.history.state, "", window.location.pathname);
    if (!token) return setValid(false);
    api<{ data: { valid: boolean } }>("/auth/reset-password/verify", { method: "POST", body: { token } })
      .then((r) => setValid(r.data.valid))
      .catch(() => setValid(false));
  }, [token]);

  const checks = passwordChecks(password);
  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setError(null);
    if (!checks.ok) return setError(t("passwordReset.policyNotMet"));
    if (password !== confirm) return setError(t("passwordReset.mismatch"));
    setBusy(true);
    try {
      await api("/auth/reset-password", { method: "POST", body: { token, password } });
      setDone(true);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : t("passwordReset.couldNotReset"));
    } finally {
      setBusy(false);
    }
  };

  return (
    <AuthShell>
      <div className="w-full max-w-sm space-y-5">
        <AuthBrand />
        <div>
          <h1 className="text-2xl font-bold text-slate-900">{t("passwordReset.resetTitle")}</h1>
          {!done && valid && <p className="mt-1 text-sm text-slate-500">{t("passwordReset.resetSubtitle")}</p>}
        </div>
        {valid === null ? (
          <Loading />
        ) : done ? (
          <div className="ef-fade-up space-y-4" role="status">
            <div className="flex gap-3 rounded-xl bg-emerald-50 p-4 text-sm leading-relaxed text-emerald-900 ring-1 ring-emerald-200">
              <Icon name="check" className="mt-0.5 size-5 shrink-0" />
              <p>{t("passwordReset.success")}</p>
            </div>
            <Link to="/login" className="flex w-full items-center justify-center rounded-lg bg-brand-700 px-3.5 py-2.5 text-sm font-medium text-white shadow-sm hover:bg-brand-800">
              {t("passwordReset.goToLogin")}
            </Link>
          </div>
        ) : !valid ? (
          <div className="space-y-4">
            <Alert>{t("passwordReset.invalidLink")}</Alert>
            <Link to="/forgot-password" className="flex w-full items-center justify-center rounded-lg bg-brand-700 px-3.5 py-2.5 text-sm font-medium text-white shadow-sm hover:bg-brand-800">
              {t("passwordReset.requestNewLink")}
            </Link>
            <p className="text-center text-sm">
              <Link to="/login" className="font-medium text-brand-700 hover:underline">{t("passwordReset.backToLogin")}</Link>
            </p>
          </div>
        ) : (
          <form onSubmit={submit} className="space-y-5" noValidate>
            {error && <Alert>{error}</Alert>}
            <Field label={t("passwordReset.newPassword")} htmlFor="new-password">
              <Input id="new-password" type="password" autoComplete="new-password" dir="ltr" required autoFocus value={password} onChange={(e) => setPassword(e.target.value)} aria-describedby="pw-rules" />
            </Field>
            <ul id="pw-rules" className="space-y-1 text-xs">
              {[
                { ok: checks.length, label: t("passwordReset.ruleLength") },
                { ok: checks.classes, label: t("passwordReset.ruleClasses") },
              ].map((r) => (
                <li key={r.label} className={`flex items-center gap-1.5 ${r.ok ? "text-emerald-700" : "text-slate-500"}`}>
                  <Icon name={r.ok ? "check" : "x"} className="size-3.5" />
                  {r.label}
                </li>
              ))}
            </ul>
            <Field label={t("passwordReset.confirmPassword")} htmlFor="confirm-password" error={confirm && confirm !== password ? t("passwordReset.mismatch") : undefined}>
              <Input id="confirm-password" type="password" autoComplete="new-password" dir="ltr" required value={confirm} onChange={(e) => setConfirm(e.target.value)} />
            </Field>
            <Button type="submit" className="w-full py-2.5" loading={busy} disabled={!password || !confirm}>
              {t("passwordReset.save")}
            </Button>
            <p className="text-xs leading-relaxed text-slate-500">{t("passwordReset.signOutNote")}</p>
          </form>
        )}
      </div>
    </AuthShell>
  );
}
