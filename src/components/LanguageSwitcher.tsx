"use client";

import { useI18n } from "@/i18n/provider";
import { locales } from "@/i18n/config";
import { cn } from "@/lib/utils";

export function LanguageSwitcher() {
  const { locale, setLocale, t } = useI18n();
  return (
    <div
      className="inline-flex rounded-md border border-line bg-surface p-0.5"
      role="group"
      aria-label={t.header.language}
    >
      {locales.map((l) => (
        <button
          key={l}
          type="button"
          onClick={() => setLocale(l)}
          aria-pressed={locale === l}
          className={cn(
            "rounded-[5px] px-2 py-1 text-xs font-bold uppercase tracking-wide transition-colors",
            locale === l ? "bg-accent text-accent-fg" : "text-muted hover:text-ink",
          )}
        >
          {l}
        </button>
      ))}
    </div>
  );
}
