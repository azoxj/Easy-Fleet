import { formatNumber } from "../lib/format";
import { cx } from "./ui";

/**
 * Dependency-free SVG charts. Values always come from the API; an all-zero
 * series renders an explicit "no data" state instead of an empty frame.
 */
const PALETTE = ["#1d4ed8", "#0891b2", "#059669", "#d97706", "#dc2626", "#7c3aed", "#64748b"];

export type Series = { key: string; label: string; color?: string };

const monthLabel = (m: string) => {
  const [y, mo] = m.split("-").map(Number);
  return new Intl.DateTimeFormat("ar-SA-u-nu-latn-ca-gregory", { month: "short" }).format(new Date(Date.UTC(y!, mo! - 1, 1)));
};

function NoData({ height }: { height: number }) {
  return (
    <div className="grid place-items-center rounded-lg bg-slate-50 text-sm text-slate-400" style={{ height }}>
      لا توجد بيانات في هذه الفترة
    </div>
  );
}

/** Stacked bar chart over months (`rows[i][series.key]` numbers). */
export function StackedBars({ rows, series, height = 220, money = false, onSelect }: { rows: Record<string, unknown>[]; series: Series[]; height?: number; money?: boolean; onSelect?: (row: Record<string, unknown>) => void }) {
  const totals = rows.map((r) => series.reduce((a, s) => a + Number(r[s.key] ?? 0), 0));
  const max = Math.max(...totals, 0);
  if (max <= 0) return <NoData height={height} />;
  const w = 100 / rows.length;
  return (
    <figure>
      <div className="flex items-end gap-2" style={{ height }} role="img" aria-label="مخطط أعمدة">
        {rows.map((r, i) => {
          const label = typeof r.month === "string" ? monthLabel(r.month) : String(r.label ?? "");
          const Tag = onSelect ? "button" : "div";
          return (
          <Tag
            key={i}
            {...(onSelect ? { type: "button" as const, onClick: () => onSelect(r), "aria-label": `${label}: ${formatNumber(Math.round(totals[i] ?? 0))}${money ? " ريال" : ""} — عرض التفاصيل` } : {})}
            className={cx("flex h-full flex-1 flex-col items-center justify-end gap-1 rounded-md", onSelect && "cursor-pointer transition hover:bg-slate-50 active:bg-slate-100 focus-visible:outline-2 focus-visible:outline-brand-600")}
            style={{ maxWidth: `${w}%` }}
          >
            <span className="text-[10px] text-slate-500 ltr">{totals[i] ? formatNumber(Math.round(totals[i]!)) : ""}</span>
            <div className="flex w-full max-w-10 flex-col-reverse overflow-hidden rounded-t-md" style={{ height: `${(totals[i]! / max) * 85}%` }} title={money ? `${totals[i]} ريال` : String(totals[i])}>
              {series.map((s, si) => {
                const v = Number(r[s.key] ?? 0);
                return v > 0 ? <div key={s.key} style={{ height: `${(v / totals[i]!) * 100}%`, background: s.color ?? PALETTE[si % PALETTE.length] }} /> : null;
              })}
            </div>
            <span className="text-[11px] text-slate-500">{label}</span>
          </Tag>
          );
        })}
      </div>
      {series.length > 1 && <Legend series={series} />}
    </figure>
  );
}

export function Legend({ series }: { series: Series[] }) {
  return (
    <figcaption className="mt-3 flex flex-wrap gap-x-4 gap-y-1 text-xs text-slate-600">
      {series.map((s, i) => (
        <span key={s.key} className="inline-flex items-center gap-1.5">
          <span className="size-2.5 rounded-sm" style={{ background: s.color ?? PALETTE[i % PALETTE.length] }} />
          {s.label}
        </span>
      ))}
    </figcaption>
  );
}

