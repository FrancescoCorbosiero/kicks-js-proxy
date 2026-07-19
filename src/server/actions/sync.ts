"use server";

import { z } from "zod";
import {
  advancePull,
  cancelPull,
  getLatestPullRun,
  startPull,
  type PullProgress,
} from "@/server/woo/pull";
import {
  applySync,
  listApplyHistory,
  type ApplyHistoryEntry,
  type ApplyOutcome,
} from "@/server/woo/apply";
import { wooConfigured } from "@/server/woo/client";

function errMessage(e: unknown): string {
  const cause = (e as { cause?: { message?: string } })?.cause;
  return cause?.message ?? (e instanceof Error ? e.message : String(e));
}

export interface PullActionResult {
  ok: boolean;
  error?: string;
  progress?: PullProgress;
  resumed?: boolean;
}

/** Open (or resume) the store pull. The client then loops advanceStorePull. */
export async function startStorePull(): Promise<PullActionResult> {
  try {
    const { run, resumed } = await startPull();
    return {
      ok: true,
      resumed,
      progress: {
        runId: run.id,
        status: run.status,
        productsFetched: run.productsFetched,
        variationsFetched: run.variationsFetched,
        totalProducts: run.totalProducts,
        done: run.status === "done",
        error: run.error,
      },
    };
  } catch (e) {
    return { ok: false, error: errMessage(e) };
  }
}

const AdvanceSchema = z.object({ runId: z.uuid(), pages: z.number().int().min(1).max(5).default(1) });

/** Fetch the next slice of the store. Returns done: true when the snapshot is live. */
export async function advanceStorePull(
  input: z.infer<typeof AdvanceSchema>,
): Promise<PullActionResult> {
  const parsed = AdvanceSchema.safeParse(input);
  if (!parsed.success) return { ok: false, error: "invalid input" };
  try {
    const progress = await advancePull(parsed.data.runId, parsed.data.pages);
    return { ok: true, progress };
  } catch (e) {
    return { ok: false, error: errMessage(e) };
  }
}

const CancelSchema = z.object({ runId: z.uuid() });

export async function cancelStorePull(
  input: z.infer<typeof CancelSchema>,
): Promise<{ ok: boolean; error?: string }> {
  const parsed = CancelSchema.safeParse(input);
  if (!parsed.success) return { ok: false, error: "invalid input" };
  try {
    await cancelPull(parsed.data.runId);
    return { ok: true };
  } catch (e) {
    return { ok: false, error: errMessage(e) };
  }
}

export interface SyncPageState {
  wooConfigured: boolean;
  runningPull: PullProgress | null;
  history: ApplyHistoryEntry[];
}

/** Everything the sync page header needs (also used to refresh after actions). */
export async function getSyncState(): Promise<SyncPageState> {
  const [latest, history] = await Promise.all([
    getLatestPullRun().catch(() => null),
    listApplyHistory().catch(() => [] as ApplyHistoryEntry[]),
  ]);
  return {
    wooConfigured: wooConfigured(),
    runningPull:
      latest && latest.status === "running"
        ? {
            runId: latest.id,
            status: latest.status,
            productsFetched: latest.productsFetched,
            variationsFetched: latest.variationsFetched,
            totalProducts: latest.totalProducts,
            done: false,
            error: latest.error,
          }
        : null,
    history,
  };
}

const ApplySchema = z
  .object({
    selections: z
      .array(z.object({ planId: z.string().min(1), variantIds: z.array(z.string().min(1)).min(1) }))
      .default([]),
    dryRun: z.boolean(),
    // Align sizes before pricing: delete orphan/duplicate variations and
    // realign pa_taglia (variants + parent option list). Default on.
    sanitize: z.boolean().default(true),
    kicksdbVariationIds: z.array(z.number()).default([]),
    previewedProductIds: z.array(z.number()).default([]),
  })
  .refine((v) => v.selections.length > 0 || v.sanitize, {
    message: "Nothing to do: no price selection and cleanup is off.",
  });

export interface ApplyActionResult {
  ok: boolean;
  error?: string;
  outcome?: ApplyOutcome;
}

/**
 * Execute (or dry-run) the sync against the live store: size cleanup first
 * (orphan deletion + pa_taglia alignment), then the selected price writes.
 * Dry-run computes and audits the exact operations without touching Woo.
 */
export async function applySyncPrices(
  input: z.infer<typeof ApplySchema>,
): Promise<ApplyActionResult> {
  const parsed = ApplySchema.safeParse(input);
  if (!parsed.success) return { ok: false, error: "invalid input" };
  try {
    const outcome = await applySync(parsed.data.selections, {
      dryRun: parsed.data.dryRun,
      sanitize: parsed.data.sanitize,
      kicksdbVariationIds: parsed.data.kicksdbVariationIds,
      previewedProductIds: parsed.data.previewedProductIds,
    });
    return { ok: true, outcome };
  } catch (e) {
    return { ok: false, error: errMessage(e) };
  }
}
