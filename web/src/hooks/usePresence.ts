import { useEffect, useState } from "react";

/** Reduced motion requested by the OS: animations are skipped. */
export const prefersReducedMotion = () => typeof window !== "undefined" && typeof window.matchMedia === "function" && window.matchMedia("(prefers-reduced-motion: reduce)").matches;

/**
 * Keeps an element mounted for its exit animation.
 * `mounted`: render it; `shown`: apply the "open" state (false → exit animation plays).
 */
export function usePresence(open: boolean, exitMs = 180) {
  const [mounted, setMounted] = useState(open);
  const [shown, setShown] = useState(open);
  useEffect(() => {
    if (open) {
      setMounted(true);
      // next frame, so the enter transition starts from the closed state
      const id = requestAnimationFrame(() => setShown(true));
      return () => cancelAnimationFrame(id);
    }
    setShown(false);
    const id = setTimeout(() => setMounted(false), prefersReducedMotion() ? 0 : exitMs);
    return () => clearTimeout(id);
  }, [open, exitMs]);
  return { mounted, shown };
}