/** Simple line chart (one series) with dots. */
export function LineChart({ points, height = 160, color = "#1d4ed8", onSelect }: { points: { label: string; value: number }[]; height?: number; color?: string; onSelect?: (label: string) => void }) {
  const max = Math.max(...points.map((p) => p.value), 0);
  if (max <= 0) return <NoData height={height} />;
  const W = 300;
  const H = 100;
  const step = points.length > 1 ? W / (points.length - 1) : 0;
  const xy = points.map((p, i) => [i * step, H - (p.value / max) * (H - 10) - 5] as const);
  return (
    <figure>
      <svg viewBox={`-10 0 ${W + 20} ${H + 4}`} className="w-full" style={{ height }} role="img" aria-label="مخطط خطي" preserveAspectRatio="none">
        <polyline points={xy.map(([x, y]) => `${x},${y}`).join(" ")} fill="none" stroke={color} strokeWidth="2" vectorEffect="non-scaling-stroke" />
        {xy.map(([x, y], i) => <circle key={i} cx={x} cy={y} r="3" fill={color} vectorEffect="non-scaling-stroke"><title>{`${points[i]!.label}: ${points[i]!.value}`}</title></circle>)}
      </svg>
      <div className="mt-1 flex justify-between text-[11px] text-slate-500">
        {points.map((p) => {
          const text = /^\d{4}-\d{2}$/.test(p.label) ? monthLabel(p.label) : p.label;
          return onSelect ? (
            <button key={p.label} type="button" onClick={() => onSelect(p.label)} className="min-h-8 rounded px-1 transition hover:bg-slate-100 hover:text-slate-800 active:bg-slate-200" aria-label={`${text}: ${formatNumber(p.value)} — عرض التفاصيل`}>{text}</button>
          ) : <span key={p.label}>{text}</span>;
        })}
      </div>
    </figure>
  );
}

/** Horizontal bars for category breakdowns. */
export function HBars({ items, money = false }: { items: { label: string; value: number }[]; money?: boolean }) {
  const max = Math.max(...items.map((i) => i.value), 0);
  if (max <= 0) return <NoData height={120} />;
  return (
    <ul className="space-y-2.5">
      {items.map((i, idx) => (
        <li key={i.label}>
          <div className="mb-1 flex justify-between text-xs"><span className="text-slate-600">{i.label}</span><span className="font-medium text-slate-800">{money ? `${formatNumber(i.value)} ريال` : formatNumber(i.value)}</span></div>
          <div className="h-2 overflow-hidden rounded-full bg-slate-100">
            <div className={cx("h-full rounded-full")} style={{ width: `${(i.value / max) * 100}%`, background: PALETTE[idx % PALETTE.length] }} />
          </div>
        </li>
      ))}
    </ul>
  );
}

/** Donut for status distributions. */
export function Donut({ items, size = 140 }: { items: { label: string; value: number; color?: string }[]; size?: number }) {
  const total = items.reduce((a, i) => a + i.value, 0);
  if (total <= 0) return <NoData height={size} />;
  const r = 40;
  const c = 2 * Math.PI * r;
  let offset = 0;
  return (
    <figure className="flex flex-wrap items-center gap-4">
      <svg viewBox="0 0 100 100" style={{ width: size, height: size }} role="img" aria-label="مخطط دائري">
        <circle cx="50" cy="50" r={r} fill="none" stroke="#f1f5f9" strokeWidth="16" />
        {items.map((i, idx) => {
          const len = (i.value / total) * c;
          const el = (
            <circle key={i.label} cx="50" cy="50" r={r} fill="none" stroke={i.color ?? PALETTE[idx % PALETTE.length]} strokeWidth="16" strokeDasharray={`${len} ${c - len}`} strokeDashoffset={-offset} transform="rotate(-90 50 50)">
              <title>{`${i.label}: ${i.value}`}</title>
            </circle>
          );
          offset += len;
          return el;
        })}
        <text x="50" y="55" textAnchor="middle" className="fill-slate-800 text-[14px] font-bold">{total}</text>
      </svg>
      <ul className="space-y-1 text-xs">
        {items.filter((i) => i.value > 0).map((i, idx) => (
          <li key={i.label} className="flex items-center gap-2"><span className="size-2.5 rounded-sm" style={{ background: i.color ?? PALETTE[items.indexOf(i) % PALETTE.length] ?? PALETTE[idx] }} />{i.label}: <b>{i.value}</b></li>
        ))}
      </ul>
    </figure>
  );
}
