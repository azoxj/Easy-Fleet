import { useEffect, useState } from "react";
import { Link, useSearchParams } from "react-router";
import { useToast } from "../../components/feedback";
import { Icon } from "../../components/icons";
import { useAction } from "../../components/shared";
import { Alert, Button, Card, CardHeader, DescList, Field, Input, Loading, PageHeader, Select, Tabs, Textarea } from "../../components/ui";
import { useApi } from "../../hooks/useApi";
import { api } from "../../lib/api";
import { useAuth } from "../../lib/auth";
import { formatDateTime } from "../../lib/format";
import { errorMessage, fieldErrors } from "../../lib/forms";
import { NOTIFICATION_CATEGORY } from "../../lib/labels";

type Company = { name: string; legalName: string | null; taxNumber: string | null; crNumber: string | null; address: string | null; phone: string | null; email: string | null; settings: { currency: string; vatRate: number; fiscalYearStartMonth: number; handoverLinkDays: number } };

function CompanyTab() {
  const { data, loading, error, reload } = useApi<{ data: Company; meta: { canEdit: boolean } }>("/settings/company");
  const toast = useToast();
  const [v, setV] = useState<Company | null>(null);
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState(false);
  useEffect(() => { if (data) setV(data.data); }, [data]);
  if (loading || !v) return error ? <Alert>{error.message}</Alert> : <Loading />;
  const canEdit = data!.meta.canEdit;
  const set = (k: keyof Company) => (e: { target: { value: string } }) => setV({ ...v, [k]: e.target.value });
  const save = async () => {
    setBusy(true);
    setErrors({});
    try {
      await api("/settings/company", { method: "PUT", body: { name: v.name, legalName: v.legalName ?? "", taxNumber: v.taxNumber ?? "", crNumber: v.crNumber ?? "", address: v.address ?? "", phone: v.phone ?? "", email: v.email ?? "", settings: { currency: v.settings.currency, vatRate: Number(v.settings.vatRate), fiscalYearStartMonth: Number(v.settings.fiscalYearStartMonth), handoverLinkDays: Number(v.settings.handoverLinkDays) } } });
      toast.success("تم حفظ بيانات الشركة");
      reload();
    } catch (err) {
      setErrors(fieldErrors(err));
      toast.error(errorMessage(err));
    } finally {
      setBusy(false);
    }
  };
  return (
    <Card>
      <CardHeader title="بيانات الشركة" subtitle={canEdit ? "تظهر في التقارير والمطبوعات" : "للعرض فقط — التعديل لمدير النظام"} action={canEdit && <Button loading={busy} onClick={save}>حفظ</Button>} />
      <fieldset disabled={!canEdit} className="grid grid-cols-1 gap-4 p-5 sm:grid-cols-2">
        <Field label="اسم الشركة" required error={errors.name} htmlFor="c-name"><Input id="c-name" value={v.name} onChange={set("name")} /></Field>
        <Field label="الاسم القانوني" htmlFor="c-legal"><Input id="c-legal" value={v.legalName ?? ""} onChange={set("legalName")} /></Field>
        <Field label="الرقم الضريبي (15 رقمًا)" error={errors.taxNumber} htmlFor="c-tax"><Input id="c-tax" dir="ltr" value={v.taxNumber ?? ""} onChange={set("taxNumber")} /></Field>
        <Field label="السجل التجاري (10 أرقام)" error={errors.crNumber} htmlFor="c-cr"><Input id="c-cr" dir="ltr" value={v.crNumber ?? ""} onChange={set("crNumber")} /></Field>
        <Field label="الهاتف" error={errors.phone} htmlFor="c-phone"><Input id="c-phone" dir="ltr" value={v.phone ?? ""} onChange={set("phone")} /></Field>
        <Field label="البريد الإلكتروني" error={errors.email} htmlFor="c-email"><Input id="c-email" dir="ltr" value={v.email ?? ""} onChange={set("email")} /></Field>
        <div className="sm:col-span-2"><Field label="العنوان" htmlFor="c-addr"><Textarea id="c-addr" value={v.address ?? ""} onChange={set("address")} /></Field></div>
        <Field label="العملة" htmlFor="c-cur"><Select id="c-cur" value={v.settings.currency} onChange={(e) => setV({ ...v, settings: { ...v.settings, currency: e.target.value } })}>{["SAR", "AED", "KWD", "BHD", "QAR", "OMR", "USD"].map((c) => <option key={c}>{c}</option>)}</Select></Field>
        <Field label="نسبة الضريبة الافتراضية %" htmlFor="c-vat"><Input id="c-vat" type="number" min={0} max={100} value={v.settings.vatRate} onChange={(e) => setV({ ...v, settings: { ...v.settings, vatRate: Number(e.target.value) } })} /></Field>
        <Field label="بداية السنة المالية (شهر)" htmlFor="c-fy"><Input id="c-fy" type="number" min={1} max={12} value={v.settings.fiscalYearStartMonth} onChange={(e) => setV({ ...v, settings: { ...v.settings, fiscalYearStartMonth: Number(e.target.value) } })} /></Field>
        <Field label="صلاحية رابط التسليم (أيام)" htmlFor="c-hd"><Input id="c-hd" type="number" min={1} max={90} value={v.settings.handoverLinkDays} onChange={(e) => setV({ ...v, settings: { ...v.settings, handoverLinkDays: Number(e.target.value) } })} /></Field>
      </fieldset>
    </Card>
  );
}

