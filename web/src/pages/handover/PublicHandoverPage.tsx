import { useCallback, useEffect, useState } from "react";
import { useParams } from "react-router";
import { Icon } from "../../components/icons";
import { Alert, Card, Loading } from "../../components/ui";
import { LanguageSwitcher } from "../../components/LanguageSwitcher";
import { localeHeaders } from "../../lib/api";
import { formatDateTime } from "../../lib/format";
import { HandoverCapture, type Progress } from "./HandoverCapture";
import { t } from "../../i18n";

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
  const [done, setDone] = useState<"HANDOVER" | "RETURN" | null>(null);
  const load = useCallback(async () => {
    setError(null);
    const res = await fetch(`/api/public/handover/${token}`, { credentials: "omit", headers: localeHeaders() }).catch(() => null);
    if (!res) return setError(t("publicHandover.connectionFailedCheckYourInternet"));
    const j = await res.json().catch(() => null);
    if (!res.ok) return setError(j?.error?.message ?? t("publicHandover.theLinkIsInvalidOr"));
    setData(j.data);
  }, [token]);
  useEffect(() => { void load(); }, [load]);

  return (
    <div className="min-h-screen bg-slate-50 px-4 py-6">
      <div className="mx-auto max-w-2xl space-y-4">
        <header className="flex items-center gap-3">
          <span className="grid size-10 place-items-center rounded-lg bg-brand-600 text-white"><Icon name="truck" /></span>
          <div className="min-w-0 flex-1"><p className="font-bold">{t("common.easyFleet")}</p><p className="text-xs text-slate-500">{t("publicHandover.vehicleHandoverReturn")}</p></div>
          <LanguageSwitcher />
        </header>
        {error ? <Alert>{error}</Alert> : !data ? <Loading /> : done ? (
          <Card className="p-6 text-center"><Icon name="check" className="mx-auto size-12 text-emerald-600" /><p className="mt-3 text-lg font-bold">{done === "HANDOVER" ? t("publicHandover.vehiclePickupConfirmed") : t("publicHandover.vehicleReturnConfirmed")}</p><p className="mt-1 text-sm text-slate-500">{t("publicHandover.youCanCloseThisPage", { value: done === "HANDOVER" ? t("publicHandover.keepTheLinkToUse") : "" })}</p></Card>
        ) : (
          <>
            <Card className="p-4">
              <p className="text-lg font-bold"><span className="ltr">{data.vehicle?.plateNumber}</span>{data.vehicle?.plateArabic && <span className="ms-2 text-slate-500">{data.vehicle.plateArabic}</span>}</p>
              <p className="text-sm text-slate-600">{data.vehicle?.make} {data.vehicle?.model}{data.vehicle?.color ? ` — ${data.vehicle.color}` : ""}</p>
              <p className="mt-2 text-sm">{t("publicHandover.driver")} <b>{data.driverName}</b>{data.projectName && ` · ${data.projectName}`}</p>
              {data.handover.at && <p className="mt-1 text-xs text-slate-500">{t("publicHandover.receivedOdometer", { at: formatDateTime(data.handover.at), odometer: data.handover.odometer })}</p>}
              <p className="mt-1 text-xs text-slate-400">{t("publicHandover.linkValidUntil", { expiresAt: formatDateTime(data.expiresAt) })}</p>
            </Card>
            {data.progress ? (
              <Card className="p-4">
                <h1 className="mb-4 text-base font-bold">{data.progress.phase === "HANDOVER" ? t("publicHandover.step1VehiclePickup") : t("publicHandover.step2VehicleReturn")}</h1>
                <HandoverCapture base={`/public/handover/${token}`} progress={data.progress} currentOdometer={data.progress.phase === "RETURN" ? data.handover.odometer : (data.vehicle?.currentOdometer ?? null)} onDone={() => setDone(data.progress!.phase)} />
              </Card>
            ) : <Alert tone="blue">{t("publicHandover.noStepIsRequiredAt")}</Alert>}
          </>
        )}
      </div>
    </div>
  );
}
