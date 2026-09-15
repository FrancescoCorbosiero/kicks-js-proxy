"use client";

import * as React from "react";
import { runRepair, scanRepairs, type RepairScanResult } from "@/server/actions/repair";
import type { RepairOutcome, RepairProductReport } from "@/server/woo/repair";
import { parseSkus } from "@/lib/skus";
import { chunkArray } from "@/lib/chunk";
import { useI18n } from "@/i18n/provider";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import { Badge } from "@/components/ui/badge";

/** Products per call: each one costs a lookup, a read and (maybe) a write. */
const CHUNK = 20;

/**
 * The non-destructive counterpart to force reimport: put back what products
 * on the store are MISSING — picture, brand, category, gender — and leave
 * everything else exactly as it is.
 *
 * Two ways in, because the two situations are different: paste the SKUs when
 * you know which products are wrong, or let it scan the store when you do not.
 */
export function RepairPanel() {
  const { t } = useI18n();
  const [text, setText] = React.useState("");
  const [scan, setScan] = React.useState<RepairScanResult | null>(null);
  const [scanning, setScanning] = React.useState(false);
  const [running, setRunning] = React.useState<"dry" | "live" | null>(null);
  const [progress, setProgress] = React.useState<{ done: number; total: number } | null>(null);
  const [error, setError] = React.useState<string | null>(null);
  const [dry, setDry] = React.useState<{ outcome: RepairOutcome; signature: string } | null>(null);
  const [applied, setApplied] = React.useState<RepairOutcome | null>(null);

  const skus = React.useMemo(() => parseSkus(text), [text]);
  const signature = [...skus].sort().join(",");
  const dryValid = dry != null && dry.signature === signature && skus.length > 0;
  // Nothing to write is not a reason to unlock the live button.
  const fixable = dryValid ? dry.outcome.repaired : 0;

  async function doScan() {
    setScanning(true);
    setError(null);
    try {
      const res = await scanRepairs();
      setScan(res);
      if (!res.ok) setError(res.error ?? t.repair.failed);
    } finally {
      setScanning(false);
    }
  }

  /** Run the whole selection in server-sized batches, merging the reports. */
  async function run(dryRun: boolean) {
    if (skus.length === 0) return;
    setError(null);
    setRunning(dryRun ? "dry" : "live");
    setProgress({ done: 0, total: skus.length });
    try {
      let merged: RepairOutcome | null = null;
      for (const batch of chunkArray(skus, CHUNK)) {
        const res = await runRepair({ skus: batch, dryRun });
        if (!res.ok || !res.outcome) {
          setError(res.error ?? t.repair.failed);
          break;
        }
        merged = merged ? mergeOutcomes(merged, res.outcome) : res.outcome;
        setProgress((p) => ({ done: Math.min((p?.done ?? 0) + batch.length, skus.length), total: skus.length }));
        if (dryRun) setDry({ outcome: merged, signature });
        else setApplied(merged);
      }
      if (!dryRun && merged) {
        setDry(null);
        void doScan(); // the gaps just closed should leave the scan
      }
    } finally {
      setRunning(null);
      setProgress(null);
    }
  }

  const outcome = applied ?? dry?.outcome ?? null;
  const busy = running != null || scanning;

  return (
    <div className="space-y-3 rounded-xl border border-line bg-surface px-4 py-3">
      <div className="flex flex-wrap items-center gap-2">
        <span className="text-sm font-semibold">{t.repair.title}</span>
        <Badge variant="update">{t.repair.tag}</Badge>
        <p className="w-full text-xs leading-relaxed text-muted">{t.repair.hint}</p>
      </div>

      {/* Find them, or name them. */}
      <div className="flex flex-wrap items-center gap-2">
        <Button type="button" variant="outline" size="sm" onClick={doScan} disabled={busy}>
          {scanning ? t.repair.scanning : t.repair.scan}
        </Button>
        {scan?.ok && (
          <>
            <span className="text-xs text-muted tnum">
              {t.repair.scanResult(scan.incomplete.length, scan.repairable.length)}
            </span>
            {scan.incomplete.length > 0 && (
              <button
                type="button"
                className="text-xs font-semibold text-accent-text underline-offset-2 hover:underline"
                onClick={() => setText(scan.incomplete.join(", "))}
              >
                {t.repair.useIncomplete(scan.incomplete.length)}
              </button>
            )}
            {scan.repairable.length > 0 && (
              <button
                type="button"
                className="text-xs font-medium text-muted underline-offset-2 hover:text-ink hover:underline"
                onClick={() => setText(scan.repairable.join(", "))}
              >
                {t.repair.useAll(scan.repairable.length)}
              </button>
            )}
          </>
        )}
      </div>

      <Textarea
        placeholder={t.repair.placeholder}
        value={text}
        onChange={(e) => {
          setText(e.target.value);
          setDry(null);
          setApplied(null);
        }}
        rows={3}
      />

      <div className="flex flex-wrap items-center gap-3">
        <span className="text-xs text-muted tnum">{t.repair.parsed(skus.length)}</span>
        <Button
          type="button"
          variant="outline"
          onClick={() => run(true)}
          disabled={busy || skus.length === 0}
        >
          {running === "dry" && progress
            ? t.repair.progress(progress.done, progress.total)
            : t.repair.dryRun(skus.length)}
        </Button>
        <Button
          type="button"
          variant="accent"
          onClick={() => run(false)}
          disabled={busy || !dryValid || fixable === 0}
          title={!dryValid ? t.repair.dryRunFirst : undefined}
        >
          {running === "live" && progress
            ? t.repair.progress(progress.done, progress.total)
            : t.repair.apply(fixable)}
        </Button>
        {!dryValid && skus.length > 0 && (
          <span className="text-[11px] text-faint">{t.repair.dryRunFirst}</span>
        )}
        {dryValid && fixable === 0 && (
          <span className="text-[11px] font-medium text-up">{t.repair.allWhole}</span>
        )}
        {error && <span className="text-sm font-medium text-skip">{error}</span>}
      </div>

      {outcome && <RepairReport outcome={outcome} />}
    </div>
  );
}

