import { useParams, Link } from "react-router";
import { useApi } from "../../hooks/useApi";
import { fileUrl } from "../../lib/api";
import { formatDateTime, formatNumber } from "../../lib/format";
import { PHOTO_CATEGORY } from "../../lib/labels";
import { Alert, Button, Loading } from "../../components/ui";

type Photo = { id: string; damage: boolean; notes: string | null };
type Slot = {
  category: string;
  handover: Photo | null;
  return: Photo | null;
  newDamage: boolean;
};
type Report = {
  id: string;
  plateNumber: string;
  make: string;
  model: string;
  driverName: string | null;
  projectName: string | null;
  status: string;
  handoverAt: string | null;
  returnAt: string | null;
  reviewNotes: string | null;
  comparison: {
    odometer: { handover: number | null; return: number | null; distance: number | null };
    notes: { handover: string | null; return: string | null };
    newDamageCount: number;
    slots: Slot[];
    extras: (Photo & { phase: string })[];
  };
};

export function HandoverReportPage() {
  const { id } = useParams();
  const { data, loading, error } = useApi<{ data: Report }>(`/handovers/${id}`);

  if (loading) return <Loading />;
  if (error || !data) return <Alert>{error?.message ?? "تعذر تحميل التقرير"}</Alert>;

  const h = data.data;
  const c = h.comparison;
  const value = (n: number | null) => n === null ? "—" : formatNumber(n);
  const image = (p: Photo | null, label: string) => (
    p ? <div>
      <img src={fileUrl(`/handover-photos/${p.id}/file`)} alt={label}
        className="h-44 w-full rounded-lg border object-contain" />
      {p.damage && <p className="font-semibold text-red-700">تم تسجيل ضرر</p>}
      {p.notes && <p className="text-sm">{p.notes}</p>}
    </div> : <p className="text-slate-400">لا توجد صورة</p>
  );

  return (
    <div dir="rtl" className="mx-auto max-w-5xl bg-white p-6 text-slate-900">
      <style>{`
        @page { size: A4; margin: 12mm; }
        @media print {
          body { background: white !important; }
          .app-topbar, aside, .no-print { display: none !important; }
          main { padding: 0 !important; margin: 0 !important; }
          .report-section { break-inside: avoid; }
          img { max-width: 100%; }
        }
      `}</style>

      <div className="no-print mb-6 flex flex-wrap justify-between gap-3">
        <Link to={`/handovers/${id}`} className="rounded-lg border px-4 py-2">العودة للتفاصيل</Link>
        <Button icon="printer" onClick={() => window.print()}>طباعة / حفظ PDF</Button>
      </div>

      <header className="mb-6 border-b-2 border-slate-800 pb-4 text-center">
        <h1 className="text-2xl font-bold">فليت | تقرير استلام وتسليم المركبة</h1>
        <p className="mt-2 text-sm">رقم الجلسة: <span dir="ltr">{h.id}</span></p>
      </header>

      <section className="report-section mb-6">
        <h2 className="mb-3 border-b pb-2 text-lg font-bold">بيانات المركبة والسائق</h2>
        <div className="grid grid-cols-2 gap-3 text-sm">
          <p><b>رقم اللوحة:</b> {h.plateNumber}</p>
          <p><b>المركبة:</b> {h.make} {h.model}</p>
          <p><b>السائق:</b> {h.driverName ?? "—"}</p>
          <p><b>المشروع:</b> {h.projectName ?? "—"}</p>
          <p><b>حالة الجلسة:</b> {h.status}</p>
          <p><b>تاريخ الاستلام:</b> {formatDateTime(h.handoverAt)}</p>
          <p><b>تاريخ الإرجاع:</b> {formatDateTime(h.returnAt)}</p>
        </div>
      </section>

      <section className="report-section mb-6">
        <h2 className="mb-3 border-b pb-2 text-lg font-bold">قراءات العداد والاستخدام</h2>
        <div className="grid grid-cols-3 gap-3 text-center">
          {[
            ["عداد الاستلام", value(c.odometer.handover)],
            ["عداد الإرجاع", value(c.odometer.return)],
            ["المسافة المقطوعة", `${value(c.odometer.distance)} كم`],
          ].map(([label, val]) => (
            <div key={label} className="rounded-lg border p-3">
              <p className="text-xs text-slate-500">{label}</p>
              <p className="mt-2 text-xl font-bold">{val}</p>
            </div>
          ))}
        </div>
      </section>

      <section className="report-section mb-6">
        <h2 className="mb-3 border-b pb-2 text-lg font-bold">الأضرار والملاحظات</h2>
        <p><b>الأضرار الجديدة المسجلة:</b> {c.newDamageCount}</p>
        <p><b>ملاحظات الاستلام:</b> {c.notes.handover || "لا يوجد"}</p>
        <p><b>ملاحظات الإرجاع:</b> {c.notes.return || "لا يوجد"}</p>
        <p><b>ملاحظات المراجعة:</b> {h.reviewNotes || "لا يوجد"}</p>
      </section>

      <section>
        <h2 className="mb-4 border-b pb-2 text-lg font-bold">مقارنة صور المركبة</h2>
        {c.slots.map((s) => (
          <div key={s.category} className="report-section mb-5 rounded-lg border p-3">
            <h3 className="mb-2 font-bold">
              {PHOTO_CATEGORY[s.category]}
              {s.newDamage && <span className="mr-2 text-red-700">— ضرر جديد</span>}
            </h3>
            <div className="grid grid-cols-2 gap-4">
              <div><p className="mb-2 font-medium">عند الاستلام</p>{image(s.handover, "صورة الاستلام")}</div>
              <div><p className="mb-2 font-medium">عند الإرجاع</p>{image(s.return, "صورة الإرجاع")}</div>
            </div>
          </div>
        ))}

        {c.extras.length > 0 && (
          <div className="report-section">
            <h3 className="mb-3 font-bold">الصور الإضافية</h3>
            <div className="grid grid-cols-2 gap-4">
              {c.extras.map((p) => <div key={p.id}>
                <p className="text-sm">{p.phase === "HANDOVER" ? "عند الاستلام" : "عند الإرجاع"}</p>
                {image(p, "صورة إضافية")}
              </div>)}
            </div>
          </div>
        )}
      </section>

      <footer className="mt-8 border-t pt-3 text-center text-xs text-slate-500">
        تقرير مستخرج من نظام فليت — بيانات جلسة الاستلام والتسليم
      </footer>
    </div>
  );
}
