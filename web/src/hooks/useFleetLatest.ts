import { useCallback, useEffect, useRef, useState } from "react";
import { api, ApiError } from "../lib/api";
import { POLL_MS, type LatestLocation } from "../lib/fleetMap";

export type LatestMeta = { staleMinutes: number; speedUnit: string; total: number; serverTime: string };

/**
 * Polls GET /api/tracking/latest (default every 15 s). The first load shows a
 * loading state; later refreshes swap the data silently so the map, the
 * viewport and the selection stay as they are. Polling pauses while the tab is
 * hidden and refreshes as soon as it becomes visible again. `skewMs` corrects
 * "seconds ago" labels for a client clock that differs from the server's.
 */
export function useFleetLatest(enabled = true, intervalMs = POLL_MS) {
  const [rows, setRows] = useState<LatestLocation[]>([]);
  const [meta, setMeta] = useState<LatestMeta | null>(null);
  const [error, setError] = useState<ApiError | null>(null);
  const [loading, setLoading] = useState(enabled);
  const [refreshing, setRefreshing] = useState(false);
  const [fetchedAt, setFetchedAt] = useState<number | null>(null);
  const [skewMs, setSkewMs] = useState(0);
  const inFlight = useRef<AbortController | null>(null);

  const refresh = useCallback(async () => {
    if (!enabled) return;
    inFlight.current?.abort();
    const ctrl = new AbortController();
    inFlight.current = ctrl;
    setRefreshing(true);
    try {
      const r = await api<{ data: LatestLocation[]; meta: LatestMeta }>("/tracking/latest", { signal: ctrl.signal });
      const at = Date.now();
      setRows(r.data);
      setMeta(r.meta);
      setError(null);
      setFetchedAt(at);
      const server = Date.parse(r.meta.serverTime);
      if (Number.isFinite(server)) setSkewMs(server - at);
    } catch (e) {
      if (ctrl.signal.aborted) return;
      setError(e instanceof ApiError ? e : new ApiError(0, "NETWORK", "تعذر الاتصال بالخادم"));
    } finally {
      if (!ctrl.signal.aborted) {
        setRefreshing(false);
        setLoading(false);
      }
    }
  }, [enabled]);

  useEffect(() => {
    if (!enabled) return;
    void refresh();
    const t = setInterval(() => {
      if (typeof document === "undefined" || !document.hidden) void refresh();
    }, intervalMs);
    const onVisible = () => !document.hidden && void refresh();
    document.addEventListener("visibilitychange", onVisible);
    return () => {
      clearInterval(t);
      document.removeEventListener("visibilitychange", onVisible);
      inFlight.current?.abort();
    };
  }, [enabled, intervalMs, refresh]);

  return { rows, meta, error, loading, refreshing, fetchedAt, skewMs, refresh };
}

/** Re-renders every `ms` (for "آخر تحديث قبل X ثانية"). */
export function useNow(ms = 1000) {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), ms);
    return () => clearInterval(t);
  }, [ms]);
  return now;
}