/** Fold a batch into the running outcome — the operator sees one list. */
function mergeOutcomes(a: RepairOutcome, b: RepairOutcome): RepairOutcome {
  return {
    ...a,
    products: [...a.products, ...b.products],
    repaired: a.repaired + b.repaired,
    alreadyWhole: a.alreadyWhole + b.alreadyWhole,
    failed: a.failed + b.failed,
    identitySkipped: [...new Set([...a.identitySkipped, ...b.identitySkipped])],
  };
}

function RepairReport({ outcome }: { outcome: RepairOutcome }) {
  const { t } = useI18n();
  const acted = outcome.products.filter((p) => p.filled.length > 0 || p.error);
  return (
    <div className="space-y-1 rounded-lg border border-line bg-surface-2 px-3 py-2 text-xs">
      <div className="flex flex-wrap items-center gap-2">
        <span className="font-semibold">
          {outcome.dryRun ? t.repair.dryTitle : t.repair.liveTitle}
        </span>
        <Badge variant="create">{t.repair.repaired(outcome.repaired)}</Badge>
        <Badge variant="skip">{t.repair.whole(outcome.alreadyWhole)}</Badge>
        {outcome.failed > 0 && (
          <span className="font-semibold text-skip">{t.repair.failedCount(outcome.failed)}</span>
        )}
      </div>
      {outcome.identitySkipped.length > 0 && (
        <p className="text-[11px] text-warn">
          {t.publish.identitySkipped(outcome.identitySkipped.join(", "))}
        </p>
      )}
      {acted.length > 0 && (
        <ul className="space-y-0.5">
          {acted.slice(0, 40).map((p) => (
            <ReportRow key={p.sku} report={p} />
          ))}
        </ul>
      )}
      {acted.length > 40 && (
        <p className="text-faint">{t.repair.andMore(acted.length - 40)}</p>
      )}
    </div>
  );
}

function ReportRow({ report }: { report: RepairProductReport }) {
  const { t } = useI18n();
  return (
    <li className="flex flex-wrap items-center gap-x-2 border-t border-line/60 pt-1 first:border-0 first:pt-0">
      <span className="font-mono text-faint">{report.sku}</span>
      <span className="min-w-0 flex-1 truncate text-muted">{report.title}</span>
      {report.filled.map((f) => (
        <span key={f} className="rounded bg-up/12 px-1.5 py-0.5 font-medium text-up">
          {t.repair.fields[f]}
        </span>
      ))}
      {report.unavailable.map((f) => (
        <span key={f} className="text-faint" title={t.repair.unavailableHint}>
          {t.repair.fields[f]} —
        </span>
      ))}
      {report.error && <span className="font-medium text-skip">{report.error}</span>}
    </li>
  );
}
