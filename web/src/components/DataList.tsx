import type { ReactNode } from "react";
import { cx } from "./ui";

export type Column<T> = {
  header: string;
  cell: (row: T) => ReactNode;
  /** Shown as the card title on mobile. */
  primary?: boolean;
  /** Hidden in the mobile card. */
  hideOnMobile?: boolean;
  className?: string;
};

/**
 * Table on ≥ md screens, stacked cards on phones — no horizontal page overflow.
 */
export function DataList<T>({ rows, columns, rowKey, onRowClick }: { rows: T[]; columns: Column<T>[]; rowKey: (r: T) => string; onRowClick?: (r: T) => void }) {
  const primary = columns.find((c) => c.primary) ?? columns[0]!;
  return (
    <>
      <div className="hidden overflow-x-auto md:block">
        <table className="min-w-full divide-y divide-slate-200 text-sm">
          <thead className="bg-slate-50">
            <tr>
              {columns.map((c) => (
                <th key={c.header} scope="col" className="px-4 py-3 text-start text-xs font-semibold whitespace-nowrap text-slate-500">{c.header}</th>
              ))}
            </tr>
          </thead>
          <tbody className="divide-y divide-slate-100 bg-white">
            {rows.map((r) => (
              <tr key={rowKey(r)} onClick={onRowClick ? () => onRowClick(r) : undefined} className={cx(onRowClick && "cursor-pointer hover:bg-slate-50")}>
                {columns.map((c) => (
                  <td key={c.header} className={cx("px-4 py-3 whitespace-nowrap text-slate-700", c.className)}>{c.cell(r)}</td>
                ))}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <ul className="divide-y divide-slate-100 md:hidden">
        {rows.map((r) => (
          <li key={rowKey(r)} onClick={onRowClick ? () => onRowClick(r) : undefined} className={cx("px-4 py-3", onRowClick && "cursor-pointer active:bg-slate-50")}>
            <div className="font-medium text-slate-900">{primary.cell(r)}</div>
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
    </>
  );
}
