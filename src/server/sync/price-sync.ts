import "server-only";
import { advanceStoreSync, startStoreSync, type PreviewResult } from "@/server/actions/preview";
import { applySync, type ApplyOutcome } from "@/server/woo/apply";
import { deleteRunPlans } from "@/server/plans/repo";
import { deleteSyncRun } from "./runs";

/**
 * Plan and write the prices (and feed stock) of some products — or of the
 * whole store — with nobody reviewing the plan: the scheduler's store sync,
 * the Vetrina's "publish this product", the "use the Hub's price" of the list
 * of prices changed on WordPress.
 *
 * The same preview the Sync tab runs, then its apply with "apply all", and
 * narrower on purpose: prices and stock only — never the size cleanup (it
 * deletes variations), never identifiers. The run is dropped afterwards, plans
 * and all: nobody reviews it, and left to the preview's retention its plans
 * would push the operator's own preview out of the runs it keeps.
 */

export interface PriceSyncOptions {
  /** Products to plan, any spelling. Omitted: the whole store. */
  skus?: string[];
  /** Read each product live before writing it (see live-check.ts): the unattended runs. */
  liveCheck?: boolean;
  /** Plan, then write nothing when more variations than this would change. */
  maxChanges?: number;
  /** Steps of 250 SKUs before giving up. Default: what the run needs, and some. */
  maxSteps?: number;
}

export interface PriceSyncResult {
  /** The finished run's report: totals, misses, warnings. */
  report: PreviewResult;
  /** What was written; null when nothing was to be, or when maxChanges stopped it. */
  outcome: ApplyOutcome | null;
  /** The changes planned, when there were more than maxChanges: nothing was written. */
  capped: number | null;
}

/** Throws when the run cannot be planned to the end: a half-read store is not a plan. */
export async function runPriceSync(opts: PriceSyncOptions = {}): Promise<PriceSyncResult> {
  const started = await startStoreSync(undefined, opts.skus);
  if (!started.ok || !started.progress) throw new Error(started.error ?? "the sync could not start");
  const runId = started.progress.runId;
  try {
    let progress = started.progress;
    // A step plans 250 SKUs and always moves the cursor or ends the run; the
    // bound only guards against a run that stops doing either.
    const maxSteps = opts.maxSteps ?? Math.ceil(progress.total / 100) + 10;
    for (let step = 0; !progress.done; step++) {
      if (progress.status !== "running") throw new Error(progress.error ?? `the sync was ${progress.status}`);
      if (step >= maxSteps) throw new Error("the sync did not finish");
      const next = await advanceStoreSync(runId);
      if (!next.ok || !next.progress) throw new Error(next.error ?? "a sync step failed");
      progress = next.progress;
    }
    const report = progress.result!;
    const planned = report.totals?.update ?? 0;
    if (planned === 0) return { report, outcome: null, capped: null };
    if (opts.maxChanges != null && planned > opts.maxChanges) return { report, outcome: null, capped: planned };
    const outcome = await applySync({
      runId,
      priceScope: "all",
      dryRun: false,
      sanitize: false,
      backfillGtins: false,
      liveCheck: opts.liveCheck,
    });
    return { report, outcome, capped: null };
  } finally {
    await deleteRunPlans(runId)
      .then(() => deleteSyncRun(runId))
      .catch((e) => console.warn(`[sync] run ${runId} kept: ${e instanceof Error ? e.message : String(e)}`));
  }
}
