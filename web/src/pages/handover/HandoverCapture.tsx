import { useEffect, useRef, useState } from "react";
import { useToast } from "../../components/feedback";
import { Icon } from "../../components/icons";
import { Alert, Button, Field, Input, Textarea, cx } from "../../components/ui";
import { ApiError, apiUpload, getCsrfToken, localeHeaders } from "../../lib/api";
import { PHOTO_CATEGORY } from "../../lib/labels";
import { t } from "../../i18n";

export type Progress = { phase: "HANDOVER" | "RETURN"; required: string[]; uploaded: string[]; missing: string[] };

type Uploader = (path: string, file: Blob, name: string) => Promise<void>;

/** Public link: no session, no CSRF — the token in the path authorizes. */
export const publicUploader: Uploader = async (path, file, name) => {
  const res = await fetch(`/api${path}`, { method: "PUT", headers: { "Content-Type": file.type || "image/jpeg", "X-File-Name": encodeURIComponent(name), ...localeHeaders() }, body: file });
  if (!res.ok) {
    const j = (await res.json().catch(() => null)) as { error?: { code: string; message: string } } | null;
    throw new ApiError(res.status, j?.error?.code ?? "HTTP_ERROR", j?.error?.message ?? t("handoverCapture.couldNotUploadThePhoto"));
  }
};

const authUploader: Uploader = async (path, file, name) => {
  await apiUpload(path, new File([file], name, { type: file.type || "image/jpeg" }));
};

/** Downscales camera photos (max 1600px, JPEG) before upload to save mobile data. */
async function compress(file: File): Promise<Blob> {
  if (!file.type.startsWith("image/") || file.size < 400_000) return file;
  try {
    const bmp = await createImageBitmap(file);
    const scale = Math.min(1, 1600 / Math.max(bmp.width, bmp.height));
    const canvas = document.createElement("canvas");
    canvas.width = Math.round(bmp.width * scale);
    canvas.height = Math.round(bmp.height * scale);
    canvas.getContext("2d")!.drawImage(bmp, 0, 0, canvas.width, canvas.height);
    return await new Promise<Blob>((resolve) => canvas.toBlob((b) => resolve(b ?? file), "image/jpeg", 0.82));
  } catch {
    return file;
  }
}

function useGeo() {
  const [pos, setPos] = useState<GeolocationPosition | null>(null);
  const [denied, setDenied] = useState(false);
  useEffect(() => {
    if (!navigator.geolocation) return;
    const id = navigator.geolocation.watchPosition(setPos, () => setDenied(true), { enableHighAccuracy: true, maximumAge: 30_000, timeout: 20_000 });
    return () => navigator.geolocation.clearWatch(id);
  }, []);
  return { pos, denied };
}

/**
 * Mobile capture flow shared by the public link and the logged-in driver:
 * 7 mandatory photos (camera), optional damage flag/notes per photo, extra
 * photos, odometer + notes, explicit confirmation. GPS is attached
 * only when the device actually provides it.
 */
