import { useCallback, useEffect, useState } from "react";
import { useParams } from "react-router";
import { Icon } from "../../components/icons";
import { Alert, Card, Loading } from "../../components/ui";
import { formatDateTime } from "../../lib/format";
import { HandoverCapture, type Progress } from "./HandoverCapture";

type PublicView = {
  status: string;
  expiresAt: string;
  vehicle: { plateNumber: string; plateArabic: string | null; make: string; model: string; color: string | null; currentOdometer: number } | null;
  driverName: string | null;
  projectName: string | null;
  handover: { at: string | null; odometer: number | null };
  progress: Progress | null;
};

/**
 * Public mobile page reached from the secret link (/h/<token>). It never uses
 * the session; the token only exists in the URL fragment the driver received.
 */
export function PublicHandoverPage() {
  const { token } = useParams();
  const [data, setData] = useState<PublicView | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState<string | null>(null);
  const load = useCallback(async () => {
    setError(null);
    const res = await fetch(`/api/public/handover/${token}`, { credentials: "omit" }).catch(() => null);
    if (!res) return setError("تعذر الاتصال — تحقق من الإنترنت");
    const j = await res.json().catch(() => null);
    if (!res.ok) return setError(j?.error?.message ?? "الرابط غير صالح أو منتهي الصلاحية");
    setData(j.data);
  }, [token]);
  useEffect(() => { void load(); }, [load]);

  return (
    <div className="min-h-screen bg-slate-50 px-4 py-6">
      <div className="mx-auto max-w-2xl space-y-4">
        <header className="flex items-center gap-3">
          <span className="grid size-10 place-items-center rounded-lg bg-brand-600 text-white"><Icon name="truck" /></span>
          <div><p className="font-bold">إيزي فليت</p><p className="text-xs text-slate-500">تسليم واستلام المركبة</p></div>
        </header>
        {error ? <Alert>{error}</Alert> : !data ? <Loading /> : done ? (
          <Card className="p-6 text-center"><Icon name="check" className="mx-auto size-12 text-emerald-600" /><p className="mt-3 text-lg font-bold">{done}</p><p className="mt-1 text-sm text-slate-500">يمكنك إغلاق هذه الصفحة.{done.includes("استلام") && " احتفظ بالرابط لاستخدامه عند إرجاع المركبة."}</p></Card>
        ) : (
          <>
            <Card className="p-4">
              <p className="text-lg font-bold"><span className="ltr">{data.vehicle?.plateNumber}</span>{data.vehicle?.plateArabic && <span className="ms-2 text-slate-500">{data.vehicle.plateArabic}</span>}</p>
              <p className="text-sm text-slate-600">{data.vehicle?.make} {data.vehicle?.model}{data.vehicle?.color ? ` — ${data.vehicle.color}` : ""}</p>
              <p className="mt-2 text-sm">السائق: <b>{data.driverName}</b>{data.projectName && ` · ${data.projectName}`}</p>
              {data.handover.at && <p className="mt-1 text-xs text-slate-500">تم الاستلام: {formatDateTime(data.handover.at)} — العداد {data.handover.odometer}</p>}
              <p className="mt-1 text-xs text-slate-400">صلاحية الرابط حتى {formatDateTime(data.expiresAt)}</p>
            </Card>
            {data.progress ? (
              <Card className="p-4">
                <h1 className="mb-4 text-base font-bold">{data.progress.phase === "HANDOVER" ? "الخطوة 1: استلام المركبة" : "الخطوة 2: إرجاع المركبة"}</h1>
                <HandoverCapture base={`/public/handover/${token}`} progress={data.progress} currentOdometer={data.progress.phase === "RETURN" ? data.handover.odometer : (data.vehicle?.currentOdometer ?? null)} onDone={() => setDone(data.progress!.phase === "HANDOVER" ? "تم تأكيد استلام المركبة" : "تم تأكيد إرجاع المركبة")} />
              </Card>
            ) : <Alert tone="blue">لا توجد خطوة مطلوبة حاليًا.</Alert>}
          </>
        )}
      </div>
    </div>
  );
}
