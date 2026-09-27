import { useSyncExternalStore } from "react";
import { ar, type MessageKey } from "./ar";
import { en } from "./en";

/**
 * Easy Fleet i18n (Arabic RTL default, English LTR).
 *
 * - Messages live in ./ar.ts and ./en.ts as flat dictionaries keyed by
 *   dotted keys ("nav.dashboard", "enums.vehicleStatus.AVAILABLE"…); en.ts is
 *   typed against ar.ts, so a missing or extra key fails the typecheck.
 * - `t()` is a plain function (usable in hooks, handlers and lazy getters of
 *   module-level label maps). Switching the language re-renders the app
 *   (the root is keyed by locale), so every `t()` call is evaluated again.
 * - The choice is stored in localStorage (survives refresh and logout/login)
 *   and applied to <html lang dir>.
 * - User-entered data (names, plates, notes…) is never passed through `t()`.
 */
export type Locale = "ar" | "en";
export type { MessageKey };

export const LOCALES: { code: Locale; label: string; dir: "rtl" | "ltr" }[] = [
  { code: "ar", label: "العربية", dir: "rtl" },
  { code: "en", label: "English", dir: "ltr" },
];

const STORAGE_KEY = "ef.locale";
const DICTS: Record<Locale, Record<string, string>> = { ar, en };

function readStored(): Locale {
  try {
    const v = globalThis.localStorage?.getItem(STORAGE_KEY);
    return v === "en" || v === "ar" ? v : "ar";
  } catch {
    return "ar";
  }
}

let current: Locale = readStored();
const listeners = new Set<() => void>();

export const getLocale = (): Locale => current;
export const isRtl = (l: Locale = current) => l === "ar";
export const dirOf = (l: Locale = current): "rtl" | "ltr" => (l === "ar" ? "rtl" : "ltr");

/** Applies lang/dir to <html> (screen readers, bidi, logical CSS). */
export function applyDocumentLocale(l: Locale = current) {
  if (typeof document === "undefined") return;
  document.documentElement.lang = l;
  document.documentElement.dir = dirOf(l);
}

export function setLocale(l: Locale) {
  if (l === current) return;
  current = l;
  try {
    globalThis.localStorage?.setItem(STORAGE_KEY, l);
  } catch {
    /* storage unavailable: keep for this session */
  }
  applyDocumentLocale(l);
  listeners.forEach((f) => f());
}

export function subscribeLocale(f: () => void) {
  listeners.add(f);
  return () => listeners.delete(f);
}

/** React hook: current locale (re-renders on change). */
export function useLocale(): Locale {
  return useSyncExternalStore(subscribeLocale, getLocale, getLocale);
}

type Vars = Record<string, string | number | null | undefined>;

function interpolate(s: string, vars?: Vars) {
  if (!vars) return s;
  return s.replace(/\{(\w+)\}/g, (m, k: string) => (k in vars ? String(vars[k] ?? "") : m));
}

/** Translate a key (typed). Falls back to Arabic, then to the key itself. */
export function t(key: MessageKey, vars?: Vars): string {
  return interpolate(DICTS[current][key] ?? ar[key] ?? key, vars);
}

/** Translate a key built at runtime (e.g. an enum value); returns `fallback` when unknown. */
export function tDynamic(key: string, fallback?: string, vars?: Vars): string {
  const s = DICTS[current][key] ?? (ar as Record<string, string>)[key];
  return s === undefined ? (fallback ?? key) : interpolate(s, vars);
}

export const hasKey = (key: string) => key in ar;

/** Intl locale used for numbers and dates (Latin digits, Gregorian calendar in Arabic). */
export const intlLocale = (l: Locale = current) => (l === "ar" ? "ar-SA-u-nu-latn-ca-gregory" : "en-GB");
