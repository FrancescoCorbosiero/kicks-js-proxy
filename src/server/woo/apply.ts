import "server-only";
import { desc, eq } from "drizzle-orm";
import { db } from "@/server/db/client";
import { applyAudit, type ApplyAuditRow } from "@/server/db/schema";
import { getPlansByIds, planRunIds, planRunScope } from "@/server/plans/repo";
import { getActiveConfig } from "@/server/config/repo";
import { getActiveSnapshot, getSnapshotInfo, saveSnapshot } from "@/server/store-json/repo";
import { planProductSanitize, type ProductSanitizeOps } from "@/server/store-json/sanitize-plan";
import { planFeedTakeover } from "@/server/store-json/takeover-plan";
import { gsOwnedProducts } from "@/server/feeds/owner";
import { getOverrides } from "@/server/overrides/repo";
import type { StoreModel } from "@/server/store-json/model";
import { chunk } from "@/server/adapters/http";
import { skuKey } from "@/lib/skus";
import { normalizeGtin } from "@/lib/gtin";
import { getWooClient } from "./client";

/**
 * The REST sync apply — "patch prices AND sizes":
 *
 *  1. CLEANUP first (when enabled, the default): for every previewed product,
 *     plan the pa_taglia alignment with the shared sanitize engine — DELETE
 *     orphan/duplicate variations Woo would never show, rewrite survivors
 *     (realigned pa_taglia, made-available zero-stock sizes KicksDB carries),
 *     and PUT the parent's realigned option list.
 *  2. PRICES second: the selected plan rows, written per parent product via
 *     variations/batch. A price aimed at a variation the cleanup deletes is
 *     dropped (its surviving twin carries its own row).
 *
 * Dry-run is the default posture — it computes and records the exact writes
 * and deletions without touching the store. Every run lands in apply_audit.
 * After a live run, the stored snapshot is patched to the post-apply state for
 * every product that fully succeeded, so the next preview reflects reality
 * without a re-pull.
 */

export interface ApplySelection {
  planId: string;
  variantIds: string[];
}

export interface ApplyOptions {
  dryRun: boolean;
  /** Align sizes (delete orphans, realign pa_taglia) before pricing. */
  sanitize: boolean;
  /**
   * The preview run being applied. EVERYTHING the run covers is read from it
   * here: its plan ids, the store products it previewed, the variations its
   * source can price, and which of those products a feed owns.
   *
   * The browser used to send all four back as arrays it had built by walking
   * every plan — which is why it had to be holding every plan, and why a large
   * store could not be synced at all. It now names the run and says only what
   * the operator changed about it.
   */
  runId: string;
  /**
   * Which of the run's "update" rows to write:
   *  - "all": every one, minus `excluded` — what the tab starts in, and the
   *    only mode under which rows past the visible page are written;
   *  - "listed": only the rows in `selections`, for a hand-picked apply.
   */
  priceScope: "all" | "listed";
  /** priceScope "listed": exactly what to write. */
  selections?: ApplySelection[];
  /** priceScope "all": rows the operator unticked on the page they were shown. */
  excluded?: ApplySelection[];
  /**
   * Fill an empty global_unique_id with the source's GTIN, for every variant
   * of every previewed plan — not only the ones selected for a price change.
   * Default on: identifiers are what an external catalog matches an offer on,
   * and a product priced correctly would otherwise never get one.
   */
  backfillGtins?: boolean;
}

export interface ApplyChange {
  sku: string; // parent StockX style code (from the plan)
  sizeLabel: string;
  stockxVariantId: string;
  storeProductId: number;
  storeVariationId: number;
  currentPrice: number | null;
  /** null = stock-only write (e.g. a sold-out feed size zeroing its qty). */
  newPrice: number | null;
  /** Managed quantity to write; null = leave the store's stock untouched. */
  newStock: number | null;
  /**
   * GTIN to stamp into global_unique_id, or null. Only ever set for a
   * variation that has NONE: an identifier already on the store was put there
   * by the operator or another system, and a source is not entitled to
   * overwrite it. This is how products created before the publisher existed
   * (or by hand) become listable on an external catalog at all.
   */
  newGtin: string | null;
}

/** Per-product cleanup, compact for the dry-run panel. */
export interface CleanupDetail {
  storeProductId: number;
  sku: string;
  deletions: number;
  rewrites: number;
  parentRealigned: boolean;
}

