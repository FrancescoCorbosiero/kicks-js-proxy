"use client";

import * as React from "react";
import { useI18n } from "@/i18n/provider";

/**
 * Dates in the shop's time zone and the UI's language. Fixed both ways so the
 * server and the browser print the same text, which hydration requires: a
 * bare toLocaleString() prints the server's zone and language on the server
 * and the viewer's in the browser.
 */
export function useShopTime(timeZone: string) {
  const { locale } = useI18n();
  return React.useMemo(() => {
    const tag = locale === "it" ? "it-IT" : "en-GB";
    const dateTime = new Intl.DateTimeFormat(tag, { timeZone, dateStyle: "short", timeStyle: "short" });
    const time = new Intl.DateTimeFormat(tag, { timeZone, timeStyle: "short" });
    return {
      dateTime: (at: number | string | Date) => dateTime.format(new Date(at)),
      time: (at: number | string | Date) => time.format(new Date(at)),
    };
  }, [locale, timeZone]);
}
