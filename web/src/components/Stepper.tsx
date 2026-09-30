import { Icon } from "./icons";
import { cx } from "./ui";

/**
 * Workflow progress (maintenance request, invoice): finished steps are ticked,
 * the current one is highlighted, the connecting line fills as the record moves
 * on. Scrolls sideways on narrow screens instead of wrapping.
 */
export function Stepper({ steps, current, complete, label }: { steps: { key: string; label: string }[]; current: number; complete?: boolean; label: string }) {
  return (
    <ol className="-mx-1 flex items-center overflow-x-auto px-1 pt-1 pb-2" aria-label={label}>
      {steps.map((s, i) => {
        const done = complete || i < current;
        const here = !complete && i === current;
        return (
          <li key={s.key} className="flex shrink-0 items-center" aria-current={here ? "step" : undefined}>
            <span
              className={cx(
                "grid size-7 place-items-center rounded-full text-xs font-semibold transition-colors duration-300",
                done && "bg-emerald-500 text-white",
                here && "ef-step-current bg-brand-700 text-white",
                !done && !here && "bg-white text-slate-400 ring-1 ring-slate-300",
              )}
            >
              {done ? <Icon name="check" className="size-4" /> : i + 1}
            </span>
            <span className={cx("ms-2 text-xs font-medium whitespace-nowrap", here ? "text-brand-800" : done ? "text-emerald-800" : "text-slate-500")}>{s.label}</span>
            {i < steps.length - 1 && (
              <span className="relative mx-2.5 h-0.5 w-6 overflow-hidden rounded-full bg-slate-200 sm:w-10" aria-hidden="true">
                <span className={cx("absolute inset-y-0 start-0 bg-emerald-400 transition-[width] duration-500 ease-out", done ? "w-full" : "w-0")} />
              </span>
            )}
          </li>
        );
      })}
    </ol>
  );
}