export interface CleanupSummary {
  products: number; // products needing cleanup
  deletions: number; // variations removed (ghosts + duplicates + takeover trims)
  ghostsRemoved: number;
  duplicatesRemoved: number;
  stockSynthesized: number;
  taglieRealigned: number;
  parentsRealigned: number;
  /** Out-of-feed variants removed by feed takeovers (subset of deletions). */
  feedTrimmed: number;
}

/**
 * Rows of each detail list the outcome carries back.
 *
 * A whole-store apply plans one change per variation — hundreds of thousands
 * of them on a large shop — and the panel shows a dozen. Sending the rest was
 * a payload that grew with the store for nothing. The counts beside each list
 * are the real totals, so nothing is hidden, only unsent.
 */
const OUTCOME_SAMPLE = 50;

export interface ApplyOutcome {
  auditId: string;
  dryRun: boolean;
  status: ApplyAuditRow["status"];
  products: number; // products touched (cleanup and/or prices)
  variations: number; // price writes planned
  updated: number; // price writes executed
  failed: { stockxVariantId: string; error: string }[]; // sample
  failedTotal: number;
  changes: ApplyChange[]; // sample of the price writes (post-cleanup targets only)
  changesTotal: number;
  droppedByCleanup: number; // price writes aimed at deleted variations
  cleanup: CleanupSummary | null; // null when sanitize was off
  cleanupDetails: CleanupDetail[]; // sample
  cleanupDetailsTotal: number;
  /** Empty global_unique_id fields filled from the source (never overwritten). */
  gtinsWritten: number;
}

async function forEachLimit<T>(items: T[], limit: number, fn: (item: T) => Promise<void>) {
  const queue = [...items];
  const worker = async () => {
    for (let item = queue.shift(); item !== undefined; item = queue.shift()) await fn(item);
  };
  await Promise.all(Array.from({ length: Math.min(limit, queue.length) }, worker));
}

/**
 * Resolve the run into concrete variation writes.
 *
 * Two distinct jobs, one pass over the plans:
 *  - PRICE/STOCK, strictly for the variants the operator selected. Nothing is
 *    ever written here that was not ticked in the preview.
 *  - GTIN back-fill, for every variant of every previewed plan. This one is
 *    deliberately wider: a product whose price is already right produces a
 *    "noop" row that can never be selected, so tying identifiers to the price
 *    selection would leave a correctly-priced catalog permanently unlistable
 *    on Merchant Center. It only ever FILLS AN EMPTY field — an identifier the
 *    store already holds is left exactly as it is — and the dry run shows every
 *    one before anything is written.
 */
async function collectChanges(
  planIds: string[],
  isSelected: (planId: string, variantId: string) => boolean,
  options: {
    gtinByVariation: ReadonlyMap<number, string>;
    backfillGtins: boolean;
  },
): Promise<ApplyChange[]> {
  const { gtinByVariation, backfillGtins } = options;
  const changes: ApplyChange[] = [];

  // Read in chunks. One SELECT per plan meant one database round-trip per
  // product — twenty thousand of them before the first price was written.
  for (const part of chunk(planIds, 200)) {
    const plans = await getPlansByIds(part);
    for (const planId of part) {
      const plan = plans.get(planId);
      if (!plan) continue;
      for (const item of plan.items) {
        const selected = item.action === "update" && isSelected(planId, item.stockxVariantId);
        if (item.storeProductId == null || item.storeVariationId == null) continue;
        // Belt and braces: a plan saved before the id was known would aim at
        // variation 0, which Woo rejects — and which the UI shows as a pile of
        // rows sharing one identity.
        if (item.storeVariationId <= 0) continue;

        const gtin = backfillGtins ? normalizeGtin(item.upc).gtin : null;
        const newGtin =
          gtin && !(gtinByVariation.get(item.storeVariationId) ?? "").trim() ? gtin : null;
        // "create" rows need upsertProduct and are out of scope for prices, but
        // they are also not on the store, so they carry no identifier either.
        const writesPrice = selected && (item.proposedPrice != null || item.stockQuantity != null);
        if (!writesPrice && newGtin == null) continue;

        changes.push({
          sku: plan.sku,
          sizeLabel: item.sizeLabel,
          stockxVariantId: item.stockxVariantId,
          storeProductId: item.storeProductId,
          storeVariationId: item.storeVariationId,
          currentPrice: item.currentPrice,
          newPrice: writesPrice ? item.proposedPrice : null,
          newStock: writesPrice ? (item.stockQuantity ?? null) : null,
          newGtin,
        });
      }
    }
  }
  return changes;
}

