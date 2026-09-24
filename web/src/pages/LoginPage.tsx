import { useState, type FormEvent } from "react";
import { Navigate, useLocation, useNavigate } from "react-router";
import { Icon } from "../components/icons";
import { Alert, Button, Field, Input } from "../components/ui";
import { ApiError } from "../lib/api";
import { useAuth } from "../lib/auth";

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
      setError(err instanceof ApiError ? err.message : "تعذر تسجيل الدخول");
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="grid min-h-full lg:grid-cols-2">
      <div className="hidden flex-col justify-between bg-ink-950 p-10 text-white lg:flex">
        <div className="flex items-center gap-3">
          <span className="grid size-11 place-items-center rounded-xl bg-brand-600">
            <Icon name="truck" className="size-6" />
          </span>
          <div>
            <p className="text-lg font-bold">إيزي فليت</p>
            <p className="text-xs text-slate-400 ltr">Easy Fleet</p>
          </div>
        </div>
        <div className="max-w-md">
          <h2 className="text-3xl leading-snug font-bold">إدارة الأسطول والمركبات في منصة واحدة آمنة</h2>
          <p className="mt-4 text-slate-400">المشاريع، المركبات، الإسنادات والصلاحيات — مع سجل تدقيق كامل لكل عملية.</p>
        </div>
        <p className="text-xs text-slate-500">نظام داخلي — الدخول للمصرح لهم فقط</p>
      </div>
      <div className="flex items-center justify-center px-4 py-12">
        <form onSubmit={submit} className="w-full max-w-sm space-y-5" noValidate>
          <div className="lg:hidden flex items-center gap-3 mb-2">
            <span className="grid size-10 place-items-center rounded-xl bg-brand-700 text-white">
              <Icon name="truck" />
            </span>
            <div>
              <p className="font-bold">إيزي فليت</p>
              <p className="text-xs text-slate-500 ltr">Easy Fleet</p>
            </div>
          </div>
          <div>
            <h1 className="text-2xl font-bold text-slate-900">تسجيل الدخول</h1>
            <p className="mt-1 text-sm text-slate-500">أدخل بيانات حسابك للمتابعة</p>
          </div>
          {error && <Alert>{error}</Alert>}
          <Field label="البريد الإلكتروني" htmlFor="email">
            <Input id="email" type="email" autoComplete="username" dir="ltr" required value={email} onChange={(e) => setEmail(e.target.value)} />
          </Field>
          <Field label="كلمة المرور" htmlFor="password">
            <Input id="password" type="password" autoComplete="current-password" dir="ltr" required value={password} onChange={(e) => setPassword(e.target.value)} />
          </Field>
          <Button type="submit" className="w-full py-2.5" loading={busy} disabled={!email || !password}>
            دخول
          </Button>
        </form>
      </div>
    </div>
  );
}
