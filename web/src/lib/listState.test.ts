import { describe, expect, it } from "vitest";
import { activeFilters, nextSort, readListState, sortRows, writeListState } from "./listState";

const defaults = { q: "", status: "", projectId: "", mode: "ALL" };

describe("list state in the URL", () => {
  it("reads filters, page and sort; ignores junk", () => {
    const s = readListState(new URLSearchParams("status=OPEN&page=3&sort=plateNumber&dir=asc&other=1"), defaults);
    expect(s).toEqual({ f: { q: "", status: "OPEN", projectId: "", mode: "ALL" }, page: 3, sort: { key: "plateNumber", dir: "asc" } });
    expect(readListState(new URLSearchParams("page=-2&sort=bad key;&dir=up"), defaults)).toMatchObject({ page: 1, sort: null });
    expect(readListState(new URLSearchParams("sort=total"), defaults).sort).toEqual({ key: "total", dir: "desc" });
    expect(readListState(new URLSearchParams(""), defaults)).toEqual({ f: defaults, page: 1, sort: null });
  });

  it("writes only non-default values and keeps unrelated parameters (e.g. ?tab=)", () => {
    const p = writeListState(new URLSearchParams("tab=gps&status=OLD"), { f: { ...defaults, status: "", projectId: "p1", q: "abc" }, page: 1, sort: { key: "year", dir: "desc" } }, defaults);
    expect(Object.fromEntries(p)).toEqual({ tab: "gps", projectId: "p1", q: "abc", sort: "year", dir: "desc" });
    const back = writeListState(p, { f: defaults, page: 2, sort: null }, defaults);
    expect(Object.fromEntries(back)).toEqual({ tab: "gps", page: "2" });
    // a value equal to a non-empty default is omitted too
    expect(writeListState(new URLSearchParams(), { f: { ...defaults, mode: "ALL" }, page: 1, sort: null }, defaults).toString()).toBe("");
  });

  it("round-trips", () => {
    const state = { f: { ...defaults, status: "PAID", q: "INV-7" }, page: 4, sort: { key: "total", dir: "asc" as const } };
    expect(readListState(writeListState(new URLSearchParams(), state, defaults), defaults)).toEqual(state);
  });
});

describe("sorting", () => {
  it("header clicks cycle first direction → other direction → default order", () => {
    expect(nextSort(null, "plate")).toEqual({ key: "plate", dir: "asc" });
    expect(nextSort({ key: "plate", dir: "asc" }, "plate")).toEqual({ key: "plate", dir: "desc" });
    expect(nextSort({ key: "plate", dir: "desc" }, "plate")).toBeNull();
    // dates/amounts start descending
    expect(nextSort(null, "total", "desc")).toEqual({ key: "total", dir: "desc" });
    expect(nextSort({ key: "total", dir: "desc" }, "total", "desc")).toEqual({ key: "total", dir: "asc" });
    expect(nextSort({ key: "total", dir: "asc" }, "total", "desc")).toBeNull();
    // another column starts over
    expect(nextSort({ key: "plate", dir: "desc" }, "year")).toEqual({ key: "year", dir: "asc" });
  });

  it("client-side sort: locale collation, numbers, empty values last, stable input", () => {
    const rows = [{ n: "Beta", v: 10 }, { n: "alpha", v: 2 }, { n: "", v: null }, { n: "Gamma 10", v: 1 }, { n: "Gamma 9", v: 3 }] as { n: string; v: number | null }[];
    const by = (k: string) => (r: (typeof rows)[number]) => (k === "n" ? r.n : r.v);
    expect(sortRows(rows, { key: "n", dir: "asc" }, (r, k) => by(k)(r), "en").map((r) => r.n)).toEqual(["alpha", "Beta", "Gamma 9", "Gamma 10", ""]);
    expect(sortRows(rows, { key: "n", dir: "desc" }, (r, k) => by(k)(r), "en").map((r) => r.n)).toEqual(["Gamma 10", "Gamma 9", "Beta", "alpha", ""]);
    expect(sortRows(rows, { key: "v", dir: "asc" }, (r, k) => by(k)(r)).map((r) => r.v)).toEqual([1, 2, 3, 10, null]);
    expect(sortRows(rows, null, (r, k) => by(k)(r))).toBe(rows);
    expect(rows[0]!.n).toBe("Beta"); // input not mutated
    const ar = [{ n: "مكة" }, { n: "الرياض" }, { n: "جدة" }];
    expect(sortRows(ar, { key: "n", dir: "asc" }, (r) => r.n, "ar").map((r) => r.n)).toEqual(["الرياض", "جدة", "مكة"]);
  });

  it("counts active filters (search and defaults excluded)", () => {
    expect(activeFilters({ q: "x", status: "OPEN", projectId: "", mode: "ALL" }, defaults)).toBe(1);
    expect(activeFilters({ q: "", status: "", projectId: "p", mode: "ACTIVE" }, defaults)).toBe(2);
  });
});