/**
 * What the apply is allowed to write, resolved from the RUN rather than from
 * the browser.
 *
 * "all" is the posture the tab starts in: every update row the run produced,
 * minus the ones the operator unticked among those actually shown. That is
 * what makes a store larger than one page syncable at all — the rows past the
 * page were never unticked, so they are written, exactly as they would have
 * been when the browser still received every one of them.
 */
async function resolveSelection(
  options: ApplyOptions,
): Promise<{ planIds: string[]; isSelected: (planId: string, variantId: string) => boolean }> {
  const backfill = options.backfillGtins !== false;

  if (options.priceScope === "listed") {
    const listed = new Map(
      (options.selections ?? []).map((s) => [s.planId, new Set(s.variantIds)]),
    );
    // The back-fill is deliberately wider than the price selection, so it needs
    // the whole run even when the prices are a hand-picked few.
    const planIds = backfill ? await planRunIds(options.runId) : [...listed.keys()];
    return { planIds, isSelected: (p, v) => listed.get(p)?.has(v) ?? false };
  }

  const excluded = new Map(
    (options.excluded ?? []).map((s) => [s.planId, new Set(s.variantIds)]),
  );
  return {
    planIds: await planRunIds(options.runId),
    isSelected: (p, v) => !excluded.get(p)?.has(v),
  };
}

function summarizeCleanup(ops: ProductSanitizeOps[]): CleanupSummary {
  const s: CleanupSummary = {
    products: ops.length,
    deletions: 0,
    ghostsRemoved: 0,
    duplicatesRemoved: 0,
    stockSynthesized: 0,
    taglieRealigned: 0,
    parentsRealigned: 0,
    feedTrimmed: 0,
  };
  for (const o of ops) {
    s.deletions += o.deleteVariationIds.length;
    s.duplicatesRemoved += o.counts.duplicatesRemoved;
    s.stockSynthesized += o.counts.stockSynthesized;
    s.taglieRealigned += o.counts.taglieRealigned;
    if (o.counts.parentRealigned) s.parentsRealigned += 1;
    // Takeover planners report out-of-feed trims via ghostsRemoved — split
    // them out so the dry-run never mislabels a takeover as a ghost purge.
    if (o.takeover) s.feedTrimmed += o.counts.ghostsRemoved;
    else s.ghostsRemoved += o.counts.ghostsRemoved;
  }
  return s;
}

