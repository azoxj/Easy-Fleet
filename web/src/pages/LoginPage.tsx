import { useState, type FormEvent, type ReactNode } from "react";
import { Link, Navigate, useLocation, useNavigate } from "react-router";

import { Alert, Button, Field, Input } from "../components/ui";
import { ApiError } from "../lib/api";
import { useAuth } from "../lib/auth";
import { isRtl, t } from "../i18n";
import { LanguageSwitcher } from "../components/LanguageSwitcher";

export function LoginPage() {
  const { me, login } = useAuth();
  const navigate = useNavigate();
  const location = useLocation();
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  if (me) return <Navigate to={me.mustChangePassword ? "/change-password" : "/"} replace />;

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setError(null);
    setBusy(true);
    try {
      const m = await login(email, password);
      const from = (location.state as { from?: string } | null)?.from;
      navigate(m.mustChangePassword ? "/change-password" : from && from.startsWith("/") && !from.startsWith("//") ? from : "/", { replace: true });
    } catch (err) {
      setError(err instanceof ApiError ? err.message : t("login.couldNotSignIn"));
    } finally {
      setBusy(false);
    }
  };

  return (
    <AuthShell>
        <form onSubmit={submit} className="w-full max-w-md space-y-6 rounded-3xl border border-slate-200 bg-white p-6 shadow-xl shadow-slate-900/5 sm:p-9" noValidate>
          <AuthBrand />
          <div>
            <h1 className="text-2xl font-bold text-slate-900">{t("login.signIn")}</h1>
            <p className="mt-1 text-sm text-slate-500">{t("login.enterYourAccountDetailsTo")}</p>
          </div>
          {error && <Alert>{error}</Alert>}
          <Field label={t("common.email")} htmlFor="email">
            <Input id="email" type="email" autoComplete="username" dir="ltr" required value={email} onChange={(e) => setEmail(e.target.value)} />
          </Field>
          <Field label={t("login.password")} htmlFor="password">
            <Input id="password" type="password" autoComplete="current-password" dir="ltr" required value={password} onChange={(e) => setPassword(e.target.value)} />
          </Field>
          <Button type="submit" className="w-full py-2.5" loading={busy} disabled={!email || !password}>
            {t("login.signIn2")}
          </Button>
          <p className="text-center text-sm">
            <Link to="/forgot-password" state={{ email }} className="font-medium text-brand-700 hover:underline">{t("passwordReset.forgotLink")}</Link>
          </p>
        </form>
    </AuthShell>
  );
}

/** Two-panel layout shared by sign-in, forgot password and reset password. */
export function AuthShell({ children }: { children: ReactNode }) {
  return (
    <div className="grid min-h-screen bg-[#E9EEF5] lg:grid-cols-2">
      <div className="relative hidden flex-col justify-between overflow-hidden bg-ink-950 p-12 text-white lg:flex">
        <div className="relative z-10 flex items-center gap-3">
          <span className="grid size-11 place-items-center rounded-xl bg-brand-600">
            <img src="/brand/ef-logo.svg" alt="EF" className="size-full rounded-xl object-contain" />
          </span>
          <div>
            <p className="text-lg font-bold">EF</p>
            {isRtl() && <p className="text-xs text-slate-400 ltr" lang="en">Fleet Management System</p>}
          </div>
        </div>
        <div className="relative z-10 max-w-md">
          <h2 className="text-3xl leading-snug font-bold">{t("login.fleetAndVehicleManagementIn")}</h2>
          <p className="mt-4 text-slate-400">{t("login.projectsVehiclesAssignmentsAndPermissions")}</p>
        </div>
        <p className="text-xs text-slate-500">{t("login.internalSystemAuthorizedUsersOnly")}</p>
      </div>
      <div className="relative flex items-center justify-center bg-[#E9EEF5] px-4 py-12 sm:px-8">
        <LanguageSwitcher className="absolute top-4 end-4" />
        {children}
      </div>
    </div>
  );
}

/** Small brand line for phones (the side panel is hidden there). */
export function AuthBrand() {
  return (
    <div className="lg:hidden flex items-center gap-3 mb-2">
      <span className="grid size-10 place-items-center rounded-xl bg-brand-700 text-white">
        <img src="/brand/ef-logo.svg" alt="EF" className="h-full w-full rounded-xl object-contain" />
      </span>
      <div>
        <p className="font-bold">EF</p>
        {isRtl() && <p className="text-xs text-slate-500 ltr" lang="en">Fleet Management System</p>}
      </div>
    </div>
  );
}
