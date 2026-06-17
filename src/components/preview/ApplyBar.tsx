"use client";

import * as React from "react";
import useSWR from "swr";
import { startApply } from "@/server/actions/apply";
import { applyStatus } from "@/server/actions/apply";
import { importProducts } from "@/server/actions/import";
import type { ApplyJobStatus } from "@/server/apply/types";
import { Button } from "@/components/ui/button";

interface Props {
  selections: { planId: string; variantIds: string[] }[];
  createPlanIds: string[];
}

const TERMINAL = new Set(["completed", "failed", "not_found"]);

export function ApplyBar({ selections, createPlanIds }: Props) {
  const [dryRun, setDryRun] = React.useState(true);
  const [jobId, setJobId] = React.useState<string | null>(null);
  const [error, setError] = React.useState<string | null>(null);
  const [starting, startStart] = React.useTransition();

  const [importing, startImport] = React.useTransition();
  const [importMsg, setImportMsg] = React.useState<string | null>(null);

  const totalSelected = selections.reduce((n, s) => n + s.variantIds.length, 0);

  const { data: status } = useSWR<ApplyJobStatus>(
    jobId ? ["apply-status", jobId] : null,
    () => applyStatus(jobId!),
    { refreshInterval: (d) => (d && TERMINAL.has(d.state) ? 0 : 1000) },
  );

  function run(approved: boolean) {
    setError(null);
    startStart(async () => {
      const res = await startApply({ selections, dryRun, approved });
      if (!res.ok) {
        setError(res.error ?? "Failed to start");
        return;
      }
      setJobId(res.jobId ?? null);
    });
  }

  function onImport() {
    setImportMsg(null);
    startImport(async () => {
      const res = await importProducts({ planIds: createPlanIds });
      const parts = [`created ${res.created.length}`];
      if (res.failed.length) parts.push(`failed ${res.failed.length}`);
      setImportMsg(parts.join(" · "));
    });
  }

  const result = status?.result ?? null;
  const running = !!jobId && (!status || !TERMINAL.has(status.state));
  const needsApproval = !dryRun && (result?.heldForApproval ?? 0) > 0;

  return (
    <div className="sticky bottom-4 z-10 rounded-xl border border-neutral-200 bg-white p-4 shadow-lg">
      <div className="flex flex-wrap items-center gap-3">
        <label className="flex items-center gap-2 text-sm">
          <input type="checkbox" checked={dryRun} onChange={(e) => setDryRun(e.target.checked)} />
          Dry run (no writes)
        </label>

        <Button onClick={() => run(false)} disabled={totalSelected === 0 || starting || running}>
          {running ? "Applying…" : dryRun ? `Dry-run ${totalSelected}` : `Apply ${totalSelected}`}
        </Button>

        {createPlanIds.length > 0 && (
          <Button variant="outline" onClick={onImport} disabled={importing}>
            {importing ? "Importing…" : `Import ${createPlanIds.length} new`}
          </Button>
        )}

        <span className="ml-auto text-xs text-neutral-500">
          {totalSelected} variants selected across {selections.length} products
        </span>
      </div>

      {running && (
        <div className="mt-3">
          <div className="h-1.5 w-full overflow-hidden rounded-full bg-neutral-100">
            <div
              className="h-full bg-neutral-900 transition-all"
              style={{ width: `${status?.progress ?? 0}%` }}
            />
          </div>
        </div>
      )}

      {result && (
        <div className="mt-3 flex flex-wrap items-center gap-x-4 gap-y-1 text-sm">
          <span className="font-medium">
            {dryRun ? "Dry run:" : "Applied:"} {result.updated} updated
          </span>
          <span className="text-neutral-500">{result.skipped} skipped</span>
          {result.createPending > 0 && (
            <span className="text-emerald-700">{result.createPending} need import</span>
          )}
          {result.heldForApproval > 0 && (
            <span className="text-amber-700">{result.heldForApproval} held for approval</span>
          )}
          {result.failed.length > 0 && (
            <span className="text-rose-600">{result.failed.length} failed</span>
          )}
        </div>
      )}

      {needsApproval && (
        <div className="mt-2">
          <Button variant="outline" onClick={() => run(true)} disabled={starting || running}>
            Approve &amp; apply {result?.heldForApproval} above-threshold change(s)
          </Button>
        </div>
      )}

      {importMsg && <p className="mt-2 text-sm text-neutral-600">Import: {importMsg}</p>}
      {error && <p className="mt-2 text-sm text-rose-600">{error}</p>}
    </div>
  );
}
