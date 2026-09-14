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
import { rebuildProducts, type RebuildOutcome } from "@/server/woo/rebuild";

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
  /**
   * Catalog products the store does NOT carry yet. The sync reprices what is
   * on the store, so on a fresh shop it legitimately has almost nothing to do
   * while hundreds of feed products wait in Publish — a state that reads as a
   * broken sync unless the page says so out loud.
   */
  unpublished: number;
}

/** Everything the sync page header needs (also used to refresh after actions). */
export async function getSyncState(): Promise<SyncPageState> {
  const { listPublishTargets } = await import("@/server/woo/publish");
  const [latest, history, targets] = await Promise.all([
    getLatestPullRun().catch(() => null),
    listApplyHistory().catch(() => [] as ApplyHistoryEntry[]),
    listPublishTargets().catch(() => ({ candidates: [] })),
  ]);
  return {
    wooConfigured: wooConfigured(),
    unpublished: targets.candidates.filter((c) => !c.onStore).length,
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
    // Feed-owned products (finite stock) — excluded from KicksDB-style cleanup.
    feedProductIds: z.array(z.number()).default([]),
    // Fill empty GTINs from the source across the whole preview, not just the
    // price selection (a correctly-priced row is a noop and never selectable).
    backfillGtins: z.boolean().default(true),
    planIds: z.array(z.string().min(1)).default([]),
  })
  .refine((v) => v.selections.length > 0 || v.sanitize || (v.backfillGtins && v.planIds.length > 0), {
    message: "Nothing to do: no price selection, no cleanup, no identifiers to fill.",
  });

export interface ApplyActionResult {
  ok: boolean;
  error?: string;
  outcome?: ApplyOutcome;
}

const RebuildSchema = z.object({
  skus: z.array(z.string().min(1)).min(1).max(100),
  dryRun: z.boolean(),
  // Bulk mode: accumulate chunked calls into one audit row.
  auditId: z.uuid().optional(),
});

export interface RebuildActionResult {
  ok: boolean;
  error?: string;
  outcome?: RebuildOutcome;
}

/**
 * Obliterate + re-create the variation sets of the given products from the
 * KicksDB catalog (parent untouched; per-variation extras carried over by
 * size). Destructive — dry-run first, always.
 */
export async function rebuildStoreProducts(
  input: z.infer<typeof RebuildSchema>,
): Promise<RebuildActionResult> {
  const parsed = RebuildSchema.safeParse(input);
  if (!parsed.success) return { ok: false, error: "invalid input" };
  try {
    const outcome = await rebuildProducts(parsed.data.skus, parsed.data.dryRun, parsed.data.auditId);
    return { ok: true, outcome };
  } catch (e) {
    return { ok: false, error: errMessage(e) };
  }
}

/**
 * Every SKU the bulk rebuild can cover: known to a source of truth — the
 * KicksDB catalog OR the GoldenSneakers feed — AND present in the pulled
 * store snapshot (a rebuild needs both the truth and the target).
 */
export async function listRebuildableSkus(): Promise<{
  ok: boolean;
  error?: string;
  skus: string[];
  catalogOnly: number; // known to a source but not on the store — not rebuildable
}> {
  try {
    const { getActiveConfig } = await import("@/server/config/repo");
    const { listCatalogEntries } = await import("@/server/catalog/repo");
    const { getActiveSnapshot } = await import("@/server/store-json/repo");
    const { activeFeedSkus, GS_FEED } = await import("@/server/feeds/repo");
    const { skuKey } = await import("@/lib/skus");

    const config = await getActiveConfig();
    const entries = await listCatalogEntries(config.source.market);
    const gsSkus = await activeFeedSkus(GS_FEED);
    const known = new Set<string>([...entries.map((e) => skuKey(e.sku)), ...gsSkus]);
    const snapshot = await getActiveSnapshot();
    const storeSkus = new Set(
      (snapshot?.products ?? []).map((p) => (p.sku ? skuKey(p.sku) : "")).filter(Boolean),
    );
    const skus = [...known].filter((s) => storeSkus.has(s));
    return { ok: true, skus, catalogOnly: known.size - skus.length };
  } catch (e) {
    return { ok: false, error: errMessage(e), skus: [], catalogOnly: 0 };
  }
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
      feedProductIds: parsed.data.feedProductIds,
      backfillGtins: parsed.data.backfillGtins,
      planIds: parsed.data.planIds,
    });
    return { ok: true, outcome };
  } catch (e) {
    return { ok: false, error: errMessage(e) };
  }
}
