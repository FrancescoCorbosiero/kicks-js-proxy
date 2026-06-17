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
    { productsChanged: number; variationsChanged: number; unmatched: number } | null
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
    <div className="sticky bottom-4 z-10 rounded-xl border border-neutral-200 bg-white p-4 shadow-lg">
      <div className="flex flex-wrap items-center gap-3">
        <Button onClick={run} disabled={totalSelected === 0 || pending}>
          {pending ? "Building…" : `Export repriced JSON (${totalSelected})`}
        </Button>
        <span className="text-xs text-neutral-500">
          {totalSelected} variants across {selections.length} products → downloads a
          re-import file; prices only, everything else preserved.
        </span>
      </div>

      {summary && (
        <div className="mt-2 flex flex-wrap items-center gap-x-4 text-sm">
          <span className="font-medium">{summary.variationsChanged} variations repriced</span>
          <span className="text-neutral-500">{summary.productsChanged} products in file</span>
          {summary.unmatched > 0 && (
            <span className="text-amber-700">{summary.unmatched} not on store (create)</span>
          )}
        </div>
      )}
      {error && <p className="mt-2 text-sm text-rose-600">{error}</p>}
    </div>
  );
}
