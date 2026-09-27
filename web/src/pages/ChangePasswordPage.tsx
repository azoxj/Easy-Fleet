import { useState, type FormEvent } from "react";
import { useNavigate } from "react-router";
import { Alert, Button, Card, Field, Input, PageHeader } from "../components/ui";
import { api, ApiError } from "../lib/api";
import { useAuth } from "../lib/auth";
import { t } from "../i18n";

export function ChangePasswordPage() {
  const { me, refresh, logout } = useAuth();
  const navigate = useNavigate();
  const [current, setCurrent] = useState("");
  const [next, setNext] = useState("");
  const [confirm, setConfirm] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setError(null);
    if (next !== confirm) return setError(t("changePassword.thePasswordsDoNotMatch"));
    setBusy(true);
    try {
      await api("/auth/change-password", { method: "POST", body: { currentPassword: current, newPassword: next } });
      await refresh();
      navigate("/", { replace: true });
    } catch (err) {
      setError(err instanceof ApiError ? err.message : t("changePassword.couldNotChangeThePassword"));
    } finally {
      setBusy(false);
    }
  };

  const forced = me?.mustChangePassword;
  const form = (
    <Card className="w-full max-w-md p-6">
      <form onSubmit={submit} className="space-y-4">
        {forced && <Alert tone="amber">{t("changePassword.forYourAccountSSecurity")}</Alert>}
        {error && <Alert>{error}</Alert>}
        <Field label={t("changePassword.currentPassword")} htmlFor="cur" required>
          <Input id="cur" type="password" dir="ltr" autoComplete="current-password" value={current} onChange={(e) => setCurrent(e.target.value)} />
        </Field>
        <Field label={t("changePassword.newPassword")} htmlFor="new" required hint={t("changePassword.atLeast10CharactersIncluding")}>
          <Input id="new" type="password" dir="ltr" autoComplete="new-password" value={next} onChange={(e) => setNext(e.target.value)} />
        </Field>
        <Field label={t("changePassword.confirmNewPassword")} htmlFor="confirm" required>
          <Input id="confirm" type="password" dir="ltr" autoComplete="new-password" value={confirm} onChange={(e) => setConfirm(e.target.value)} />
        </Field>
        <div className="flex gap-2">
          <Button type="submit" loading={busy} disabled={!current || !next || !confirm}>
            {t("changePassword.savePassword")}
          </Button>
          {forced && (
            <Button variant="ghost" onClick={() => void logout().then(() => navigate("/login"))}>
              {t("common.signOut")}
            </Button>
          )}
        </div>
      </form>
    </Card>
  );

  if (forced) {
    return (
      <div className="flex min-h-full items-center justify-center px-4 py-12">
        <div className="w-full max-w-md">
          <h1 className="mb-4 text-xl font-bold">{t("changePassword.setANewPassword")}</h1>
          {form}
        </div>
      </div>
    );
  }
  return (
    <>
      <PageHeader title={t("common.changePassword")} subtitle={t("changePassword.youWillBeSignedOut")} />
      {form}
    </>
  );
}
