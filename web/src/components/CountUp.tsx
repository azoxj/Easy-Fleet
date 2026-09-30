import { useEffect, useRef, useState } from "react";
import { prefersReducedMotion } from "../hooks/usePresence";
import { formatNumber } from "../lib/format";

/**
 * A number that counts up to its value when it first appears (and eases to a
 * new value when it changes). Rendered with the locale's number format; the
 * final text is exactly the value.
 */
export function CountUp({ value, duration = 700 }: { value: number; duration?: number }) {
  const [shown, setShown] = useState(() => (prefersReducedMotion() ? value : 0));
  const from = useRef(shown);
  useEffect(() => {
    if (prefersReducedMotion() || !Number.isFinite(value)) return setShown(value);
    const start = performance.now();
    const a = from.current;
    let raf = 0;
    const tick = (now: number) => {
      const p = Math.min(1, (now - start) / duration);
      const eased = 1 - (1 - p) ** 3;
      const v = p >= 1 ? value : a + (value - a) * eased;
      setShown(Number.isInteger(value) ? Math.round(v) : v);
      if (p < 1) raf = requestAnimationFrame(tick);
      else from.current = value;
    };
    raf = requestAnimationFrame(tick);
    return () => {
      cancelAnimationFrame(raf);
      from.current = value;
    };
  }, [value, duration]);
  return <span className="tabular-nums">{formatNumber(shown)}</span>;
}
