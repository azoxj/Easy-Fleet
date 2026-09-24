import { useRef, useState } from "react";
import { apiUpload, fileUrl } from "../lib/api";
import { formatDate } from "../lib/format";
import { errorMessage } from "../lib/forms";
import { EXPIRY_STATUS } from "../lib/labels";
import type { Alert as AlertT, ExpiryStatus } from "../lib/types";
import { useToast } from "./feedback";
import { Icon } from "./icons";
import { Button, StatusBadge, cx } from "./ui";

/** Expiry status badge + remaining days (status always comes from the server). */
export function ExpiryBadge({ status, daysLeft }: { status: ExpiryStatus | null; daysLeft?: number | null }) {
  if (!status) return <span className="text-slate-400">—</span>;
  return (
    <span className="inline-flex items-center gap-1.5">
      <StatusBadge map={EXPIRY_STATUS} value={status} />
      {daysLeft !== null && daysLeft !== undefined && status !== "ACTIVE" && (
        <span className="text-xs text-slate-500">{daysLeft < 0 ? `منذ ${-daysLeft} يوم` : daysLeft === 0 ? "اليوم" : `بعد ${daysLeft} يوم`}</span>
      )}
    </span>
  );
}

export function ExpiryDate({ date, status, daysLeft }: { date: string | null; status: ExpiryStatus | null; daysLeft?: number | null }) {
  return (
    <span className="inline-flex flex-wrap items-center gap-2">
      <span>{formatDate(date)}</span>
      {date && <ExpiryBadge status={status} daysLeft={daysLeft} />}
    </span>
  );
}

export function AlertList({ alerts }: { alerts: AlertT[] }) {
  if (!alerts.length) return null;
  return (
    <ul className="space-y-2">
      {alerts.map((a, i) => (
        <li key={i} className={cx("flex items-center gap-2 rounded-lg px-3 py-2 text-sm ring-1", a.level === "danger" ? "bg-red-50 text-red-800 ring-red-200" : "bg-amber-50 text-amber-900 ring-amber-200")}>
          <Icon name="alert" className="size-4 shrink-0" />
          {a.message}
        </li>
      ))}
    </ul>
  );
}

const ACCEPT = "application/pdf,image/png,image/jpeg,image/webp";

/**
 * Shows the attached file (download through the authorized endpoint) and,
 * when allowed, lets the user upload/replace it.
 */
export function FileAttachment({ fileName, downloadPath, uploadPath, canUpload, onUploaded }: { fileName: string | null; downloadPath: string; uploadPath: string; canUpload: boolean; onUploaded: () => void }) {
  const input = useRef<HTMLInputElement>(null);
  const [busy, setBusy] = useState(false);
  const toast = useToast();
  const upload = async (file: File | undefined) => {
    if (!file) return;
    if (file.size > 10 * 1024 * 1024) return toast.error("حجم الملف أكبر من 10 ميجابايت");
    setBusy(true);
    try {
      await apiUpload(uploadPath, file);
      toast.success("تم رفع الملف");
      onUploaded();
    } catch (err) {
      toast.error(errorMessage(err, "تعذر رفع الملف"));
    } finally {
      setBusy(false);
      if (input.current) input.current.value = "";
    }
  };
  return (
    <div className="flex flex-wrap items-center gap-2">
      {fileName ? (
        <a href={fileUrl(downloadPath)} className="inline-flex max-w-full items-center gap-1.5 text-sm font-medium text-brand-700 hover:underline" download>
          <Icon name="file" className="size-4 shrink-0" />
          <span className="truncate">{fileName}</span>
        </a>
      ) : (
        <span className="text-sm text-slate-400">لا يوجد مرفق</span>
      )}
      {canUpload && (
        <>
          <input ref={input} type="file" accept={ACCEPT} className="hidden" onChange={(e) => void upload(e.target.files?.[0])} />
          <Button variant="ghost" loading={busy} icon="plus" onClick={() => input.current?.click()} className="px-2 py-1 text-xs">
            {fileName ? "استبدال المرفق" : "إرفاق ملف"}
          </Button>
        </>
      )}
    </div>
  );
}