export async function applySync(options: ApplyOptions): Promise<ApplyOutcome> {
  // Read regardless of `sanitize`: the cleanup needs it, and so does the GTIN
  // back-fill (which must know what the store already holds).
  const snapshot = await getActiveSnapshot().catch(() => null);

  // The run's own scope, read in SQL. These three sets used to arrive from the
  // browser, which could only build them while it held every plan.
  const scope = await planRunScope(options.runId);

  // 1. Plan the cleanup over the previewed products. Two regimes:
  //    - KicksDB-owned: the classic sanitize (ghosts, duplicates, pa_taglia).
  //    - Feed-owned: the TAKEOVER — delete variants whose size the feed has
  //      never listed (KicksDB-era leftovers keep selling otherwise), keep
  //      feed-known sizes (their qty is written by the stock sync), realign
  //      pa_taglia. The KicksDB ghost/make-available rules never apply here.
  const previewed = new Set(scope.previewedProductIds);
  const feedOwned = new Set(scope.feedProductIds);
  const keepAvailable = new Set(scope.kicksdbVariationIds);
  const cleanupOps: ProductSanitizeOps[] = [];
  if (options.sanitize && snapshot) {
    const feedSkus = snapshot.products
      .filter((p) => feedOwned.has(p.id) && p.sku)
      .map((p) => p.sku);
    const owned =
      feedSkus.length > 0
        ? await gsOwnedProducts(feedSkus, "", await getOverrides().catch(() => null))
        : new Map<string, never>();

    for (const product of snapshot.products) {
      if (previewed.size > 0 && !previewed.has(product.id)) continue;
      if (feedOwned.has(product.id)) {
        const gs = product.sku ? owned.get(skuKey(product.sku)) : undefined;
        if (!gs) continue; // ownership lapsed between preview and apply — skip
        const ops = planFeedTakeover(product, gs.knownSizes);
        if (ops) cleanupOps.push(ops);
        continue;
      }
      const ops = planProductSanitize(product, keepAvailable);
      if (ops) cleanupOps.push(ops);
    }
  }
  const opsByProduct = new Map(cleanupOps.map((o) => [o.storeProductId, o]));
  const deletedIds = new Set(cleanupOps.flatMap((o) => o.deleteVariationIds));

  // 2. Collect price writes; drop the ones aimed at variations being deleted.
  const gtinByVariation = new Map<number, string>();
  for (const product of snapshot?.products ?? []) {
    for (const v of product.variations) {
      if (v.global_unique_id) gtinByVariation.set(v.id, String(v.global_unique_id));
    }
  }
  const { planIds, isSelected } = await resolveSelection(options);
  const allChanges = await collectChanges(planIds, isSelected, {
    gtinByVariation,
    backfillGtins: options.backfillGtins !== false,
  });
  const changes = allChanges.filter((c) => !deletedIds.has(c.storeVariationId));
  const droppedByCleanup = allChanges.length - changes.length;

  const priceByProduct = new Map<number, ApplyChange[]>();
  for (const c of changes) {
    const list = priceByProduct.get(c.storeProductId) ?? [];
    list.push(c);
    priceByProduct.set(c.storeProductId, list);
  }

  const productIds = [...new Set([...opsByProduct.keys(), ...priceByProduct.keys()])];
  const cleanup = options.sanitize ? summarizeCleanup(cleanupOps) : null;
  const cleanupDetails = cleanupOps.map<CleanupDetail>((o) => ({
    storeProductId: o.storeProductId,
    sku: o.sku,
    deletions: o.deleteVariationIds.length,
    rewrites: o.variationWrites.length,
    parentRealigned: o.parentAttributes != null,
  }));

  const [audit] = await db
    .insert(applyAudit)
    .values({
      status: options.dryRun ? "dry_run" : "running",
      dryRun: options.dryRun,
      result: {
        products: productIds.length,
        variations: changes.length,
        droppedByCleanup,
        cleanup: cleanup as unknown as Record<string, unknown> | null,
      },
    })
    .returning({ id: applyAudit.id });

  if (options.dryRun) {
    await db.update(applyAudit).set({ finishedAt: new Date() }).where(eq(applyAudit.id, audit.id));
    return {
      auditId: audit.id,
      dryRun: true,
      status: "dry_run",
      products: productIds.length,
      variations: changes.length,
      updated: 0,
      failed: [],
      failedTotal: 0,
      changes: changes.slice(0, OUTCOME_SAMPLE),
      changesTotal: changes.length,
      droppedByCleanup,
      cleanup,
      cleanupDetails: cleanupDetails.slice(0, OUTCOME_SAMPLE),
      cleanupDetailsTotal: cleanupDetails.length,
      gtinsWritten: changes.filter((c) => c.newGtin).length,
    };
  }

  // 3. Execute, per parent product: parent PUT → variations batch (writes + deletes).
  const config = await getActiveConfig();
  const client = getWooClient();
  const concurrency = Math.max(1, config.apply.concurrency ?? 3);
  const batchSize = Math.max(1, Math.min(config.apply.wooBatchSize ?? 100, 100));

  let updated = 0;
  const failed: { stockxVariantId: string; error: string }[] = [];
  const succeeded = new Set<number>();

  await forEachLimit(productIds, concurrency, async (productId) => {
    const ops = opsByProduct.get(productId);
    const prices = priceByProduct.get(productId) ?? [];
    try {
      if (ops?.parentAttributes != null) {
        await client.updateProduct(productId, { attributes: ops.parentAttributes });
      }

      // Merge cleanup rewrites, price writes and stock writes into one update
      // row per variation.
      const merged = new Map<number, Record<string, unknown>>();
      for (const w of ops?.variationWrites ?? []) merged.set(w.id, { ...w });
      for (const c of prices) {
        const row = merged.get(c.storeVariationId) ?? { id: c.storeVariationId };
        if (c.newPrice != null) row.regular_price = c.newPrice.toFixed(2);
        if (c.newStock != null) {
          // Finite feed supply: managed count, sold-out stays visible as such.
          row.manage_stock = true;
          row.stock_quantity = c.newStock;
          row.stock_status = c.newStock > 0 ? "instock" : "outofstock";
        }
        if (c.newGtin) row.global_unique_id = c.newGtin;
        merged.set(c.storeVariationId, row);
      }

      const updateChunks = chunk([...merged.values()], batchSize);
      const deleteChunks = chunk(ops?.deleteVariationIds ?? [], batchSize);
      const rounds = Math.max(updateChunks.length, deleteChunks.length);
      for (let i = 0; i < rounds; i++) {
        await client.batchVariations(productId, {
          update: updateChunks[i],
          delete: deleteChunks[i],
        });
      }

      updated += prices.length;
      succeeded.add(productId);
    } catch (e) {
      const message = e instanceof Error ? e.message : String(e);
      if (prices.length > 0) {
        for (const c of prices) failed.push({ stockxVariantId: c.stockxVariantId, error: message });
      } else {
        failed.push({ stockxVariantId: `product:${productId}`, error: message });
      }
    }
  });

  // 4. Patch the stored snapshot to the post-apply state of succeeded products,
  //    so the next preview reflects reality without a full re-pull.
  if (succeeded.size > 0) {
    try {
      // A price-only run (sanitize off) never loaded the snapshot — load it now.
      const model = snapshot ?? (await getActiveSnapshot());
      if (model) {
        patchSnapshot(model, succeeded, opsByProduct, priceByProduct);
        const info = await getSnapshotInfo();
        await saveSnapshot(model, info?.source ?? "rest");
      }
    } catch (e) {
      console.warn("[sync] snapshot patch skipped:", e instanceof Error ? e.message : String(e));
    }
  }

  const status: ApplyAuditRow["status"] =
    failed.length === 0 ? "applied" : succeeded.size > 0 ? "partial" : "failed";
  await db
    .update(applyAudit)
    .set({ status, updatedCount: updated, failed, finishedAt: new Date() })
    .where(eq(applyAudit.id, audit.id));

  return {
    auditId: audit.id,
    dryRun: false,
    status,
    products: productIds.length,
    variations: changes.length,
    updated,
    failed: failed.slice(0, OUTCOME_SAMPLE),
    failedTotal: failed.length,
    changes: changes.slice(0, OUTCOME_SAMPLE),
    changesTotal: changes.length,
    droppedByCleanup,
    cleanup,
    cleanupDetails: cleanupDetails.slice(0, OUTCOME_SAMPLE),
    cleanupDetailsTotal: cleanupDetails.length,
    gtinsWritten: changes.filter((c) => c.newGtin).length,
  };
}