function NotificationsTab() {
  const { data, loading, reload } = useApi<{ data: { category: string; enabled: boolean; locked: boolean }[] }>("/notifications/preferences");
  const { busy, run } = useAction();
  if (loading || !data) return <Loading />;
  const toggle = async (category: string, enabled: boolean) => {
    if (await run(category, () => api("/notifications/preferences", { method: "PUT", body: { preferences: [{ category, enabled }] } }), enabled ? "تم التفعيل" : "تم الإيقاف")) reload();
  };
  return (
    <Card>
      <CardHeader title="تفضيلات الإشعارات" subtitle="اختر فئات الإشعارات التي تصلك داخل النظام. إشعارات النظام لا يمكن إيقافها." />
      <ul className="divide-y divide-slate-100">
        {data.data.map((p) => (
          <li key={p.category} className="flex items-center justify-between gap-3 px-5 py-3">
            <span className="text-sm">{NOTIFICATION_CATEGORY[p.category] ?? p.category}</span>
            <label className="inline-flex items-center gap-2 text-sm">
              <input type="checkbox" role="switch" checked={p.enabled} disabled={p.locked || busy === p.category} onChange={(e) => void toggle(p.category, e.target.checked)} className="size-4" />
              {p.enabled ? "مفعّل" : "متوقف"}
            </label>
          </li>
        ))}
      </ul>
    </Card>
  );
}

type SystemInfo = {
  app: { name: string; version: string; environment: string; node: string; uptimeSeconds: number };
  database: { version: string; size: string; migrationsApplied: number; latencyMs: number };
  storage: { writable: boolean; maxUploadMb: number };
  security: { sessionIdleMinutes: number; sessionAbsoluteHours: number; secureCookies: boolean; trustProxy: number; allowedOrigins: number };
  business: { timezone: string; handoverLinkDays: number; mapProvider: string };
  jobs: { enabled: boolean; lastRunAt: string | null; lastError: string | null };
  counts: Record<string, number>;
};

