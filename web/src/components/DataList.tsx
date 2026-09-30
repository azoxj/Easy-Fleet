import { useEffect, useState, type ReactNode } from "react";
import { Link } from "react-router";
import { t } from "../i18n";
import type { ApiError } from "../lib/api";
import { nextSort, type Sort, type SortDir } from "../lib/listState";
import { Drawer } from "./Drawer";
import { Icon } from "./icons";
import { Alert, cx } from "./ui";

export type Column<T> = {
  header: string;
  cell: (row: T) => ReactNode;
  /** Shown as the card title on mobile. */
  primary?: boolean;
  /** Hidden in the mobile card. */
  hideOnMobile?: boolean;
  className?: string;
  /** Sort key understood by the list's API (or client sort); the header becomes a sort button. */
  sortKey?: string;
  /** Direction of the first click (dates and amounts usually start with "desc"). */
  sortFirst?: SortDir;
};

export type Preview<T> = {
  /** Drawer title for a row. */
  title: (row: T) => ReactNode;
  /** Full page of the record ("Open full page" button). */
  href?: (row: T) => string;
};

/**
 * Table on ≥ md screens, stacked cards on phones — no horizontal page overflow.
 * Optional: sortable headers (`sort` + `onSortChange`, with a "sort by" menu on
 * phones) and a quick-view drawer (`preview`) that opens on row click, with
 * previous/next navigation through the visible rows.
 */
