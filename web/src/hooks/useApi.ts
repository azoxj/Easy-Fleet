import { useCallback, useEffect, useRef, useState } from "react";
import { api, ApiError } from "../lib/api";

type Query = Record<string, string | number | boolean | null | undefined>;

/** Minimal data-fetching hook: loading / error / data / reload, aborting stale requests. */
export function useApi<T>(path: string | null, query?: Query) {
  const [data, setData] = useState<T | null>(null);
  const [error, setError] = useState<ApiError | null>(null);
  const [loading, setLoading] = useState<boolean>(!!path);
  const [tick, setTick] = useState(0);
  const key = JSON.stringify(query ?? {});
  const queryRef = useRef(query);
  queryRef.current = query;

  useEffect(() => {
    if (!path) {
      setLoading(false);
      return;
    }
    const ctrl = new AbortController();
    setLoading(true);
    setError(null);
    api<T>(path, { query: queryRef.current, signal: ctrl.signal })
      .then((d) => setData(d))
      .catch((e: unknown) => {
        if (ctrl.signal.aborted) return;
        setError(e instanceof ApiError ? e : new ApiError(0, "NETWORK", "تعذر الاتصال بالخادم"));
      })
      .finally(() => {
        if (!ctrl.signal.aborted) setLoading(false);
      });
    return () => ctrl.abort();
  }, [path, key, tick]);

  const reload = useCallback(() => setTick((t) => t + 1), []);
  return { data, error, loading, reload, setData };
}
