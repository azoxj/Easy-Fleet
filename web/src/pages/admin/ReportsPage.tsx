import { useState } from "react";
import { DateRange, ProjectSelect, useProjects, useVehicles, VehicleSelect } from "../../components/shared";
import { Alert, Badge, Button, Card, CardHeader, EmptyState, Loading, PageHeader, Select } from "../../components/ui";
import { useApi } from "../../hooks/useApi";
import { api, buildQuery } from "../../lib/api";
import { formatDate, formatDateTime, formatMoney, formatNumber } from "../../lib/format";
import { errorMessage } from "../../lib/forms";
import * as L from "../../lib/labels";
import { MAINTENANCE_PRIORITY, MAINTENANCE_STATUS } from "../../lib/maintenance";
import { t } from "../../i18n";

type Column = { key: string; label: string; type?: "money" | "number" | "date" | "datetime" | "text" };
type ReportDef = { key: string; title: string; description: string; statuses: string[] | null; columns: Column[] };
type Result = { data: Record<string, unknown>[]; meta: { title: string; columns: Column[]; totals: Record<string, string | null> | null; truncated: boolean; count: number; generatedAt: string } };

const STATUS_MAPS: Record<string, Record<string, { label: string }>> = {
  vehicles: L.VEHICLE_STATUS, maintenance: MAINTENANCE_STATUS, drivers: L.DRIVER_STATUS, accidents: L.ACCIDENT_STATUS, violations: L.VIOLATION_STATUS, invoices: L.INVOICE_STATUS, expenses: L.EXPENSE_STATUS, handovers: L.HANDOVER_STATUS, projects: L.PROJECT_STATUS,
  "documents-expiry": L.EXPIRY_STATUS,
};

/** Label lookups evaluated at render time (the maps' getters follow the current language). */
const asLabels = (...maps: Record<string, string>[]) =>
  Object.fromEntries(maps.flatMap((m) => Object.keys(m)).map((k) => [k, { get label() { return maps.find((m) => k in m)![k]!; } }]));
/** Enum columns (other than status) shown with their localized label instead of the raw code. */
const ENUM_COLUMNS: Record<string, Record<string, { label: string }>> = {
  severity: L.ACCIDENT_SEVERITY,
  responsibility: asLabels(L.RESPONSIBILITY),
  priority: MAINTENANCE_PRIORITY,
  category: asLabels(L.COST_CATEGORY),
  kind: asLabels(L.DOCUMENT_TYPE, L.DOC_KIND, L.EMPLOYEE_DOC_TYPE),
};

function cell(v: unknown, type?: string): string {
  if (v === null || v === undefined || v === "") return "—";
  if (type === "money") return formatMoney(v as string);
  if (type === "number") return formatNumber(v as number);
  if (type === "date") return formatDate(v as string);
  if (type === "datetime") return formatDateTime(v as string);
  return String(v);
}

