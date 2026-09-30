import { useEffect, useId, useRef, type ReactNode } from "react";
import { createPortal } from "react-dom";
import { usePresence } from "../hooks/usePresence";
import { t } from "../i18n";
import { Icon } from "./icons";
import { cx } from "./ui";

/**
 * Side panel on the reading-end side (left in Arabic, right in English); a bottom
 * sheet on phones. Escape / backdrop close it, focus stays inside while open and
 * returns to the element that opened it.
 */
export function Drawer({ open, onClose, title, subtitle, children, footer, onKeyDown }: { open: boolean; onClose: () => void; title: ReactNode; subtitle?: ReactNode; children: ReactNode; footer?: ReactNode; onKeyDown?: (e: KeyboardEvent) => void }) {
  const { mounted, shown } = usePresence(open, 220);
  const titleId = useId();
  const panel = useRef<HTMLDivElement>(null);
  const opener = useRef<HTMLElement | null>(null);
  const keyRef = useRef(onKeyDown);
  keyRef.current = onKeyDown;

  useEffect(() => {
    if (!open) return;
    opener.current = document.activeElement as HTMLElement | null;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") return onClose();
      if (e.key === "Tab" && panel.current) {
        const items = [...panel.current.querySelectorAll<HTMLElement>('a[href],button:not([disabled]),input,select,textarea,[tabindex]:not([tabindex="-1"])')];
        if (!items.length) return;
        const first = items[0]!;
        const last = items[items.length - 1]!;
        if (e.shiftKey && document.activeElement === first) (e.preventDefault(), last.focus());
        else if (!e.shiftKey && document.activeElement === last) (e.preventDefault(), first.focus());
        return;
      }
      keyRef.current?.(e);
    };
    document.addEventListener("keydown", onKey);
    const prev = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    return () => {
      document.removeEventListener("keydown", onKey);
      document.body.style.overflow = prev;
      opener.current?.focus?.({ preventScroll: true });
    };
  }, [open, onClose]);

  useEffect(() => {
    if (shown) panel.current?.querySelector<HTMLElement>("[data-autofocus]")?.focus({ preventScroll: true });
  }, [shown]);

  if (!mounted) return null;
  // Portal: fixed positioning is relative to the viewport whatever the ancestors (transforms, overflow).
  return createPortal(
    <div className="fixed inset-0 z-50" role="dialog" aria-modal="true" aria-labelledby={titleId}>
      <div className={cx("ef-fade absolute inset-0 bg-slate-900/40", shown && "ef-in")} onClick={onClose} />
      <div ref={panel} className={cx("ef-drawer absolute inset-x-0 bottom-0 flex max-h-[88vh] flex-col rounded-t-2xl bg-white shadow-2xl sm:inset-y-0 sm:end-0 sm:start-auto sm:max-h-none sm:w-[26rem] sm:rounded-none", shown && "ef-in")}>
        <div className="mx-auto mt-2 h-1.5 w-10 rounded-full bg-slate-200 sm:hidden" aria-hidden="true" />
        <div className="flex items-start justify-between gap-3 border-b border-slate-100 px-5 py-4">
          <div className="min-w-0">
            <h2 id={titleId} className="truncate text-base font-semibold text-slate-900">{title}</h2>
            {subtitle && <div className="mt-0.5 text-xs text-slate-500">{subtitle}</div>}
          </div>
          <button data-autofocus onClick={onClose} className="-m-1 rounded-md p-1.5 text-slate-400 transition hover:bg-slate-100 hover:text-slate-600 focus-visible:outline-2 focus-visible:outline-brand-600" aria-label={t("common.close")}>
            <Icon name="x" />
          </button>
        </div>
        <div className="min-h-0 flex-1 overflow-y-auto px-5 py-4">{children}</div>
        {footer && <div className="flex flex-wrap items-center gap-2 border-t border-slate-100 px-5 py-3">{footer}</div>}
      </div>
    </div>,
    document.body,
  );
}
