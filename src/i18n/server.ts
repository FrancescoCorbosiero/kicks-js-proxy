import "server-only";
import { cookies } from "next/headers";
import { LOCALE_COOKIE, normalizeLocale, type Locale } from "./config";
import { getDictionary, type Dictionary } from "./dictionary";

/** Resolve the active locale from the cookie (defaults to Italian). */
export async function getLocale(): Promise<Locale> {
  const store = await cookies();
  return normalizeLocale(store.get(LOCALE_COOKIE)?.value);
}

/** The dictionary for the active locale, for use in server components. */
export async function getServerDictionary(): Promise<{ locale: Locale; t: Dictionary }> {
  const locale = await getLocale();
  return { locale, t: getDictionary(locale) };
}
