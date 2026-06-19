"use client";

import * as React from "react";
import { exportRepricedJson } from "@/server/actions/export";
import { Button } from "@/components/ui/button";

interface Props {
  selections: { planId: string; variantIds: string[] }[];
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

export function ExportBar({ selections }: Props) {
  const [pending, start] = React.useTransition();
  const [error, setError] = React.useState<string | null>(null);
  const [summary, setSummary] = React.useState<
    { productsChanged: number; variationsChanged: number; gtinsWritten: number; unmatched: number } | null
  >(null);

  const totalSelected = selections.reduce((n, s) => n + s.variantIds.length, 0);

  function run() {
    setError(null);
    setSummary(null);
    start(async () => {
      const res = await exportRepricedJson({ selections });
      if (!res.ok || !res.json) {
        setError(res.error ?? "Export failed");
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
          <span className="text-sm font-semibold">
            <span className="tnum">{totalSelected}</span> variant{totalSelected === 1 ? "" : "s"} ready to export
          </span>
          <span className="text-xs text-faint">
            Across {selections.length} product{selections.length === 1 ? "" : "s"} · prices only, everything else preserved.
          </span>
        </div>
        <Button
          variant="accent"
          onClick={run}
          disabled={totalSelected === 0 || pending}
          className="ml-auto"
        >
          {pending ? (
            <>
              <span className="spin h-4 w-4 rounded-full border-2 border-accent-fg/30 border-t-accent-fg" />
              Building…
            </>
          ) : (
            `Export repriced JSON`
          )}
        </Button>
      </div>

      {summary && (
        <div className="mt-3 flex flex-wrap items-center gap-x-4 gap-y-1 border-t border-line pt-3 text-sm animate-fade-up">
          <span className="font-semibold">{summary.variationsChanged} variations repriced</span>
          <span className="text-muted">{summary.productsChanged} products in file</span>
          {summary.gtinsWritten > 0 && (
            <span className="text-down">{summary.gtinsWritten} GTINs written</span>
          )}
          {summary.unmatched > 0 && (
            <span className="text-warn">{summary.unmatched} not on store (create)</span>
          )}
        </div>
      )}
      {error && <p className="mt-2 text-sm text-skip">{error}</p>}
    </div>
  );
}
