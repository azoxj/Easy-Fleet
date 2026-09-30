/**
 * List-screen state (filters, search, page, sort) kept in the URL query string,
 * so a filtered/sorted list survives refresh and "back", and can be shared.
 * Pure helpers; the React binding is hooks/useListState.ts.
 */

export type SortDir = "asc" | "desc";
export type Sort = { key: string; dir: SortDir } | null;

export type ListState<F extends Record<string, string>> = { f: F; page: number; sort: Sort };

const RESERVED = new Set(["page", "sort", "dir"]);

export function readListState<F extends Record<string, string>>(params: URLSearchParams, defaults: F): ListState<F> {
  const f = { ...defaults };
  for (const k of Object.keys(defaults) as (keyof F & string)[]) {
    if (RESERVED.has(k)) continue;
    const v = params.get(k);
    if (v !== null) (f as Record<string, string>)[k] = v;
  }
  const page = Number(params.get("page"));
  const key = params.get("sort");
  const dir = params.get("dir");
  return {
    f,
    page: Number.isInteger(page) && page > 1 ? page : 1,
    sort: key && /^[A-Za-z][A-Za-z0-9]{0,39}$/.test(key) ? { key, dir: dir === "asc" ? "asc" : "desc" } : null,
  };
}

/**
 * Writes the state into the query string. Values equal to their default, page 1
 * and "no sort" are omitted so URLs stay short; unrelated parameters are kept.
 */
export function writeListState<F extends Record<string, string>>(base: URLSearchParams, s: ListState<F>, defaults: F): URLSearchParams {
  const p = new URLSearchParams(base);
  for (const [k, v] of Object.entries(s.f)) {
    if (RESERVED.has(k)) continue;
    if (v === "" || v === defaults[k]) p.delete(k);
    else p.set(k, v);
  }
  if (s.page > 1) p.set("page", String(s.page));
  else p.delete("page");
  if (s.sort) {
    p.set("sort", s.sort.key);
    p.set("dir", s.sort.dir);
  } else {
    p.delete("sort");
    p.delete("dir");
  }
  return p;
}

/** Header click cycle: first direction → the other → back to the list's default order. */
export function nextSort(current: Sort, key: string, first: SortDir = "asc"): Sort {
  if (!current || current.key !== key) return { key, dir: first };
  if (current.dir === first) return { key, dir: first === "asc" ? "desc" : "asc" };
  return null;
}

/** Number of active filters (search excluded) — shown on the "Filters" button. */
export function activeFilters(f: Record<string, string>, defaults: Record<string, string>, ignore: string[] = ["q"]): number {
  return Object.entries(f).filter(([k, v]) => !ignore.includes(k) && v !== "" && v !== defaults[k]).length;
}

/** Client-side sort for lists that are fully loaded (no server paging). */
export function sortRows<T>(rows: T[], sort: Sort, value: (row: T, key: string) => string | number | null | undefined, locale?: string): T[] {
  if (!sort) return rows;
  const coll = new Intl.Collator(locale, { numeric: true, sensitivity: "base" });
  const sign = sort.dir === "asc" ? 1 : -1;
  return [...rows].sort((a, b) => {
    const x = value(a, sort.key);
    const y = value(b, sort.key);
    const ex = x === null || x === undefined || x === "";
    const ey = y === null || y === undefined || y === "";
    if (ex || ey) return ex === ey ? 0 : ex ? 1 : -1; // empty values last in both directions
    if (typeof x === "number" && typeof y === "number") return (x - y) * sign;
    return coll.compare(String(x), String(y)) * sign;
  });
}