/** Mutate the model to the post-apply state of the products that succeeded. */
function patchSnapshot(
  model: StoreModel,
  succeeded: ReadonlySet<number>,
  opsByProduct: ReadonlyMap<number, ProductSanitizeOps>,
  priceByProduct: ReadonlyMap<number, ApplyChange[]>,
): void {
  model.products = model.products.map((p) => {
    if (!succeeded.has(p.id)) return p;
    const next = opsByProduct.get(p.id)?.sanitized ?? p;
    for (const c of priceByProduct.get(p.id) ?? []) {
      const vrt = next.variations.find((v) => v.id === c.storeVariationId);
      if (!vrt) continue;
      if (c.newPrice != null) vrt.regular_price = c.newPrice.toFixed(2);
      if (c.newStock != null) {
        vrt.manage_stock = true;
        vrt.stock_quantity = c.newStock;
        vrt.stock_status = c.newStock > 0 ? "instock" : "outofstock";
      }
    }
    return next;
  });
}

export interface ApplyHistoryEntry {
  id: string;
  status: ApplyAuditRow["status"];
  dryRun: boolean;
  updatedCount: number;
  failedCount: number;
  requestedVariations: number | null;
  cleanupDeletions: number | null;
  startedAt: string;
  finishedAt: string | null;
}

/** Recent apply runs (dry + live), newest first — the sync history panel. */
export async function listApplyHistory(limit = 10): Promise<ApplyHistoryEntry[]> {
  const rows = await db
    .select()
    .from(applyAudit)
    .orderBy(desc(applyAudit.startedAt))
    .limit(limit);
  return rows.map((r) => {
    const result = (r.result ?? {}) as {
      variations?: unknown;
      cleanup?: { deletions?: unknown } | null;
    };
    return {
      id: r.id,
      status: r.status,
      dryRun: r.dryRun,
      updatedCount: r.updatedCount,
      failedCount: Array.isArray(r.failed) ? r.failed.length : 0,
      requestedVariations: typeof result.variations === "number" ? result.variations : null,
      cleanupDeletions:
        typeof result.cleanup?.deletions === "number" ? result.cleanup.deletions : null,
      startedAt: r.startedAt.toISOString(),
      finishedAt: r.finishedAt?.toISOString() ?? null,
    };
  });
}
