import { useRef, useState } from "react";
import { useToast } from "../../../components/feedback";
import { Icon } from "../../../components/icons";
import { Alert, Badge, Button, Card, CardHeader, EmptyState, Modal, Select } from "../../../components/ui";
import { t } from "../../../i18n";
import { docLabel } from "../../../lib/accidentWorkflow";
import { documentRows, fileKind, formatFileSize, otherDocuments, type DocumentFile, type DocumentRow, type DocumentSlot } from "../../../lib/accidentDocuments";
import { formatDate, formatDateTime } from "../../../lib/format";
import { fileProblem } from "./caseRunner";

const ACCEPT = "application/pdf,image/png,image/jpeg,image/webp";
const KIND_LABEL = { pdf: () => t("accidentDocs.kind.pdf"), image: () => t("accidentDocs.kind.image"), other: () => t("accidentDocs.kind.other") } as const;

type Props = {
  slots: DocumentSlot[];
  files: DocumentFile[];
  /** May the caller add or replace a file of this category right now? (The server decides; this only mirrors its answer.) */
  canUpload: (category: string) => boolean;
  /** The accident is closed: nobody can add or replace documents. */
  closed?: boolean;
  /** Marks the four core documents as required (workflow reports cannot be submitted without them). */
  requiredMark?: boolean;
  /** Categories offered in the "other documents" section (already limited to what the caller may upload). */
  otherCategories: { value: string; label: string }[];
  /** Sends the file; resolves true when the server accepted it (the host shows the toast and reloads the accident). */
  upload: (category: string, file: File) => Promise<boolean>;
  /** Address of an attachment's file; `inline` asks the server to show it in the browser instead of downloading it. */
  fileHref: (attachmentId: string, inline?: boolean) => string;
};

function FileMeta({ f }: { f: DocumentFile }) {
  return (
    <span className="flex flex-wrap items-center gap-x-2 gap-y-0.5 text-xs text-slate-500">
      <span className="rounded bg-slate-100 px-1.5 py-0.5 font-medium text-slate-600">{KIND_LABEL[fileKind(f.mimeType)]()}</span>
      <span className="ltr">{formatFileSize(f.sizeBytes)}</span>
      <span>{t("accidentDocs.uploadedAt", { date: formatDateTime(f.createdAt) })}</span>
      {f.uploadedByName && <span>{t("accidentDocs.uploadedBy", { name: f.uploadedByName })}</span>}
    </span>
  );
}

/**
 * The documents of an accident, one independent row per core document (Najm report, driver ID, driving licence, vehicle
 * registration) with its status, file, replacement history and its own upload / replace / view / download actions,
 * then the other documents. Used by both the legacy accident screen and the workflow case screen.
 */
