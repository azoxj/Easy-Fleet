import { useCallback, useEffect, useState } from "react";
import { useParams } from "react-router";
import { Icon } from "../../components/icons";
import { LanguageSwitcher } from "../../components/LanguageSwitcher";
import { Alert, Badge, Button, Card, Field, Input, Loading } from "../../components/ui";
import { localeHeaders } from "../../lib/api";
import { formatDateTime } from "../../lib/format";
import { VEHICLE_STATUS } from "../../lib/labels";
import { HandoverCapture, type Progress } from "./HandoverCapture";
import { t } from "../../i18n";

type VehicleState = "AVAILABLE" | "MINE" | "TAKEN" | "UNAVAILABLE" | "ASSIGNED_TO_YOU";
type PortalVehicle = { id: string; plateNumber: string; plateArabic: string | null; make: string; model: string; color: string | null; status: string; state: VehicleState; canTake: boolean };
type Custody = {
  sessionId: string;
  status: "PENDING_HANDOVER" | "RETURN_PENDING";
  vehicle: { plateNumber: string; plateArabic: string | null; make: string; model: string; color: string | null; currentOdometer: number } | null;
  handover: { at: string | null; odometer: number | null };
  progress: Progress | null;
  canCancel: boolean;
};
type View = { driver: { name: string; active: boolean }; project: { name: string | null } | null; custody: Custody | null; heldElsewhere: { plateNumber: string } | null; vehicles: PortalVehicle[] };

async function call(token: string, path: string, body?: object): Promise<{ ok: boolean; status: number; json: { data?: unknown; error?: { message: string } } | null }> {
  const res = await fetch(`/api/portal/${token}${path}`, {
    method: body ? "POST" : "GET",
    credentials: "omit",
    headers: { ...(body ? { "Content-Type": "application/json" } : {}), ...localeHeaders() },
    ...(body ? { body: JSON.stringify(body) } : {}),
  }).catch(() => null);
  if (!res) return { ok: false, status: 0, json: null };
  return { ok: res.ok, status: res.status, json: await res.json().catch(() => null) };
}

/**
 * The driver's permanent mobile page (/p/<token>): the vehicles of his current project, one pickup at a time, the photos
 * and the confirmation, then the return of the same vehicle. The link is the only credential; taking, confirming and
 * cancelling also ask for the employee number. Every rule is enforced by the server; this page only shows what it allows.
 */
