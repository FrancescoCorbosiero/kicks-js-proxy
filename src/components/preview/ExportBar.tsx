"use client";

import * as React from "react";
import { exportRepricedJson, type ExportSummary } from "@/server/actions/export";
import { useI18n } from "@/i18n/provider";
import { cn } from "@/lib/utils";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";

interface Props {
  selections: { planId: string; variantIds: string[] }[];
  kicksdbVariationIds: number[]; // zero-stock + on KicksDB -> kept & made available
  previewedProductIds: number[]; // only these products are sanitized
}

function downloadJson(filename: string, json: string) {
  const blob = new Blob([json], { type: "application/json" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  a.click();
  URL.revokeObjectURL(url);
}

export function ExportBar({ selections, kicksdbVariationIds, previewedProductIds }: Props) {
  const { t } = useI18n();
  const [pending, start] = React.useTransition();
  const [error, setError] = React.useState<string | null>(null);
  const [sanitize, setSanitize] = React.useState(true);
  const [summary, setSummary] = React.useState<ExportSummary | null>(null);

  const totalSelected = selections.reduce((n, s) => n + s.variantIds.length, 0);
  const canExport = totalSelected > 0 || sanitize; // reprice, sanitize, or both

  function run() {
    setError(null);
    setSummary(null);
    start(async () => {
      const res = await exportRepricedJson({
        selections,
        sanitize,
        kicksdbVariationIds,
        previewedProductIds,
      });
      if (!res.ok || !res.json) {
        setError(res.error ?? t.exportBar.failed);
        return;
      }
      downloadJson(res.filename ?? "repriced.json", res.json);
      setSummary(res.summary ?? null);
    });
  }

  return (
    <div className="sticky bottom-4 z-20 rounded-xl border border-line-strong bg-elevated/90 p-3.5 shadow-pop backdrop-blur-xl">
      <div className="flex flex-wrap items-center gap-3">
        <span className="grid h-9 w-9 place-items-center rounded-lg bg-accent/15 text-accent-text">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" className="h-[18px] w-[18px]">
            <path d="M12 3v12m0 0 4-4m-4 4-4-4" />
            <path d="M4 17v2a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2v-2" />
          </svg>
        </span>
        <div className="flex flex-col">
          <span className="text-sm font-semibold tnum">
            {totalSelected > 0 ? t.exportBar.ready(totalSelected) : t.exportBar.readySanitizeOnly}
          </span>
          <span className="text-xs text-faint">{t.exportBar.across(selections.length)}</span>
        </div>

        <label
          className={cn(
            "ml-auto flex cursor-pointer items-center gap-2 rounded-lg border px-2.5 py-1.5 text-xs font-medium transition-colors",
            sanitize
              ? "border-accent/50 bg-accent/10 text-accent-text"
              : "border-line bg-surface-2 text-muted hover:text-ink",
          )}
          title={t.exportBar.sanitizeToggleHint}
        >
          <Checkbox
            checked={sanitize}
            onCheckedChange={(c) => setSanitize(c === true)}
            aria-label={t.exportBar.sanitizeToggle}
          />
          {t.exportBar.sanitizeToggle}
        </label>

        <Button variant="accent" onClick={run} disabled={!canExport || pending}>
          {pending ? (
            <>
              <span className="spin h-4 w-4 rounded-full border-2 border-accent-fg/30 border-t-accent-fg" />
              {t.exportBar.building}
            </>
          ) : (
            t.exportBar.button
          )}
        </Button>
      </div>

      {summary && (
        <div className="mt-3 flex flex-wrap items-center gap-x-4 gap-y-1 border-t border-line pt-3 text-sm animate-fade-up">
          <span className="font-semibold">{t.exportBar.variationsChanged(summary.variationsChanged)}</span>
          {summary.sanitized && (
            <>
              {summary.stockSynthesized > 0 && (
                <span className="text-up">{t.sanitize.stockSynthesized(summary.stockSynthesized)}</span>
              )}
              <span className="text-down">{t.sanitize.ghostsRemoved(summary.ghostsRemoved)}</span>
              <span className="text-muted">{t.sanitize.taglieRealigned(summary.taglieRealigned)}</span>
              {summary.parentAttributesRealigned > 0 && (
                <span className="text-muted">{t.sanitize.parentsRealigned(summary.parentAttributesRealigned)}</span>
              )}
            </>
          )}
          <span className="text-muted">{t.exportBar.productsChanged(summary.productsChanged)}</span>
          {summary.gtinsWritten > 0 && <span className="text-down">{t.exportBar.gtins(summary.gtinsWritten)}</span>}
          {summary.unmatched > 0 && <span className="text-warn">{t.exportBar.unmatched(summary.unmatched)}</span>}
        </div>
      )}
      {error && <p className="mt-2 text-sm text-skip">{error}</p>}
    </div>
  );
}