export function DataList<T>({
  rows,
  columns,
  rowKey,
  onRowClick,
  sort = null,
  onSortChange,
  preview,
}: {
  rows: T[];
  columns: Column<T>[];
  rowKey: (r: T) => string;
  onRowClick?: (r: T) => void;
  sort?: Sort;
  onSortChange?: (s: Sort) => void;
  preview?: Preview<T>;
}) {
  const primary = columns.find((c) => c.primary) ?? columns[0]!;
  const [openKey, setOpenKey] = useState<string | null>(null);
  const index = openKey === null ? -1 : rows.findIndex((r) => rowKey(r) === openKey);
  const current = index >= 0 ? rows[index]! : null;
  // The list changed under an open preview (filter, page) and the row is gone.
  useEffect(() => {
    if (openKey !== null && index < 0) setOpenKey(null);
  }, [openKey, index]);

  const activate = preview ? (r: T) => setOpenKey(rowKey(r)) : onRowClick;
  // Clickable rows are also reachable and openable from the keyboard.
  const rowProps = (r: T) =>
    activate
      ? {
          onClick: () => activate(r),
          onKeyDown: (e: React.KeyboardEvent) => {
            // Only keys pressed on the row itself — links/buttons inside a cell handle their own keys.
            if (e.target !== e.currentTarget || (e.key !== "Enter" && e.key !== " ")) return;
            e.preventDefault();
            activate(r);
          },
          tabIndex: 0,
          role: preview ? ("button" as const) : ("link" as const),
          "aria-haspopup": preview ? ("dialog" as const) : undefined,
        }
      : {};
  const sortable = onSortChange ? columns.filter((c) => c.sortKey) : [];
  const move = (step: number) => {
    const next = rows[index + step];
    if (next) setOpenKey(rowKey(next));
  };
  const stagger = (i: number) => ({ animationDelay: `${Math.min(i, 12) * 22}ms` });

  return (
    <>
      <div className="hidden overflow-x-auto md:block">
        <table className="min-w-full divide-y divide-slate-200 text-sm">
          <thead className="bg-slate-50">
            <tr>
              {columns.map((c) => {
                const canSort = !!(c.sortKey && onSortChange);
                const active = canSort && sort && sort.key === c.sortKey ? sort.dir : null;
                return (
                  <th key={c.header} scope="col" aria-sort={canSort ? (active === "asc" ? "ascending" : active === "desc" ? "descending" : "none") : undefined} className="px-4 py-3 text-start text-xs font-semibold whitespace-nowrap text-slate-500">
                    {canSort ? (
                      <button
                        type="button"
                        onClick={() => onSortChange!(nextSort(sort, c.sortKey!, c.sortFirst))}
                        className={cx("group -mx-1.5 inline-flex items-center gap-1 rounded px-1.5 py-0.5 transition hover:bg-slate-200/70 hover:text-slate-800 focus-visible:outline-2 focus-visible:outline-brand-600", active && "text-brand-700")}
                        title={t("list.sortColumn", { column: c.header })}
                      >
                        {c.header}
                        <Icon name={active === "asc" ? "sortAsc" : active === "desc" ? "sortDesc" : "sortBoth"} className={cx("size-3.5 transition", active ? "opacity-100" : "opacity-30 group-hover:opacity-70")} />
                      </button>
                    ) : (
                      c.header
                    )}
                  </th>
                );
              })}
            </tr>
          </thead>
          <tbody className="divide-y divide-slate-100 bg-white">
            {rows.map((r, i) => (
              <tr
                key={rowKey(r)}
                {...rowProps(r)}
                style={stagger(i)}
                className={cx(
                  "ef-row-in",
                  activate && "cursor-pointer transition-colors hover:bg-brand-50/40 active:bg-brand-50 focus-visible:bg-brand-50/60 focus-visible:outline-none",
                  openKey === rowKey(r) && "ef-row-selected",
                )}
              >
                {columns.map((c) => (
                  <td key={c.header} className={cx("px-4 py-3 whitespace-nowrap text-slate-700", c.className)}>{c.cell(r)}</td>
                ))}
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      <div className="md:hidden">
        {sortable.length > 0 && (
          <div className="flex items-center gap-2 border-b border-slate-100 px-4 py-2 text-xs text-slate-500">
            <Icon name="sortBoth" className="size-4 shrink-0" />
            <label htmlFor="list-sort-mobile" className="shrink-0">{t("list.sortBy")}</label>
            <select
              id="list-sort-mobile"
              className="min-h-9 min-w-0 flex-1 rounded-md border-0 bg-slate-50 py-1.5 ps-2 pe-7 text-xs text-slate-700 ring-1 ring-slate-200 focus:ring-2 focus:ring-brand-600"
              value={sort ? `${sort.key}:${sort.dir}` : ""}
              onChange={(e) => {
                const [key, dir] = e.target.value.split(":");
                onSortChange!(key ? { key, dir: dir === "desc" ? "desc" : "asc" } : null);
              }}
            >
              <option value="">{t("list.defaultOrder")}</option>
              {sortable.map((c) => (
                <optgroup key={c.sortKey} label={c.header}>
                  <option value={`${c.sortKey}:asc`}>{`${c.header} — ${t("list.ascending")}`}</option>
                  <option value={`${c.sortKey}:desc`}>{`${c.header} — ${t("list.descending")}`}</option>
                </optgroup>
              ))}
            </select>
          </div>
        )}
        <ul className="divide-y divide-slate-100">
          {rows.map((r, i) => (
            <li key={rowKey(r)} {...rowProps(r)} style={stagger(i)} className={cx("ef-row-in px-4 py-3", activate && "cursor-pointer transition-colors active:bg-slate-100 focus-visible:bg-brand-50/60 focus-visible:outline-none", openKey === rowKey(r) && "bg-brand-50/70")}>
              <div className="flex items-start justify-between gap-2">
                <div className="min-w-0 font-medium text-slate-900">{primary.cell(r)}</div>
                {preview && <Icon name="chevron" className="mt-0.5 size-4 shrink-0 text-slate-300" />}
              </div>
              <dl className="mt-2 grid grid-cols-2 gap-x-3 gap-y-1.5 text-xs">
                {columns
                  .filter((c) => c !== primary && !c.hideOnMobile)
                  .map((c) => (
                    <div key={c.header} className="min-w-0">
                      <dt className="text-slate-400">{c.header}</dt>
                      <dd className="mt-0.5 break-words text-slate-700">{c.cell(r)}</dd>
                    </div>
                  ))}
              </dl>
            </li>
          ))}
        </ul>
      </div>

      {preview && (
        <Drawer
          open={current !== null}
          onClose={() => setOpenKey(null)}
          title={current ? preview.title(current) : ""}
          subtitle={current && rows.length > 1 ? t("list.position", { index: index + 1, total: rows.length }) : undefined}
          onKeyDown={(e) => {
            const tag = (e.target as HTMLElement | null)?.tagName;
            if (tag === "INPUT" || tag === "SELECT" || tag === "TEXTAREA") return;
            if (e.key === "ArrowDown" || e.key === "j") (e.preventDefault(), move(1));
            if (e.key === "ArrowUp" || e.key === "k") (e.preventDefault(), move(-1));
          }}
          footer={
            current && (
              <>
                <div className="flex gap-1" role="group" aria-label={t("list.recordNavigation")}>
                  <button type="button" onClick={() => move(-1)} disabled={index <= 0} className="grid size-10 place-items-center rounded-lg text-slate-600 ring-1 ring-slate-200 transition hover:bg-slate-50 active:scale-95 disabled:opacity-40" aria-label={t("ui.previous")} title={`${t("ui.previous")} (↑)`}>
                    <Icon name="up" className="size-4" />
                  </button>
                  <button type="button" onClick={() => move(1)} disabled={index >= rows.length - 1} className="grid size-10 place-items-center rounded-lg text-slate-600 ring-1 ring-slate-200 transition hover:bg-slate-50 active:scale-95 disabled:opacity-40" aria-label={t("ui.next")} title={`${t("ui.next")} (↓)`}>
                    <Icon name="down" className="size-4" />
                  </button>
                </div>
                {preview.href && (
                  <Link to={preview.href(current)} className="ms-auto inline-flex min-h-10 items-center gap-1.5 rounded-lg bg-brand-700 px-3.5 text-sm font-medium text-white shadow-sm transition hover:bg-brand-800 active:scale-[.98]">
                    {t("list.openFullPage")}
                    <Icon name="external" className="size-4" />
                  </Link>
                )}
              </>
            )
          }
        >
          {current && (
            <dl key={openKey} className="ef-fade-up divide-y divide-slate-100">
              {columns.map((c) => (
                <div key={c.header} className="grid grid-cols-[7.5rem_minmax(0,1fr)] items-start gap-3 py-2.5 text-sm">
                  <dt className="text-slate-500">{c.header}</dt>
                  <dd className="min-w-0 break-words text-slate-800">{c.cell(current)}</dd>
                </div>
              ))}
            </dl>
          )}
          {current && rows.length > 1 && <p className="mt-4 hidden text-xs text-slate-400 sm:block">{t("list.keyboardHint")}</p>}
        </Drawer>
      )}
    </>
  );
}

/** Placeholder rows while a list loads for the first time. */
export function ListSkeleton({ rows = 6, cols = 5 }: { rows?: number; cols?: number }) {
  const widths = ["w-24", "w-32", "w-20", "w-28", "w-16", "w-24", "w-20"];
  return (
    <div role="status" aria-label={t("common.loading")} className="animate-pulse">
      <div className="hidden md:block">
        <div className="flex gap-6 bg-slate-50 px-4 py-3.5">
          {Array.from({ length: cols }, (_, i) => <div key={i} className="h-2.5 w-16 rounded bg-slate-200" />)}
        </div>
        {Array.from({ length: rows }, (_, r) => (
          <div key={r} className="flex gap-6 border-t border-slate-100 px-4 py-4">
            {Array.from({ length: cols }, (_, i) => <div key={i} className={cx("h-3 rounded bg-slate-100", widths[(r + i) % widths.length])} />)}
          </div>
        ))}
      </div>
      <div className="divide-y divide-slate-100 md:hidden">
        {Array.from({ length: Math.min(rows, 4) }, (_, r) => (
          <div key={r} className="space-y-2.5 px-4 py-4">
            <div className="h-3.5 w-40 rounded bg-slate-200" />
            <div className="grid grid-cols-2 gap-3">
              <div className="h-2.5 w-20 rounded bg-slate-100" />
              <div className="h-2.5 w-24 rounded bg-slate-100" />
              <div className="h-2.5 w-16 rounded bg-slate-100" />
              <div className="h-2.5 w-20 rounded bg-slate-100" />
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}

/**
 * Loading / error / empty / data states of a list. The first load shows a
 * skeleton; later reloads (filter, sort, page) keep the current rows on screen,
 * dimmed under a thin progress bar, instead of flashing a spinner.
 */
export function ListBody({ loading, error, hasData, empty, cols, children }: { loading: boolean; error: ApiError | null; hasData: boolean; empty: ReactNode | null; cols?: number; children: ReactNode }) {
  if (!hasData) {
    if (error) return <div className="p-4"><Alert>{error.message}</Alert></div>;
    return <ListSkeleton cols={cols} />;
  }
  return (
    <div className="relative" aria-busy={loading}>
      {loading && <div className="ef-progress absolute inset-x-0 top-0 z-10 h-0.5 overflow-hidden bg-brand-100" role="progressbar" aria-label={t("list.updating")} />}
      {error && !loading && <div className="p-4 pb-0"><Alert>{error.message}</Alert></div>}
      <div className={cx("transition-opacity duration-200", loading && "pointer-events-none opacity-60")}>{empty ?? children}</div>
    </div>
  );
}