export function DriverPortalPage() {
  const { token = "" } = useParams();
  const [data, setData] = useState<View | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [takeId, setTakeId] = useState<string | null>(null);
  const [empNo, setEmpNo] = useState("");
  const [busy, setBusy] = useState<string | null>(null);
  const [showReturn, setShowReturn] = useState(false);

  const load = useCallback(async () => {
    const r = await call(token, "");
    if (r.status === 0) return setError(t("publicHandover.connectionFailedCheckYourInternet"));
    if (!r.ok) return setError(r.json?.error?.message ?? t("publicHandover.theLinkIsInvalidOr"));
    setError(null);
    setData(r.json!.data as View);
  }, [token]);
  useEffect(() => { void load(); }, [load]);

  const take = async (vehicleId: string) => {
    if (!empNo.trim()) return setNotice(t("driverPortal.enterEmployeeNumber"));
    setBusy(vehicleId);
    setNotice(null);
    const r = await call(token, `/vehicles/${vehicleId}/take`, { employeeNumber: empNo.trim() });
    setBusy(null);
    if (!r.ok) {
      setNotice(r.json?.error?.message ?? t("publicHandover.connectionFailedCheckYourInternet"));
      if (r.status === 409 || r.status === 404) void load();
      return;
    }
    setTakeId(null);
    setEmpNo("");
    await load();
  };

  const cancel = async (sessionId: string) => {
    if (!empNo.trim()) return setNotice(t("driverPortal.enterEmployeeNumber"));
    setBusy("cancel");
    const r = await call(token, `/sessions/${sessionId}/cancel`, { employeeNumber: empNo.trim() });
    setBusy(null);
    if (!r.ok) return setNotice(r.json?.error?.message ?? t("publicHandover.connectionFailedCheckYourInternet"));
    setEmpNo("");
    setNotice(t("driverPortal.pickupCancelled"));
    await load();
  };

  const stateBadge = (v: PortalVehicle) => {
    switch (v.state) {
      case "AVAILABLE": return <Badge tone="green" dot>{t("driverPortal.available")}</Badge>;
      case "MINE": return <Badge tone="blue" dot>{t("driverPortal.inYourCustody")}</Badge>;
      case "TAKEN": return <Badge tone="amber" dot>{t("driverPortal.takenByAnotherDriver")}</Badge>;
      case "ASSIGNED_TO_YOU": return <Badge tone="violet" dot>{t("driverPortal.assignedToYouByAdmin")}</Badge>;
      default: return <Badge tone="gray" dot>{t("driverPortal.unavailable", { status: VEHICLE_STATUS[v.status]?.label ?? v.status })}</Badge>;
    }
  };

  const custody = data?.custody ?? null;
  return (
    <div className="min-h-screen bg-slate-50 px-4 py-6">
      <div className="mx-auto max-w-2xl space-y-4">
        <header className="flex items-center gap-3">
          <span className="grid size-10 place-items-center rounded-lg bg-brand-600 text-white"><Icon name="truck" /></span>
          <div className="min-w-0 flex-1"><p className="font-bold">{t("common.easyFleet")}</p><p className="text-xs text-slate-500">{t("driverPortal.title")}</p></div>
          <LanguageSwitcher />
        </header>

        {error ? <Alert>{error}</Alert> : !data ? <Loading /> : (
          <>
            <Card className="p-4">
              <p className="text-lg font-bold">{t("driverPortal.hello", { name: data.driver.name })}</p>
              <p className="text-sm text-slate-600">{data.project ? t("driverPortal.yourProject", { name: data.project.name ?? "" }) : t("driverPortal.noProject")}</p>
            </Card>

            {notice && <Alert tone="amber">{notice}</Alert>}
            {!data.driver.active && !custody && <Alert tone="amber">{t("driverPortal.inactive")}</Alert>}
            {data.heldElsewhere && <Alert tone="amber">{t("driverPortal.heldElsewhere", { plate: data.heldElsewhere.plateNumber })}</Alert>}

            {custody && (
              <Card className="space-y-3 p-4">
                <h1 className="text-base font-bold">{custody.status === "PENDING_HANDOVER" ? t("driverPortal.pickupInProgress") : t("driverPortal.yourVehicle")}</h1>
                {custody.vehicle && (
                  <div>
                    <p className="text-lg font-bold"><span className="ltr">{custody.vehicle.plateNumber}</span>{custody.vehicle.plateArabic && <span className="ms-2 text-slate-500">{custody.vehicle.plateArabic}</span>}</p>
                    <p className="text-sm text-slate-600">{custody.vehicle.make} {custody.vehicle.model}{custody.vehicle.color ? ` — ${custody.vehicle.color}` : ""}</p>
                    {custody.handover.at && <p className="mt-1 text-xs text-slate-500">{t("publicHandover.receivedOdometer", { at: formatDateTime(custody.handover.at), odometer: custody.handover.odometer })}</p>}
                  </div>
                )}
                {custody.status === "RETURN_PENDING" && !showReturn && <Button className="w-full py-3 text-base" icon="check" onClick={() => setShowReturn(true)}>{t("driverPortal.returnVehicle")}</Button>}
                {custody.progress && (custody.status === "PENDING_HANDOVER" || showReturn) && (
                  <div className="border-t border-slate-100 pt-3">
                    <p className="mb-3 text-sm font-semibold">{custody.progress.phase === "HANDOVER" ? t("publicHandover.step1VehiclePickup") : t("publicHandover.step2VehicleReturn")}</p>
                    <HandoverCapture
                      base={`/portal/${token}/sessions/${custody.sessionId}`}
                      progress={custody.progress}
                      currentOdometer={custody.progress.phase === "RETURN" ? custody.handover.odometer : (custody.vehicle?.currentOdometer ?? null)}
                      askEmployeeNumber
                      onDone={() => { setShowReturn(false); setNotice(custody.progress!.phase === "HANDOVER" ? t("driverPortal.doneHandover") : t("driverPortal.doneReturn")); void load(); }}
                    />
                  </div>
                )}
                {custody.canCancel && (
                  <div className="space-y-2 border-t border-slate-100 pt-3">
                    <Field label={t("driverPortal.employeeNumber")} htmlFor="pc-emp"><Input id="pc-emp" dir="ltr" autoComplete="off" value={empNo} onChange={(e) => setEmpNo(e.target.value)} /></Field>
                    <Button variant="ghost" className="w-full" loading={busy === "cancel"} onClick={() => void cancel(custody.sessionId)}>{t("driverPortal.cancelPickup")}</Button>
                  </div>
                )}
              </Card>
            )}

            <Card className="p-4">
              <h2 className="mb-3 text-base font-bold">{t("driverPortal.projectVehicles")}</h2>
              {custody && <p className="mb-3 text-sm text-amber-700">{t("driverPortal.returnFirst")}</p>}
              {data.vehicles.length === 0 ? (
                <p className="text-sm text-slate-500">{data.project ? t("driverPortal.noVehicles") : t("driverPortal.noProject")}</p>
              ) : (
                <ul className="space-y-3">
                  {data.vehicles.map((v) => (
                    <li key={v.id} className="rounded-xl border border-slate-200 p-3">
                      <div className="flex flex-wrap items-center justify-between gap-2">
                        <div className="min-w-0">
                          <p className="font-bold"><span className="ltr">{v.plateNumber}</span>{v.plateArabic && <span className="ms-2 text-slate-500">{v.plateArabic}</span>}</p>
                          <p className="text-sm text-slate-600">{v.make} {v.model}</p>
                        </div>
                        {stateBadge(v)}
                      </div>
                      {v.canTake && (takeId === v.id ? (
                        <div className="mt-3 space-y-2">
                          <Field label={t("driverPortal.employeeNumber")} required htmlFor={`pe-${v.id}`} hint={t("driverPortal.employeeNumberHint")}>
                            <Input id={`pe-${v.id}`} dir="ltr" autoComplete="off" value={empNo} onChange={(e) => setEmpNo(e.target.value)} />
                          </Field>
                          <div className="flex gap-2">
                            <Button className="flex-1" loading={busy === v.id} onClick={() => void take(v.id)}>{t("driverPortal.confirmTake")}</Button>
                            <Button variant="secondary" onClick={() => { setTakeId(null); setNotice(null); }}>{t("common.cancel")}</Button>
                          </div>
                        </div>
                      ) : (
                        <Button className="mt-3 w-full" icon="key" onClick={() => { setTakeId(v.id); setNotice(null); }}>{t("driverPortal.takeVehicle")}</Button>
                      ))}
                    </li>
                  ))}
                </ul>
              )}
            </Card>
          </>
        )}
      </div>
    </div>
  );
}
