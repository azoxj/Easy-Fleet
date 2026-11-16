import { useRef, useState } from "react";
import { ApiError, apiUpload, fileUrl } from "../../lib/api";
import { Alert, Button, Modal } from "../../components/ui";
import { Icon } from "../../components/icons";
import { t } from "../../i18n";

type ReportRow = { row: number; plateNumber: string; make: string; model: string; year: string; projectName: string; projectState: "linked" | "none"; linkedProject: string; projectReason: string; valid: boolean; errors: string[]; notices: string[] };
type Report = { total: number; valid: number; invalid: number; withoutProject: number; rows: ReportRow[] };
type Imported = { count: number; vehicles: { id: string; plateNumber: string; make: string; model: string; year: number | null; projectName: string }[] };

const isReport = (d: unknown): d is Report => !!d && typeof d === "object" && Array.isArray((d as Report).rows) && typeof (d as Report).invalid === "number";

/**
 * Bulk vehicle import: template → upload → preview (nothing saved) → confirm. The same file is sent for the preview
 * and for the confirmation; the server validates it again and creates all vehicles in one transaction. The browser
 * never sends project ids: the server resolves the project by name and authorizes it.
 */
export function VehicleImportModal({ open, onClose, onDone }: { open: boolean; onClose: () => void; onDone: () => void }) {
  const input = useRef<HTMLInputElement>(null);
  const [file, setFile] = useState<File | null>(null);
  const [report, setReport] = useState<Report | null>(null);
  const [result, setResult] = useState<Imported | null>(null);
  const [busy, setBusy] = useState<"check" | "import" | null>(null);
  const [error, setError] = useState<string | null>(null);

  const reset = () => {
    setFile(null);
    setReport(null);
    setResult(null);
    setError(null);
    setBusy(null);
    if (input.current) input.current.value = "";
  };
  const close = () => {
    const done = !!result;
    reset();
    onClose();
    if (done) onDone();
  };

  const choose = async (f: File | undefined) => {
    if (!f) return;
    reset();
    if (!/\.xlsx$/i.test(f.name)) return setError(t("vehicleImport.onlyXlsx"));
    setFile(f);
    setBusy("check");
    try {
      const r = await apiUpload<{ data: Report }>("/vehicles/import/preview", f, fetch, "POST");
      setReport(r.data);
    } catch (e) {
      setError(e instanceof ApiError ? e.message : t("vehicleImport.failed"));
    } finally {
      setBusy(null);
    }
  };

  const confirm = async () => {
    if (!file) return;
    setBusy("import");
    setError(null);
    try {
      const r = await apiUpload<{ data: Imported }>("/vehicles/import/commit", file, fetch, "POST");
      setResult(r.data);
    } catch (e) {
      if (e instanceof ApiError && isReport(e.details)) setReport(e.details);
      setError(e instanceof ApiError ? e.message : t("vehicleImport.failed"));
    } finally {
      setBusy(null);
    }
  };

  const canConfirm = !!report && report.total > 0 && report.invalid === 0 && !busy;
  const bad = report?.rows.filter((r) => !r.valid) ?? [];
  const notices = report?.rows.flatMap((r) => r.notices.map((n) => `#${r.row} ${n}`)) ?? [];

  const footer = result ? (
    <Button onClick={close}>{t("common.close")}</Button>
  ) : (
    <>
      <Button variant="secondary" onClick={close}>{t("common.cancel")}</Button>
      <Button icon="check" disabled={!canConfirm} loading={busy === "import"} onClick={confirm}>
        {t("vehicleImport.confirm", { count: report?.valid ?? 0 })}
      </Button>
    </>
  );

  return (
    <Modal open={open} onClose={close} title={t("vehicleImport.title")} size="lg" footer={footer}>
      <div className="space-y-4">
        {error && <Alert>{error}</Alert>}

        {result ? (
          <>
            <Alert tone="green">{t("vehicleImport.success", { count: result.count })}</Alert>
            <h3 className="text-sm font-semibold text-slate-700">{t("vehicleImport.importedVehicles")}</h3>
            <div className="overflow-x-auto rounded-lg border border-slate-200">
              <table className="min-w-full text-sm">
                <thead className="bg-slate-50 text-start text-xs text-slate-500">
                  <tr>
                    {[t("vehicleImport.plate"), t("vehicleImport.make"), t("common.model"), t("common.year"), t("common.project")].map((h) => (
                      <th key={h} className="px-3 py-2 text-start font-medium">{h}</th>
                    ))}
                  </tr>
                </thead>
                <tbody className="divide-y divide-slate-100">
                  {result.vehicles.map((v) => (
                    <tr key={v.id}>
                      <td className="px-3 py-2 font-medium" dir="ltr">{v.plateNumber}</td>
                      <td className="px-3 py-2">{v.make}</td>
                      <td className="px-3 py-2">{v.model}</td>
                      <td className="px-3 py-2" dir="ltr">{v.year ?? "—"}</td>
                      <td className="px-3 py-2">{v.projectName || t("vehicleImport.noProjectShort")}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </>
        ) : (
          <>
            <p className="text-sm text-slate-600">{t("vehicleImport.intro")}</p>
            <div className="flex flex-wrap items-center gap-3">
              <a href={fileUrl("/vehicles/import/template")} download className="inline-flex items-center gap-2 rounded-lg border border-slate-300 px-3.5 py-2 text-sm font-medium text-slate-700 hover:bg-slate-50">
                <Icon name="file" className="size-4" /> {t("vehicleImport.downloadTemplate")}
              </a>
              <input ref={input} type="file" accept=".xlsx,application/vnd.openxmlformats-officedocument.spreadsheetml.sheet" className="sr-only" id="vehicle-import-file" onChange={(e) => void choose(e.target.files?.[0])} />
              <label htmlFor="vehicle-import-file" className="inline-flex cursor-pointer items-center gap-2 rounded-lg bg-brand-600 px-3.5 py-2 text-sm font-medium text-white hover:bg-brand-700">
                <Icon name="plus" className="size-4" /> {report ? t("vehicleImport.uploadAnother") : t("vehicleImport.chooseFile")}
              </label>
              {file && <span className="text-xs text-slate-500" dir="ltr">{t("vehicleImport.fileName", { name: file.name })}</span>}
            </div>
            {busy === "check" && <p className="text-sm text-slate-500" role="status">{t("vehicleImport.checking")}</p>}
            {busy === "import" && <p className="text-sm text-slate-500" role="status">{t("vehicleImport.importing")}</p>}

            {report && (
              <>
                <dl className="grid grid-cols-2 gap-3 text-center sm:grid-cols-4">
                  <div className="rounded-lg bg-slate-50 p-3"><dt className="text-xs text-slate-500">{t("vehicleImport.totalRows")}</dt><dd className="text-xl font-bold">{report.total}</dd></div>
                  <div className="rounded-lg bg-green-50 p-3"><dt className="text-xs text-green-700">{t("vehicleImport.validRows")}</dt><dd className="text-xl font-bold text-green-700">{report.valid}</dd></div>
                  <div className={`rounded-lg p-3 ${report.withoutProject ? "bg-amber-50" : "bg-slate-50"}`}><dt className={`text-xs ${report.withoutProject ? "text-amber-700" : "text-slate-500"}`}>{t("vehicleImport.withoutProject")}</dt><dd className={`text-xl font-bold ${report.withoutProject ? "text-amber-700" : ""}`}>{report.withoutProject}</dd></div>
                  <div className={`rounded-lg p-3 ${report.invalid ? "bg-red-50" : "bg-slate-50"}`}><dt className={`text-xs ${report.invalid ? "text-red-700" : "text-slate-500"}`}>{t("vehicleImport.invalidRows")}</dt><dd className={`text-xl font-bold ${report.invalid ? "text-red-700" : ""}`}>{report.invalid}</dd></div>
                </dl>

                {report.invalid > 0 ? <Alert tone="amber">{t("vehicleImport.fixErrors")}</Alert> : <Alert tone="blue">{t("vehicleImport.nothingAddedYet")}</Alert>}
                {report.withoutProject > 0 && <Alert tone="amber">{t("vehicleImport.withoutProjectHint", { count: report.withoutProject })}</Alert>}

                {notices.length > 0 && (
                  <details className="rounded-lg border border-slate-200 p-3 text-sm">
                    <summary className="cursor-pointer font-medium text-slate-700">{t("vehicleImport.notices")} ({notices.length})</summary>
                    <ul className="mt-2 list-disc space-y-1 ps-5 text-slate-600">{notices.map((n) => <li key={n}>{n}</li>)}</ul>
                  </details>
                )}

                {bad.length > 0 && (
                  <div className="max-h-64 overflow-auto rounded-lg border border-red-200">
                    <table className="min-w-full text-sm">
                      <thead className="sticky top-0 bg-red-50 text-xs text-red-800">
                        <tr>
                          <th className="px-3 py-2 text-start font-medium">{t("vehicleImport.rowNumber")}</th>
                          <th className="px-3 py-2 text-start font-medium">{t("vehicleImport.plate")}</th>
                          <th className="px-3 py-2 text-start font-medium">{t("vehicleImport.reason")}</th>
                        </tr>
                      </thead>
                      <tbody className="divide-y divide-slate-100">
                        {bad.map((r) => (
                          <tr key={r.row}>
                            <td className="px-3 py-2" dir="ltr">{r.row}</td>
                            <td className="px-3 py-2 font-medium" dir="ltr">{r.plateNumber || "—"}</td>
                            <td className="px-3 py-2 text-red-700"><ul className="space-y-0.5">{r.errors.map((e) => <li key={e}>{e}</li>)}</ul></td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                )}

                <div className="max-h-64 overflow-auto rounded-lg border border-slate-200">
                  <table className="min-w-full text-sm">
                    <thead className="sticky top-0 bg-slate-50 text-xs text-slate-500">
                      <tr>
                        {[t("vehicleImport.rowNumber"), t("vehicleImport.plate"), t("vehicleImport.make"), t("common.model"), t("common.year"), t("common.project"), t("common.status")].map((h) => (
                          <th key={h} className="px-3 py-2 text-start font-medium">{h}</th>
                        ))}
                      </tr>
                    </thead>
                    <tbody className="divide-y divide-slate-100">
                      {report.rows.map((r) => (
                        <tr key={r.row} className={r.valid ? "" : "bg-red-50/40"}>
                          <td className="px-3 py-2" dir="ltr">{r.row}</td>
                          <td className="px-3 py-2 font-medium" dir="ltr">{r.plateNumber || "—"}</td>
                          <td className="px-3 py-2">{r.make || "—"}</td>
                          <td className="px-3 py-2">{r.model || "—"}</td>
                          <td className="px-3 py-2" dir="ltr">{r.year || "—"}</td>
                          <td className="px-3 py-2">
                            {r.projectState === "linked" ? (
                              <span className="text-green-700">{t("vehicleImport.linkedTo", { name: r.linkedProject })}</span>
                            ) : (
                              <span className="text-amber-700">
                                {t("vehicleImport.noProject")}
                                {r.projectName && <span className="block text-xs text-slate-500">{r.projectName} — {r.projectReason}</span>}
                              </span>
                            )}
                          </td>
                          <td className="px-3 py-2"><span className={r.valid ? "text-green-700" : "text-red-700"}>{r.valid ? t("vehicleImport.valid") : t("vehicleImport.invalid")}</span></td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              </>
            )}
          </>
        )}
      </div>
    </Modal>
  );
}