export function ReportsPage() {
  const defs = useApi<{ data: ReportDef[]; meta: { canExport: boolean } }>("/reports");
  const projects = useProjects();
  const vehicles = useVehicles({ includeArchived: "true" });
  const [key, setKey] = useState("");
  const [f, setF] = useState({ from: "", to: "", projectId: "", vehicleId: "", status: "" });
  const [result, setResult] = useState<Result | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  if (defs.loading) return <Loading />;
  if (defs.error || !defs.data) return <Alert>{defs.error?.message ?? t("common.couldNotLoad")}</Alert>;
  const def = defs.data.data.find((d) => d.key === key);
  const run = async () => {
    setBusy(true);
    setError(null);
    try {
      setResult(await api<Result>(`/reports/${key}`, { query: f }));
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setBusy(false);
    }
  };
  const statusMap = STATUS_MAPS[key] ?? {};
  return (
    <>
      <PageHeader title={t("common.reports")} subtitle={t("reports.eachReportOnlyShowsData")} />
      <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-4 print:hidden">
        {defs.data.data.map((d) => (
          <button key={d.key} onClick={() => { setKey(d.key); setResult(null); setF({ ...f, status: "" }); }} className={`rounded-xl border p-4 text-start transition ${key === d.key ? "border-brand-600 bg-brand-50 ring-1 ring-brand-600" : "border-slate-200 bg-white hover:border-slate-300"}`}>
            <p className="font-semibold text-slate-900">{d.title}</p>
            <p className="mt-1 text-xs leading-5 text-slate-500">{d.description}</p>
          </button>
        ))}
      </div>
      {def && (
        <Card className="mt-6">
          <CardHeader title={def.title} subtitle={result ? t("reports.recordsGenerated", { count: result.meta.count, generatedAt: formatDateTime(result.meta.generatedAt) }) : def.description} action={
            <div className="flex flex-wrap gap-2 print:hidden">
              <Button loading={busy} icon="chart" onClick={run}>{t("reports.viewReport")}</Button>
              {defs.data.meta.canExport && <a className="inline-flex items-center gap-2 rounded-lg bg-white px-3.5 py-2 text-sm font-medium text-slate-700 ring-1 ring-slate-300 hover:bg-slate-50" href={`/api/reports/${key}${buildQuery({ ...f, format: "csv" })}`}>{t("reports.exportCsv")}</a>}
              {result && <Button variant="secondary" icon="printer" onClick={() => window.print()}>{t("reports.printPdf")}</Button>}
            </div>
          } />
          <div className="grid grid-cols-1 gap-3 border-b border-slate-100 p-4 sm:grid-cols-2 lg:grid-cols-4 print:hidden">
            <DateRange from={f.from} to={f.to} onFrom={(v) => setF({ ...f, from: v })} onTo={(v) => setF({ ...f, to: v })} />
            {projects.length > 0 && <ProjectSelect value={f.projectId} onChange={(v) => setF({ ...f, projectId: v })} projects={projects} />}
            {vehicles.length > 0 && !["drivers", "projects"].includes(key) && <VehicleSelect value={f.vehicleId} onChange={(v) => setF({ ...f, vehicleId: v })} vehicles={vehicles} />}
            {def.statuses && (
              <Select value={f.status} onChange={(e) => setF({ ...f, status: e.target.value })} aria-label={t("common.status")}>
                <option value="">{t("common.allStatuses")}</option>
                {def.statuses.map((s) => <option key={s} value={s}>{statusMap[s]?.label ?? s}</option>)}
              </Select>
            )}
          </div>
          {error && <div className="p-4"><Alert>{error}</Alert></div>}
          {result && (result.data.length === 0 ? <EmptyState icon="chart" title={t("reports.noDataForTheSelected")} /> : (
            <div className="overflow-x-auto">
              {result.meta.truncated && <div className="p-3"><Badge tone="amber">{t("reports.onlyTheFirstResultsAre", { count: result.meta.count })}</Badge></div>}
              <table className="min-w-full divide-y divide-slate-200 text-sm">
                <thead className="bg-slate-50"><tr>{result.meta.columns.map((c) => <th key={c.key} className="px-3 py-2 text-start text-xs font-semibold whitespace-nowrap text-slate-500">{c.label}</th>)}</tr></thead>
                <tbody className="divide-y divide-slate-100">
                  {result.data.map((r, i) => <tr key={i}>{result.meta.columns.map((c) => <td key={c.key} className="px-3 py-2 whitespace-nowrap">{c.key === "status" && statusMap[String(r[c.key])] ? statusMap[String(r[c.key])]!.label : ENUM_COLUMNS[c.key]?.[String(r[c.key])] ? ENUM_COLUMNS[c.key]![String(r[c.key])]!.label : cell(r[c.key], c.type)}</td>)}</tr>)}
                </tbody>
                {result.meta.totals && (
                  <tfoot className="bg-slate-50 font-semibold"><tr>{result.meta.columns.map((c, i) => <td key={c.key} className="px-3 py-2 whitespace-nowrap">{i === 0 ? t("common.total") : result.meta.totals![c.key] != null ? cell(result.meta.totals![c.key], c.type) : ""}</td>)}</tr></tfoot>
                )}
              </table>
            </div>
          ))}
        </Card>
      )}
    </>
  );
}
