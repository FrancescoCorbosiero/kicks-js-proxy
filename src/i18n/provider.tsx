"use client";

import * as React from "react";
import { useRouter } from "next/navigation";
import { LOCALE_COOKIE, type Locale } from "./config";
import { getDictionary, type Dictionary } from "./dictionary";

interface I18nValue {
  locale: Locale;
  /** The active dictionary. Conventionally destructured as `t`. */
  t: Dictionary;
  setLocale: (locale: Locale) => void;
}

const I18nContext = React.createContext<I18nValue | null>(null);

export function I18nProvider({
  initialLocale,
  children,
}: {
  initialLocale: Locale;
  children: React.ReactNode;
}) {
  const router = useRouter();
  const [locale, setLocaleState] = React.useState<Locale>(initialLocale);

  // Reconcile if the server re-renders with a different cookie value.
  React.useEffect(() => {
    setLocaleState(initialLocale);
  }, [initialLocale]);

  const setLocale = React.useCallback(
    (next: Locale) => {
      document.cookie = `${LOCALE_COOKIE}=${next}; path=/; max-age=31536000; samesite=lax`;
      try {
        localStorage.setItem(LOCALE_COOKIE, next);
      } catch {}
      document.documentElement.lang = next;
      setLocaleState(next);
      // Re-render server components (pages, layout chrome) with the new cookie.
      router.refresh();
    },
    [router],
  );

  const value = React.useMemo<I18nValue>(
    () => ({ locale, t: getDictionary(locale), setLocale }),
    [locale, setLocale],
  );

  return <I18nContext.Provider value={value}>{children}</I18nContext.Provider>;
}

export function useI18n(): I18nValue {
  const ctx = React.useContext(I18nContext);
  if (!ctx) throw new Error("useI18n must be used within <I18nProvider>");
  return ctx;
}
