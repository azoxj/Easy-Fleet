import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useSearchParams } from "react-router";
import { activeFilters, nextSort, readListState, writeListState, type Sort, type SortDir } from "../lib/listState";

const SEARCH_DELAY = 300;

/**
 * Filters, search, page and sort of a list screen, stored in the URL.
 * - `f` holds the committed values (use them in the API query);
 * - `search` / `setSearch` drive the search box immediately, while `f.q` follows
 *   after a short pause so the API is not called on every keystroke;
 * - changing a filter, the search or the sort goes back to page 1;
 * - `persist: false` keeps the state in memory (lists embedded in another page).
 */
export function useListState<F extends Record<string, string>>(defaults: F, opts: { pageSize?: number; persist?: boolean } = {}) {
  const [urlParams, setUrlParams] = useSearchParams();
  // Lists embedded in another page (e.g. a vehicle tab) keep their state locally instead of in the URL.
  const persist = opts.persist ?? true;
  const [localParams, setLocalParams] = useState(() => new URLSearchParams());
  const params = persist ? urlParams : localParams;
  const setParams = useCallback(
    (fn: (prev: URLSearchParams) => URLSearchParams) => (persist ? setUrlParams(fn, { replace: true, preventScrollReset: true }) : setLocalParams(fn)),
    [persist, setUrlParams],
  );
  // defaults are a fresh object literal on every render; keep the first one.
  const defaultsRef = useRef(defaults);
  const d = defaultsRef.current;
  const state = useMemo(() => readListState(params, d), [params, d]);

  const commit = useCallback(
    (patch: { f?: Partial<F>; page?: number; sort?: Sort }) => {
      setParams(
        (prev) => {
          const cur = readListState(prev, d);
          const next = {
            f: { ...cur.f, ...patch.f } as F,
            sort: patch.sort !== undefined ? patch.sort : cur.sort,
            // any change other than paging returns to the first page
            page: patch.page ?? (patch.f || patch.sort !== undefined ? 1 : cur.page),
          };
          return writeListState(prev, next, d);
        },
      );
    },
    [setParams, d],
  );

  // ---- debounced search box
  const hasQ = "q" in d;
  const committedQ = hasQ ? (state.f as Record<string, string>).q ?? "" : "";
  const [search, setSearchState] = useState(committedQ);
  const typing = useRef(false);
  useEffect(() => {
    // follow the URL (back/forward, "clear") unless the user is typing
    if (!typing.current) setSearchState(committedQ);
  }, [committedQ]);
  useEffect(() => {
    if (!hasQ || !typing.current) return;
    const id = setTimeout(() => {
      typing.current = false;
      if (search !== committedQ) commit({ f: { q: search } as unknown as Partial<F> });
    }, SEARCH_DELAY);
    return () => clearTimeout(id);
  }, [search, committedQ, hasQ, commit]);
  const setSearch = useCallback((v: string) => {
    typing.current = true;
    setSearchState(v);
  }, []);

  const setValue = useCallback(<K extends keyof F & string>(k: K, v: string) => commit({ f: { [k]: v } as unknown as Partial<F> }), [commit]);

  return {
    f: state.f,
    page: state.page,
    sort: state.sort,
    search,
    setSearch,
    /** Searching (typed text not applied yet). */
    pending: hasQ && search !== committedQ,
    setValue,
    /** onChange handler for an input/select bound to filter `k`. */
    bind: <K extends keyof F & string>(k: K) => (e: { target: { value: string } }) => setValue(k, e.target.value),
    setPage: useCallback((page: number) => commit({ page }), [commit]),
    toggleSort: useCallback((key: string, first: SortDir = "asc") => commit({ sort: nextSort(state.sort, key, first) }), [commit, state.sort]),
    setSort: useCallback((sort: Sort) => commit({ sort }), [commit]),
    /** Clears the given filters (default: all except the search). */
    clear: useCallback(
      (keys?: (keyof F & string)[]) => {
        const ks = keys ?? (Object.keys(d).filter((k) => k !== "q") as (keyof F & string)[]);
        commit({ f: Object.fromEntries(ks.map((k) => [k, d[k]])) as Partial<F> });
      },
      [commit, d],
    ),
    active: activeFilters(state.f, d),
    /** Query for useApi: committed filters + paging + sort. */
    query: { ...state.f, page: state.page, pageSize: opts.pageSize ?? 20, sort: state.sort?.key, dir: state.sort?.dir },
  };
}

export type ListStateApi<F extends Record<string, string>> = ReturnType<typeof useListState<F>>;
