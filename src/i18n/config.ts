/**
 * i18n configuration. Italian is the default and the source-of-truth locale.
 */
export const locales = ["it", "en"] as const;
export type Locale = (typeof locales)[number];

export const defaultLocale: Locale = "it";

/** Cookie the server reads to render the right language (no client flash). */
export const LOCALE_COOKIE = "kx-locale";

export function isLocale(value: string | undefined | null): value is Locale {
  return value === "it" || value === "en";
}

export function normalizeLocale(value: string | undefined | null): Locale {
  return isLocale(value) ? value : defaultLocale;
}
