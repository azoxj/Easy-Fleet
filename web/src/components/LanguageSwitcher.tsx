import { LOCALES, setLocale, t, useLocale } from "../i18n";
import { Icon } from "./icons";
import { cx } from "./ui";

/**
 * Language switcher. "segmented" shows both languages (login, public handover
 * pages); "compact" is a single button offering the other language (app header).
 * Native buttons → keyboard accessible; each label carries its own `lang` so
 * screen readers pronounce it correctly.
 */
export function LanguageSwitcher({ variant = "segmented", className }: { variant?: "segmented" | "compact"; className?: string }) {
  const locale = useLocale();
  if (variant === "compact") {
    const other = LOCALES.find((l) => l.code !== locale)!;
    return (
      <button
        type="button"
        onClick={() => setLocale(other.code)}
        className={cx("inline-flex min-h-11 items-center gap-1.5 rounded-lg px-2.5 text-sm font-medium text-slate-600 transition hover:bg-slate-100 hover:text-slate-800 active:bg-slate-200", className)}
        aria-label={t("language.switchTo", { language: other.label })}
        title={t("language.switchTo", { language: other.label })}
      >
        <Icon name="globe" className="size-5" />
        <span lang={other.code} className="hidden sm:inline">{other.label}</span>
      </button>
    );
  }
  return (
    <div role="group" aria-label={t("language.label")} className={cx("inline-flex rounded-lg bg-slate-100 p-1", className)}>
      {LOCALES.map((l) => (
        <button
          key={l.code}
          type="button"
          lang={l.code}
          aria-pressed={locale === l.code}
          onClick={() => setLocale(l.code)}
          className={cx("min-h-9 rounded-md px-3 text-sm font-medium transition", locale === l.code ? "bg-white text-slate-900 shadow-sm" : "text-slate-600 hover:text-slate-900")}
        >
          {l.label}
        </button>
      ))}
    </div>
  );
}
