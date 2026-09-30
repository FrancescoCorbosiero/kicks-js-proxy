"use client";

import { Navbar, Page, Preloader } from "konsta/react";
import { useI18n } from "@/i18n/provider";

/** Shown while the site answers — the Vetrina always reads it live. */
export function VetrinaLoading() {
  const { t } = useI18n();
  return (
    <Page>
      <Navbar title={t.vetrina.title} />
      <div className="grid place-items-center pt-24">
        <Preloader className="!h-8 !w-8" />
      </div>
    </Page>
  );
}