function SystemTab() {
  const { data, loading, error, reload } = useApi<{ data: SystemInfo }>("/settings/system");
  const { busy, run } = useAction();
  if (loading) return <Loading />;
  if (error || !data) return <Alert>{error?.message ?? "تعذر التحميل"}</Alert>;
  const s = data.data;
  return (
    <div className="space-y-6">
      <Card>
        <CardHeader title="معلومات النظام" subtitle="لا تُعرض أي أسرار أو كلمات مرور" action={<Button variant="secondary" icon="refresh" loading={busy === "jobs"} onClick={async () => { if (await run("jobs", () => api("/settings/jobs/run", { method: "POST" }), "تم تشغيل المهام الخلفية")) reload(); }}>تشغيل مهام التنبيهات الآن</Button>} />
        <div className="p-5">
          <DescList items={[
            { label: "الإصدار", value: `${s.app.name} ${s.app.version} (${s.app.environment})` },
            { label: "Node.js", value: <span className="ltr">{s.app.node}</span> },
            { label: "مدة التشغيل", value: `${Math.round(s.app.uptimeSeconds / 60)} دقيقة` },
            { label: "قاعدة البيانات", value: <span className="ltr">PostgreSQL {s.database.version} — {s.database.size}</span> },
            { label: "Migrations المطبقة", value: s.database.migrationsApplied },
            { label: "زمن استجابة القاعدة", value: `${s.database.latencyMs} ms` },
            { label: "التخزين الخاص", value: s.storage.writable ? "قابل للكتابة ✓" : "غير قابل للكتابة ✗" },
            { label: "الحد الأقصى للرفع", value: `${s.storage.maxUploadMb} MB` },
            { label: "المنطقة الزمنية", value: <span className="ltr">{s.business.timezone}</span> },
            { label: "مزود الخرائط", value: s.business.mapProvider === "osm" ? "OpenStreetMap (بدون مفتاح)" : "وكيل خادم (المفتاح مخفي)" },
            { label: "مهلة الجلسة", value: `${s.security.sessionIdleMinutes} دقيقة خمول / ${s.security.sessionAbsoluteHours} ساعة كحد أقصى` },
            { label: "ملفات تعريف آمنة (Secure)", value: s.security.secureCookies ? "نعم" : "لا (بيئة تطوير)" },
            { label: "المهام الخلفية", value: s.jobs.enabled ? `مفعّلة — آخر تشغيل: ${s.jobs.lastRunAt ? formatDateTime(s.jobs.lastRunAt) : "لم تعمل بعد"}` : "متوقفة" },
            { label: "آخر خطأ في المهام", value: s.jobs.lastError },
          ]} />
        </div>
      </Card>
      <Card>
        <CardHeader title="إحصاءات" />
        <div className="p-5"><DescList items={Object.entries(s.counts).map(([k, n]) => ({ label: { users: "المستخدمون", vehicles: "المركبات", projects: "المشاريع", files: "الملفات", activeSessions: "الجلسات النشطة", auditEntries: "سجلات التدقيق" }[k] ?? k, value: n }))} /></div>
      </Card>
    </div>
  );
}

export function SettingsPage() {
  const { can } = useAuth();
  const [params, setParams] = useSearchParams();
  const tabs = [
    { key: "company", label: "الشركة" },
    { key: "notifications", label: "الإشعارات" },
    ...(can("settings.manage", "ALL") ? [{ key: "system", label: "النظام" }] : []),
    { key: "links", label: "إدارة أخرى" },
  ];
  const tab = params.get("tab") ?? "company";
  return (
    <>
      <PageHeader title="الإعدادات" />
      <Tabs tabs={tabs} active={tab} onChange={(k) => setParams({ tab: k })} />
      <div className="mt-6">
        {tab === "company" && <CompanyTab />}
        {tab === "notifications" && <NotificationsTab />}
        {tab === "system" && <SystemTab />}
        {tab === "links" && (
          <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-3">
            {[
              { to: "/users", label: "المستخدمون", icon: "users", perm: "users.read" },
              { to: "/roles", label: "الأدوار والصلاحيات", icon: "shield", perm: "roles.read" },
              { to: "/projects", label: "المشاريع", icon: "folder", perm: "projects.read" },
              { to: "/vendors", label: "الموردون", icon: "building", perm: "vendors.manage" },
              { to: "/audit", label: "سجل التدقيق", icon: "log", perm: "audit.read" },
            ].filter((l) => can(l.perm)).map((l) => (
              <Link key={l.to} to={l.to} className="flex items-center gap-3 rounded-xl border border-slate-200 bg-white p-4 hover:border-brand-600"><Icon name={l.icon} className="text-brand-700" />{l.label}</Link>
            ))}
          </div>
        )}
      </div>
    </>
  );
}