export function DocumentsPanel({ slots, files, canUpload, closed, requiredMark, otherCategories, upload, fileHref }: Props) {
  const toast = useToast();
  const [busy, setBusy] = useState<string | null>(null);
  const [preview, setPreview] = useState<DocumentFile | null>(null);
  const [previewBroken, setPreviewBroken] = useState(false);
  const [otherCat, setOtherCat] = useState("");
  const inputs = useRef<Record<string, HTMLInputElement | null>>({});
  const rows = documentRows(slots, files);
  const done = rows.filter((r) => r.status === "UPLOADED").length;
  const others = otherDocuments(files);
  const chosenOther = otherCategories.some((c) => c.value === otherCat) ? otherCat : (otherCategories[0]?.value ?? "");

  const send = async (category: string, file: File | undefined, input: HTMLInputElement | null) => {
    if (!file) return;
    const problem = fileProblem(file);
    if (problem) {
      toast.error(problem);
    } else {
      setBusy(category);
      try {
        await upload(category, file);
      } finally {
        setBusy(null);
      }
    }
    if (input) input.value = "";
  };
  const pick = (category: string) => inputs.current[category]?.click();
  const open = (f: DocumentFile) => { setPreviewBroken(false); setPreview(f); };

  const viewButton = (f: DocumentFile) => {
    const kind = fileKind(f.mimeType);
    if (kind === "image") return <Button variant="secondary" icon="search" onClick={() => open(f)} data-testid={`doc-view-${f.category}`}>{t("accidentDocs.view")}</Button>;
    if (kind === "pdf") return <a className="inline-flex min-h-9 items-center gap-1.5 rounded-lg border border-slate-200 bg-white px-3 text-sm font-medium text-slate-700 hover:bg-slate-50" href={fileHref(f.id, true)} target="_blank" rel="noopener noreferrer" data-testid={`doc-view-${f.category}`}><Icon name="external" className="size-4" />{t("accidentDocs.view")}</a>;
    return null;
  };
  const downloadLink = (f: DocumentFile) => (
    <a className="inline-flex min-h-9 items-center gap-1.5 rounded-lg border border-slate-200 bg-white px-3 text-sm font-medium text-slate-700 hover:bg-slate-50" href={fileHref(f.id)} download data-testid={`doc-download-${f.category}`}><Icon name="download" className="size-4" />{t("accidentDocs.download")}</a>
  );

  const renderRow = (row: DocumentRow) => {
    const uploaded = row.status === "UPLOADED";
    const may = !closed && canUpload(row.category);
    return (
      <li key={row.category} className="px-5 py-4" data-doc={row.category} data-status={row.status}>
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div className="flex min-w-0 flex-1 items-start gap-3">
            <span className={`mt-0.5 grid size-10 shrink-0 place-items-center rounded-xl ring-1 ring-inset ${uploaded ? "bg-emerald-50 text-emerald-700 ring-emerald-200" : "bg-amber-50 text-amber-700 ring-amber-200"}`}><Icon name={uploaded ? "check" : "file"} className="size-5" /></span>
            <div className="min-w-0 space-y-1">
              <div className="flex flex-wrap items-center gap-2">
                <span className="text-sm font-semibold text-slate-900">{docLabel(row.category)}</span>
                <Badge tone={uploaded ? "green" : "amber"} dot><span data-testid={`doc-status-${row.category}`}>{t(`accidentDocs.status.${row.status}`)}</span></Badge>
                {requiredMark && !uploaded && <Badge tone="gray">{t("accidentDocs.required")}</Badge>}
              </div>
              {row.current ? (
                <>
                  <p className="truncate text-sm text-slate-700" dir="auto" data-testid={`doc-file-${row.category}`}>{row.current.fileName}</p>
                  <FileMeta f={row.current} />
                </>
              ) : (
                <p className="text-xs text-slate-500">{may || closed ? t("accidentDocs.noFile") : t("accidentDocs.noPermission")}</p>
              )}
            </div>
          </div>
          <div className="flex flex-wrap items-center gap-2">
            {row.current && viewButton(row.current)}
            {row.current && downloadLink(row.current)}
            {may && (
              <>
                <input ref={(el) => { inputs.current[row.category] = el; }} type="file" accept={ACCEPT} className="hidden" data-testid={`doc-input-${row.category}`} onChange={(e) => void send(row.category, e.target.files?.[0], e.target)} />
                <Button variant={uploaded ? "secondary" : "primary"} icon={uploaded ? "refresh" : "plus"} loading={busy === row.category} onClick={() => pick(row.category)} data-testid={`doc-upload-${row.category}`}>{uploaded ? t("accidentDocs.replace") : t("accidentDocs.upload")}</Button>
              </>
            )}
          </div>
        </div>
        {row.history.length > 0 && (
          <details className="mt-3 rounded-lg bg-slate-50 px-3 py-2 text-xs text-slate-600" data-testid={`doc-history-${row.category}`}>
            <summary className="cursor-pointer select-none font-medium">{t("accidentDocs.history", { count: row.history.length })}</summary>
            <ul className="mt-2 space-y-2">
              {row.history.map((h) => (
                <li key={h.id} className="flex flex-wrap items-center justify-between gap-2">
                  <span className="min-w-0 space-y-0.5"><span className="block truncate text-slate-700" dir="auto">{h.fileName}</span><FileMeta f={h} />{h.supersededAt && <span className="block text-slate-500">{t("accidentDocs.replacedOn", { date: formatDate(h.supersededAt) })}</span>}</span>
                  <span className="flex gap-2">{viewButton(h)}{downloadLink(h)}</span>
                </li>
              ))}
            </ul>
          </details>
        )}
      </li>
    );
  };

  return (
    <Card>
      <CardHeader title={t("accidentDocs.title")} subtitle={t("accidentDocs.subtitle")} action={<Badge tone={done === rows.length ? "green" : "amber"}><span data-testid="doc-progress">{t("accidentDocs.progress", { done, total: rows.length })}</span></Badge>} />
      <div className="h-1 bg-slate-100" aria-hidden="true"><div className="h-full bg-emerald-500 transition-all" style={{ width: `${rows.length ? (done / rows.length) * 100 : 0}%` }} /></div>
      {closed && <div className="px-5 pt-4"><Alert tone="blue">{t("accidentDocs.closed")}</Alert></div>}
      <ul className="divide-y divide-slate-100" data-testid="core-documents">{rows.map(renderRow)}</ul>
      <div className="border-t border-slate-100">
        <div className="flex flex-wrap items-center justify-between gap-3 px-5 py-4">
          <p className="text-sm font-semibold text-slate-800">{t("accidentDocs.others")}</p>
          {!closed && otherCategories.length > 0 && (
            <div className="flex items-center gap-2">
              <Select value={chosenOther} onChange={(e) => setOtherCat(e.target.value)} aria-label={t("common.attachmentType")} className="w-44">{otherCategories.map((c) => <option key={c.value} value={c.value}>{c.label}</option>)}</Select>
              <input ref={(el) => { inputs.current.__other = el; }} type="file" accept={ACCEPT} className="hidden" data-testid="doc-input-other" onChange={(e) => void send(chosenOther, e.target.files?.[0], e.target)} />
              <Button variant="secondary" icon="plus" disabled={!chosenOther} loading={busy === chosenOther && !!chosenOther} onClick={() => pick("__other")} data-testid="doc-upload-other">{t("accidentDocs.addOther")}</Button>
            </div>
          )}
        </div>
        {others.length === 0 ? <div className="px-5 pb-4"><EmptyState icon="file" title={t("accidentDocs.othersEmpty")} /></div> : (
          <ul className="divide-y divide-slate-100 border-t border-slate-100" data-testid="other-documents">
            {others.map((f) => (
              <li key={f.id} className="flex flex-wrap items-center justify-between gap-3 px-5 py-3">
                <span className="min-w-0 space-y-0.5"><span className="block truncate text-sm text-slate-800" dir="auto">{f.fileName}</span><span className="block text-xs text-slate-500">{docLabel(f.category)}</span><FileMeta f={f} /></span>
                <span className="flex gap-2">{viewButton(f)}{downloadLink(f)}</span>
              </li>
            ))}
          </ul>
        )}
      </div>
      <Modal open={!!preview} onClose={() => setPreview(null)} size="lg" title={preview ? `${t("accidentDocs.preview")} — ${docLabel(preview.category)}` : t("accidentDocs.preview")} footer={<>{preview && downloadLink(preview)}<Button variant="secondary" onClick={() => setPreview(null)}>{t("accidentDocs.close")}</Button></>}>
        {preview && (previewBroken
          ? <Alert tone="red">{t("accidentDocs.previewFailed")}</Alert>
          : <img src={fileHref(preview.id, true)} alt={preview.fileName} className="mx-auto max-h-[70vh] max-w-full rounded-lg object-contain" data-testid="doc-preview-image" onError={() => setPreviewBroken(true)} />)}
      </Modal>
    </Card>
  );
}
