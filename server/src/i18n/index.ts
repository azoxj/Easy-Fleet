import { AsyncLocalStorage } from "node:async_hooks";
import type { NextFunction, Request, Response } from "express";
import { EN } from "./catalog.js";

/**
 * Server-side localization of *system* messages (errors, notifications,
 * reports, timeline, dashboard/compliance alerts, role names).
 *
 * - Arabic is the source language and the default; the catalog (./catalog.ts)
 *   maps each Arabic message — or template with {0},{1}… — to English.
 * - The request locale comes from `X-Locale` (fetch) or `?lang=` (plain
 *   download links) and is kept in AsyncLocalStorage, so `tr()` works
 *   anywhere during the request without passing `req` around.
 * - Text stored in the database by the system (notification titles, system
 *   assignment titles, role names) stays Arabic and is translated on read with
 *   `translateText()`. User-entered content is never translated.
 */
export type Locale = "ar" | "en";

const als = new AsyncLocalStorage<{ locale: Locale }>();

const parseLocale = (v: unknown): Locale | null => (typeof v === "string" && /^en\b/i.test(v) ? "en" : typeof v === "string" && /^ar\b/i.test(v) ? "ar" : null);

export function localeFromRequest(req: Pick<Request, "query" | "get">): Locale {
  return parseLocale(req.query?.lang) ?? parseLocale(req.get?.("x-locale")) ?? "ar";
}

export function localeMiddleware(req: Request, _res: Response, next: NextFunction) {
  als.run({ locale: localeFromRequest(req) }, () => next());
}

export const currentLocale = (): Locale => als.getStore()?.locale ?? "ar";

/** Runs `fn` with a given locale (tests, background jobs). */
export const withLocale = <T>(locale: Locale, fn: () => T): T => als.run({ locale }, fn);

const fill = (s: string, args: unknown[]) => s.replace(/\{(\d+)\}/g, (m, i: string) => (Number(i) < args.length ? String(args[Number(i)] ?? "") : m));

/** Localizes a server message (Arabic source text, optional {0},{1}… args) for the current request. */
export function tr(ar: string, ...args: unknown[]): string {
  return fill(currentLocale() === "en" ? (EN[ar] ?? ar) : ar, args);
}

// ---------------------------------------------------------------- stored text → current locale

type Template = { key: string; parts: string[]; literalLength: number };
const TEMPLATES: Template[] = Object.keys(EN)
  .filter((k) => /\{\d+\}/.test(k))
  .map((key) => {
    const parts = key.split(/\{\d+\}/); // literal segments; placeholders sit between them, in order
    return { key, parts, literalLength: parts.join("").length };
  })
  // placeholders must be numbered in order of appearance for positional capture
  .filter((t) => [...t.key.matchAll(/\{(\d+)\}/g)].every((m, i) => Number(m[1]) === i))
  .sort((a, b) => b.literalLength - a.literalLength);

/** Every way `text` can be split to fit the literal segments of `parts` (bounded). */
function splits(parts: string[], text: string, limit = 64): string[][] {
  const out: string[][] = [];
  const first = parts[0]!, last = parts[parts.length - 1]!;
  if (!text.startsWith(first) || !text.endsWith(last) || text.length < first.length + last.length) return out;
  const inner = parts.slice(1, -1);
  const end = text.length - last.length;
  (function walk(i: number, pos: number, caps: string[]) {
    if (out.length >= limit) return;
    if (i === inner.length) {
      out.push([...caps, text.slice(pos, end)]);
      return;
    }
    const lit = inner[i]!;
    if (lit === "") {
      // adjacent placeholders: try every split point, longest first (the earlier one is the base
      // value, the later one an optional fragment) so equal-score ties resolve greedily
      for (let p = end; p >= pos; p--) walk(i + 1, p, [...caps, text.slice(pos, p)]);
      return;
    }
    for (let p = text.indexOf(lit, pos); p !== -1 && p + lit.length <= end; p = text.indexOf(lit, p + 1)) walk(i + 1, p + lit.length, [...caps, text.slice(pos, p)]);
  })(0, first.length, []);
  return out;
}

const cache = new Map<string, string | null>();

function toEnglish(text: string, depth = 0): string | null {
  if (text === "") return "";
  const exact = EN[text];
  if (exact !== undefined) return exact;
  if (depth > 3 || !/[؀-ۿ]/.test(text)) return null;
  const memo = cache.get(text);
  if (memo !== undefined) return memo;
  let best: { score: number; out: string } | null = null;
  for (const t of TEMPLATES) {
    if (t.literalLength > text.length) continue;
    for (const caps of splits(t.parts, text)) {
      if (caps.some((c, i) => c === "" && t.parts[i] !== "" && t.parts[i + 1] !== "")) continue; // only optional fragments may be empty
      // Prefer the split whose Arabic fragments are themselves system text (nested templates);
      // untranslatable fragments are user data (names, reasons) and are kept as they are.
      let score = t.literalLength * 10;
      const translated = caps.map((c) => {
        if (!/[؀-ۿ]/.test(c)) return c;
        const x = toEnglish(c, depth + 1);
        score += x === null ? -1 : 5;
        return x ?? c;
      });
      if (!best || score > best.score) best = { score, out: fill(EN[t.key]!, translated) };
    }
  }
  const result = best ? best.out : null;
  if (cache.size > 5000) cache.clear();
  cache.set(text, result);
  return result;
}

/** Translates system text stored in Arabic (exact or template match); unknown text is returned unchanged. */
export function translateText(text: string | null | undefined, locale: Locale = currentLocale()): string | null | undefined {
  if (!text || locale === "ar") return text;
  return toEnglish(text) ?? text;
}
