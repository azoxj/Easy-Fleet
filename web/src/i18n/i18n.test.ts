/// <reference types="node" />
import { readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import ts from "typescript";
import { afterEach, describe, expect, it, vi } from "vitest";
import { agoLabel, speedLabel } from "../lib/fleetMap";
import { formatDate, formatMoney, formatNumber, timeAgo } from "../lib/format";
import { EXPIRY_STATUS, INVOICE_STATUS, VEHICLE_STATUS } from "../lib/labels";
import { MAINTENANCE_STATUS } from "../lib/maintenance";
import { NAV_GROUPS } from "../lib/permissions";
import { ar } from "./ar";
import { en } from "./en";
import { applyDocumentLocale, dirOf, getLocale, setLocale, t, tDynamic } from "./index";

const AR = /[؀-ۿ]/;
const ph = (s: string) => [...s.matchAll(/\{(\w+)\}/g)].map((m) => m[1]).sort();

afterEach(() => setLocale("ar"));

describe("translation dictionaries", () => {
  it("define the same keys with non-empty values", () => {
    expect(Object.keys(en).sort()).toEqual(Object.keys(ar).sort());
    for (const [k, v] of Object.entries(ar)) expect(v.trim(), k).not.toBe("");
    for (const [k, v] of Object.entries(en)) expect(v.trim(), k).not.toBe("");
  });

  it("keep the same placeholders in both languages", () => {
    for (const k of Object.keys(ar) as (keyof typeof ar)[]) expect(ph(en[k]), k).toEqual(ph(ar[k]));
  });

  it("have real English (no Arabic script, no untranslated copy)", () => {
    // the only Arabic allowed in English is the Arabic plate example
    const allowed = new Set(["vehicleForm.exampleAB1234"]);
    for (const [k, v] of Object.entries(en)) {
      if (allowed.has(k) || k.startsWith("vehicleForm.example")) continue;
      expect(AR.test(v), `${k}: ${v}`).toBe(false);
    }
    const same = Object.keys(ar).filter((k) => ar[k as keyof typeof ar] === en[k as keyof typeof en]);
    expect(same).toEqual([]);
  });

  it("cover every navigation group and status", () => {
    expect(ar["nav.home"]).toBe("الرئيسية");
    expect(en["nav.operations"]).toBe("Operations");
    for (const k of ["REQUESTED", "INSPECTION", "QUOTE_PENDING", "PENDING_APPROVAL", "APPROVED", "IN_REPAIR", "READY_FOR_HANDOVER", "ACCEPTED", "REJECTED", "CLOSED"]) {
      expect(en[`enums.maintenanceStatus.${k}` as keyof typeof en], k).toBeTruthy();
    }
    for (const k of ["DRAFT", "SUBMITTED", "UNDER_REVIEW", "APPROVED", "REJECTED", "TRANSFER_PENDING", "TRANSFERRED", "PAID", "CANCELLED"]) {
      expect(en[`enums.invoiceStatus.${k}` as keyof typeof en], k).toBeTruthy();
    }
  });
});

/** Every Arabic string literal / JSX text in web/src outside src/i18n (comments are ignored by the parser). */
function hardcodedArabic(): string[] {
  const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
  const out: string[] = [];
  (function walk(d: string) {
    for (const f of readdirSync(d)) {
      const p = path.join(d, f);
      if (statSync(p).isDirectory()) {
        if (f !== "i18n") walk(p);
        continue;
      }
      if (!/\.tsx?$/.test(f) || /\.test\./.test(f)) continue;
      const sf = ts.createSourceFile(p, readFileSync(p, "utf8"), ts.ScriptTarget.Latest, true, p.endsWith("x") ? ts.ScriptKind.TSX : ts.ScriptKind.TS);
      (function v(n: ts.Node) {
        if ((ts.isStringLiteral(n) || ts.isNoSubstitutionTemplateLiteral(n) || ts.isJsxText(n) || ts.isTemplateHead(n) || ts.isTemplateMiddle(n) || ts.isTemplateTail(n)) && AR.test(n.text)) {
          out.push(`${path.relative(root, p)}: ${n.text.trim().slice(0, 60)}`);
        }
        ts.forEachChild(n, v);
      })(sf);
    }
  })(root);
  return out;
}

describe("no hardcoded UI strings", () => {
  it("has no Arabic text outside the translation files", () => {
    expect(hardcodedArabic()).toEqual([]);
  });
});

describe("language switching", () => {
  it("switches every kind of text: t(), status labels, navigation", () => {
    expect(getLocale()).toBe("ar");
    expect(t("nav.dashboard")).toBe("لوحة التحكم");
    expect(VEHICLE_STATUS.AVAILABLE!.label).toBe("متاحة");
    setLocale("en");
    expect(getLocale()).toBe("en");
    expect(t("nav.dashboard")).toBe("Dashboard");
    expect(VEHICLE_STATUS.AVAILABLE!.label).toBe("Available");
    expect(EXPIRY_STATUS.EXPIRING_SOON!.label).toBe("Expiring soon");
    expect(INVOICE_STATUS.UNDER_REVIEW!.label).toBe("Under review");
    expect(MAINTENANCE_STATUS.READY_FOR_HANDOVER!.label).toBeTruthy();
    expect(NAV_GROUPS.map((g) => g.title)).toEqual(["Home", "Operations", "Finance", "Fleet", "Reports", "Administration"]);
    expect(NAV_GROUPS[0]!.items[0]!.label).toBe("Dashboard");
    setLocale("ar");
    expect(NAV_GROUPS.map((g) => g.title)).toEqual(["الرئيسية", "العمليات", "المالية", "الأسطول", "التقارير", "الإدارة"]);
  });

  it("interpolates variables and falls back safely", () => {
    setLocale("en");
    expect(t("fleetMap.updatedSecondsAgo", { sinceRefresh: 12 })).toBe("Updated 12 seconds ago");
    expect(tDynamic("enums.vehicleStatus.SOLD")).toBe("Sold");
    expect(tDynamic("enums.vehicleStatus.NOPE", "NOPE")).toBe("NOPE");
  });

  it("formats numbers, money, dates and relative times for the locale", () => {
    const now = new Date("2026-05-10T12:00:00Z");
    expect(formatMoney("1250.5")).toBe("1,250.5 ريال");
    expect(timeAgo(new Date(now.getTime() - 5 * 60_000), now)).toBe("منذ 5 دقيقة");
    setLocale("en");
    expect(formatNumber(12500)).toBe("12,500");
    expect(formatMoney("1250.5")).toBe("SAR 1,250.5");
    expect(formatDate("2026-03-05")).toBe("5 Mar 2026");
    expect(timeAgo(new Date(now.getTime() - 5 * 60_000), now)).toBe("5 min ago");
    expect(agoLabel(20)).toBe("20 seconds ago");
    expect(speedLabel(72)).toBe("72 km/h");
  });

  it("sets <html lang dir> for RTL/LTR", () => {
    const html = { lang: "", dir: "" };
    vi.stubGlobal("document", { documentElement: html });
    applyDocumentLocale("en");
    expect(html).toEqual({ lang: "en", dir: "ltr" });
    applyDocumentLocale("ar");
    expect(html).toEqual({ lang: "ar", dir: "rtl" });
    expect(dirOf("en")).toBe("ltr");
    vi.unstubAllGlobals();
  });
});

describe("language persistence", () => {
  it("stores the choice and restores it on the next load (refresh, logout/login)", async () => {
    const store = new Map<string, string>();
    vi.stubGlobal("localStorage", { getItem: (k: string) => store.get(k) ?? null, setItem: (k: string, v: string) => void store.set(k, v) });
    setLocale("en");
    expect(store.get("ef.locale")).toBe("en");
    vi.resetModules();
    const fresh = await import("./index");
    expect(fresh.getLocale()).toBe("en");
    expect(fresh.t("nav.fleet")).toBe("Fleet");
    store.set("ef.locale", "xx"); // invalid value → default Arabic
    vi.resetModules();
    expect((await import("./index")).getLocale()).toBe("ar");
    vi.unstubAllGlobals();
  });

  it("defaults to Arabic when nothing is stored", async () => {
    vi.stubGlobal("localStorage", { getItem: () => null, setItem: () => undefined });
    vi.resetModules();
    expect((await import("./index")).getLocale()).toBe("ar");
    vi.unstubAllGlobals();
  });
});
