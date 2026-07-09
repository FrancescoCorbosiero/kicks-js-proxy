"use client";

import * as React from "react";
import { sanitizeStoreJson } from "@/server/actions/sanitize";
import type { SanitizeReport } from "@/server/store-json/sanitize";
import { useI18n } from "@/i18n/provider";
import { Button } from "@/components/ui/button";

function downloadJson(filename: string, json: string) {
  const blob = new Blob([json], { type: "application/json" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  a.click();
  URL.revokeObjectURL(url);
}

/**
 * Runs the store-file sanitizer and downloads the cleaned re-import JSON: drops
 * zero-stock ghost variations and realigns pa_taglia. Separate from the reprice
 * export so it's a deliberate, reviewable step.
 */
export function SanitizePanel() {
  const { t } = useI18n();
  const [pending, start] = React.useTransition();
  const [error, setError] = React.useState<string | null>(null);
  const [report, setReport] = React.useState<SanitizeReport | null>(null);

  function run() {
    setError(null);
    setReport(null);
    start(async () => {
      const res = await sanitizeStoreJson();
      if (!res.ok || !res.json) {
        setError(res.error ?? t.sanitize.failed);
        return;
      }
      if (res.report && res.report.productsChanged > 0) {
        downloadJson(res.filename ?? "sanitized.json", res.json);
      }
      setReport(res.report ?? null);
    });
  }

  const clean = report != null && report.productsChanged === 0;

  return (
    <div className="rounded-xl border border-line bg-surface p-4 shadow-xs">
      <div className="flex flex-wrap items-center gap-3">
        <span className="grid h-9 w-9 shrink-0 place-items-center rounded-lg bg-accent/15 text-accent-text">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" className="h-[18px] w-[18px]">
            <path d="M3 3l18 18M9 3h6l-1 6M8 9l-2 9a2 2 0 0 0 2 2h8a2 2 0 0 0 2-2l-1-4" />
          </svg>
        </span>
        <div className="min-w-0">
          <div className="text-sm font-semibold">{t.sanitize.title}</div>
          <div className="text-xs text-muted">{t.sanitize.desc}</div>
        </div>
        <Button type="button" variant="accent" onClick={run} disabled={pending} className="ml-auto">
          {pending ? (
            <>
              <span className="spin h-4 w-4 rounded-full border-2 border-accent-fg/30 border-t-accent-fg" />
              {t.sanitize.building}
            </>
          ) : (
            t.sanitize.button
          )}
        </Button>
      </div>

      {report && (
        <div className="mt-3 flex flex-wrap items-center gap-x-4 gap-y-1 border-t border-line pt-3 text-sm animate-fade-up">
          {clean ? (
            <span className="text-down">{t.sanitize.clean}</span>
          ) : (
            <>
              <span className="font-semibold text-down">{t.sanitize.ghostsRemoved(report.ghostsRemoved)}</span>
              <span className="text-muted">{t.sanitize.taglieRealigned(report.taglieRealigned)}</span>
              {report.parentAttributesRealigned > 0 && (
                <span className="text-muted">{t.sanitize.parentsRealigned(report.parentAttributesRealigned)}</span>
              )}
              <span className="text-faint">{t.sanitize.productsChanged(report.productsChanged)}</span>
            </>
          )}
          <span className="ml-auto text-xs text-faint tnum">
            {t.sanitize.scanned(report.productsScanned, report.variationsScanned)}
          </span>
        </div>
      )}
      {error && <p className="mt-2 text-sm text-skip">{error}</p>}
    </div>
  );
}
