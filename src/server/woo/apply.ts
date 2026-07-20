import "server-only";
import { desc, eq } from "drizzle-orm";
import { db } from "@/server/db/client";
import { applyAudit, type ApplyAuditRow } from "@/server/db/schema";
import { getPlanById } from "@/server/plans/repo";
import { getActiveConfig } from "@/server/config/repo";
import { getActiveSnapshot, getSnapshotInfo, saveSnapshot } from "@/server/store-json/repo";
import { planProductSanitize, type ProductSanitizeOps } from "@/server/store-json/sanitize-plan";
import type { StoreModel } from "@/server/store-json/model";
import { chunk } from "@/server/adapters/http";
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
  /** Store variation ids priceable on KicksDB — zero-stock ones are kept + made available. */
  kicksdbVariationIds: number[];
  /** Store product ids in the preview — cleanup never touches products outside it. */
  previewedProductIds: number[];
  /**
   * Store product ids owned by a finite-stock FEED (e.g. GoldenSneakers).
   * The KicksDB-semantics cleanup must NOT touch them: its ghost rule would
   * delete legitimately sold-out sizes and its make-available rule would turn
   * 1-pair sizes into unmanaged sell-on-demand. Their standardization path is
   * the rebuild, which writes real managed stock.
   */
  feedProductIds?: number[];
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
  deletions: number; // variations removed (ghosts + duplicates)
  ghostsRemoved: number;
  duplicatesRemoved: number;
  stockSynthesized: number;
  taglieRealigned: number;
  parentsRealigned: number;
}

export interface ApplyOutcome {
  auditId: string;
  dryRun: boolean;
  status: ApplyAuditRow["status"];
  products: number; // products touched (cleanup and/or prices)
  variations: number; // price writes planned
  updated: number; // price writes executed
  failed: { stockxVariantId: string; error: string }[];
  changes: ApplyChange[]; // price writes (post-cleanup targets only)
  droppedByCleanup: number; // price writes aimed at deleted variations
  cleanup: CleanupSummary | null; // null when sanitize was off
  cleanupDetails: CleanupDetail[];
}

async function forEachLimit<T>(items: T[], limit: number, fn: (item: T) => Promise<void>) {
  const queue = [...items];
  const worker = async () => {
    for (let item = queue.shift(); item !== undefined; item = queue.shift()) await fn(item);
  };
  await Promise.all(Array.from({ length: Math.min(limit, queue.length) }, worker));
}

/** Resolve the selections into concrete price writes (update rows only). */
async function collectChanges(selections: ApplySelection[]): Promise<ApplyChange[]> {
  const changes: ApplyChange[] = [];
  for (const sel of selections) {
    const plan = await getPlanById(sel.planId);
    if (!plan) continue;
    const wanted = new Set(sel.variantIds);
    for (const item of plan.items) {
      if (!wanted.has(item.stockxVariantId)) continue;
      if (item.action !== "update") continue; // "create" needs upsertProduct — out of scope
      if (item.storeProductId == null || item.storeVariationId == null) continue;
      if (item.proposedPrice == null && item.stockQuantity == null) continue;
      changes.push({
        sku: plan.sku,
        sizeLabel: item.sizeLabel,
        stockxVariantId: item.stockxVariantId,
        storeProductId: item.storeProductId,
        storeVariationId: item.storeVariationId,
        currentPrice: item.currentPrice,
        newPrice: item.proposedPrice,
        newStock: item.stockQuantity ?? null,
      });
    }
  }
  return changes;
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
  };
  for (const o of ops) {
    s.deletions += o.deleteVariationIds.length;
    s.ghostsRemoved += o.counts.ghostsRemoved;
    s.duplicatesRemoved += o.counts.duplicatesRemoved;
    s.stockSynthesized += o.counts.stockSynthesized;
    s.taglieRealigned += o.counts.taglieRealigned;
    if (o.counts.parentRealigned) s.parentsRealigned += 1;
  }
  return s;
}

export async function applySync(
  selections: ApplySelection[],
  options: ApplyOptions,
): Promise<ApplyOutcome> {
  const snapshot = options.sanitize ? await getActiveSnapshot() : null;

  // 1. Plan the cleanup over the previewed products — feed-owned ones are
  //    excluded: their stock semantics (finite, managed) don't fit the
  //    KicksDB ghost/make-available rules; the rebuild standardizes them.
  const previewed = new Set(options.previewedProductIds);
  const feedOwned = new Set(options.feedProductIds ?? []);
  const keepAvailable = new Set(options.kicksdbVariationIds);
  const cleanupOps: ProductSanitizeOps[] = [];
  if (options.sanitize && snapshot) {
    for (const product of snapshot.products) {
      if (previewed.size > 0 && !previewed.has(product.id)) continue;
      if (feedOwned.has(product.id)) continue;
      const ops = planProductSanitize(product, keepAvailable);
      if (ops) cleanupOps.push(ops);
    }
  }
  const opsByProduct = new Map(cleanupOps.map((o) => [o.storeProductId, o]));
  const deletedIds = new Set(cleanupOps.flatMap((o) => o.deleteVariationIds));

  // 2. Collect price writes; drop the ones aimed at variations being deleted.
  const allChanges = await collectChanges(selections);
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
      changes,
      droppedByCleanup,
      cleanup,
      cleanupDetails,
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
    failed,
    changes,
    droppedByCleanup,
    cleanup,
    cleanupDetails,
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