export function HandoverCapture({ base, progress, currentOdometer, onDone, authenticated, askEmployeeNumber }: { base: string; progress: Progress; currentOdometer: number | null; onDone: () => void; authenticated?: boolean; askEmployeeNumber?: boolean }) {
  const toast = useToast();
  const upload = authenticated ? authUploader : publicUploader;
  const { pos, denied } = useGeo();
  const [uploaded, setUploaded] = useState<Set<string>>(new Set(progress.uploaded));
  const [busy, setBusy] = useState<string | null>(null);
  const [damage, setDamage] = useState<Record<string, boolean>>({});
  const [notes, setNotes] = useState<Record<string, string>>({});
  const [extras, setExtras] = useState(0);
  const [odometer, setOdometer] = useState("");
  const [summary, setSummary] = useState("");
  const [confirm, setConfirm] = useState(false);
  const [employeeNumber, setEmployeeNumber] = useState("");
  const [error, setError] = useState<string | null>(null);
  const inputs = useRef<Record<string, HTMLInputElement | null>>({});
  useEffect(() => setUploaded(new Set(progress.uploaded)), [progress]);

  const send = async (category: string, blob: Blob, name: string) => {
    setBusy(category);
    setError(null);
    try {
      const q = new URLSearchParams();
      if (damage[category]) q.set("damage", "true");
      if (notes[category]?.trim()) q.set("notes", notes[category]!.trim().slice(0, 500));
      if (pos) {
        q.set("lat", pos.coords.latitude.toFixed(6));
        q.set("lng", pos.coords.longitude.toFixed(6));
        q.set("accuracy", pos.coords.accuracy.toFixed(1));
      }
      q.set("capturedAt", new Date().toISOString());
      await upload(`${base}/photos/${category}?${q}`, blob, name);
      setUploaded((s) => new Set(s).add(category));
      if (category === "OTHER") setExtras((n) => n + 1);
      toast.success(t("handoverCapture.uploaded", { value: PHOTO_CATEGORY[category] }));
    } catch (err) {
      setError(err instanceof ApiError ? err.message : t("handoverCapture.couldNotUploadThePhoto2"));
    } finally {
      setBusy(null);
    }
  };

  const onFile = async (category: string, file: File | undefined) => {
    if (!file) return;
    await send(category, await compress(file), file.name.replace(/\.[^.]+$/, "") + ".jpg");
    const el = inputs.current[category];
    if (el) el.value = "";
  };

  const required = progress.required; // no electronic signature any more
  const missing = required.filter((c) => !uploaded.has(c));
  const submit = async () => {
    if (missing.length) return setError(t("handoverCapture.completeThePhotos", { value: missing.map((m) => PHOTO_CATEGORY[m]).join(t("handoverCapture.text")) }));
    if (!/^\d+$/.test(odometer)) return setError(t("handoverCapture.enterTheOdometerReading"));
    if (!confirm) return setError(t("handoverCapture.youMustConfirmThatThe"));
    if (askEmployeeNumber && !employeeNumber.trim()) return setError(t("driverPortal.enterEmployeeNumber"));
    setBusy("submit");
    setError(null);
    try {
      const res = await fetch(`/api${base}/submit`, {
        method: "POST",
        headers: { "Content-Type": "application/json", ...localeHeaders(), ...(authenticated ? { "X-CSRF-Token": getCsrfToken() ?? "" } : {}) },
        credentials: "same-origin",
        body: JSON.stringify({ odometer: Number(odometer), confirm: true, ...(summary.trim() ? { notes: summary.trim() } : {}), ...(askEmployeeNumber ? { employeeNumber: employeeNumber.trim() } : {}) }),
      });
      const j = (await res.json().catch(() => null)) as { error?: { message: string } } | null;
      if (!res.ok) throw new ApiError(res.status, "HTTP_ERROR", j?.error?.message ?? t("handoverCapture.couldNotSubmit"));
      toast.success(progress.phase === "HANDOVER" ? t("handoverCapture.vehicleReceivedSuccessfully") : t("handoverCapture.vehicleReturnedSuccessfully"));
      onDone();
    } catch (err) {
      // Server messages are already localized; never show raw network/technical errors.
      setError(err instanceof ApiError ? err.message : t("handoverCapture.couldNotSubmit"));
    } finally {
      setBusy(null);
    }
  };

  return (
    <div className="space-y-5">
      <div className="flex items-center gap-2 text-xs">
        <Icon name="pin" className="size-4" />
        {pos ? <span className="text-emerald-700">{t("handoverCapture.locationAvailableMAccuracyAnd", { accuracy: Math.round(pos.coords.accuracy) })}</span> : denied ? <span className="text-amber-700">{t("handoverCapture.locationUnavailablePhotosWillBe")}</span> : <span className="text-slate-500">{t("handoverCapture.gettingLocation")}</span>}
      </div>
      <div className="h-2 overflow-hidden rounded-full bg-slate-100" aria-label={t("handoverCapture.progress")}><div className="h-full bg-brand-600 transition-all" style={{ width: `${((required.length - missing.length) / required.length) * 100}%` }} /></div>
      <p className="text-sm text-slate-600">{t("handoverCapture.ofComplete", { value: required.length - missing.length, length: required.length })}</p>
      <ul className="grid grid-cols-1 gap-3 sm:grid-cols-2">
        {progress.required.map((c) => (
          <li key={c} className={cx("rounded-xl border p-3", uploaded.has(c) ? "border-emerald-300 bg-emerald-50/50" : "border-slate-200")}>
            <div className="flex items-center justify-between gap-2">
              <span className="flex items-center gap-2 font-medium">{uploaded.has(c) ? <Icon name="check" className="size-5 text-emerald-600" /> : <Icon name="camera" className="size-5 text-slate-400" />}{PHOTO_CATEGORY[c]}</span>
              <input ref={(el) => { inputs.current[c] = el; }} type="file" accept="image/*" capture="environment" className="hidden" onChange={(e) => void onFile(c, e.target.files?.[0])} />
              <Button variant={uploaded.has(c) ? "secondary" : "primary"} loading={busy === c} onClick={() => inputs.current[c]?.click()} className="px-3 py-1.5 text-xs">{uploaded.has(c) ? t("handoverCapture.retake") : t("handoverCapture.takePhoto")}</Button>
            </div>
            <label className="mt-2 flex items-center gap-2 text-xs text-slate-600"><input type="checkbox" checked={!!damage[c]} onChange={(e) => setDamage({ ...damage, [c]: e.target.checked })} /> {t("handoverCapture.damageNote")}</label>
            {damage[c] && <Input className="mt-2" placeholder={t("handoverCapture.describeTheDamage")} value={notes[c] ?? ""} onChange={(e) => setNotes({ ...notes, [c]: e.target.value })} />}
          </li>
        ))}
      </ul>
      <div className="rounded-xl border border-slate-200 p-3">
        <div className="flex items-center justify-between">
          <span className="text-sm font-medium">{t("handoverCapture.additionalPhotosOptional", { value: extras ? ` — ${extras}` : "" })}</span>
          <input ref={(el) => { inputs.current.OTHER = el; }} type="file" accept="image/*" capture="environment" className="hidden" onChange={(e) => void onFile("OTHER", e.target.files?.[0])} />
          <Button variant="secondary" className="px-3 py-1.5 text-xs" loading={busy === "OTHER"} onClick={() => inputs.current.OTHER?.click()}>{t("handoverCapture.addPhoto")}</Button>
        </div>
      </div>
      <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
        <Field label={t("handoverCapture.currentOdometerReading")} required htmlFor="hc-odo" hint={currentOdometer !== null ? t("handoverCapture.lastRecordedReading", { currentOdometer }) : undefined}><Input id="hc-odo" dir="ltr" inputMode="numeric" value={odometer} onChange={(e) => setOdometer(e.target.value.replace(/\D/g, ""))} /></Field>
        <Field label={t("handoverCapture.generalNotes")} htmlFor="hc-notes"><Textarea id="hc-notes" rows={2} value={summary} onChange={(e) => setSummary(e.target.value)} /></Field>
      </div>
      {askEmployeeNumber && (
        <Field label={t("driverPortal.employeeNumber")} required htmlFor="hc-emp" hint={t("driverPortal.employeeNumberHint")}>
          <Input id="hc-emp" dir="ltr" autoComplete="off" value={employeeNumber} onChange={(e) => setEmployeeNumber(e.target.value)} />
        </Field>
      )}
      <label className="flex items-start gap-2 text-sm"><input type="checkbox" className="mt-1" checked={confirm} onChange={(e) => setConfirm(e.target.checked)} /> {t("handoverCapture.iConfirmThatThePhotos")} {progress.phase === "HANDOVER" ? t("handoverCapture.atPickup") : t("handoverCapture.atReturn")}.</label>
      {error && <Alert>{error}</Alert>}
      <Button className="w-full py-3 text-base" loading={busy === "submit"} onClick={submit}>{progress.phase === "HANDOVER" ? t("handoverCapture.confirmVehiclePickup") : t("handoverCapture.confirmVehicleReturn")}</Button>
    </div>
  );
}
