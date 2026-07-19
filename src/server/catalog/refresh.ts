import "server-only";
import type { SourceProduct } from "@core/core-spine";
import type { SourceLike } from "@/server/kicks/service";
import { skuKey } from "@/lib/skus";
import { getAnyBySkus, listStaleSkus, upsertCatalog } from "./repo";

/**
 * The built-in "KicksDB refresh" feed: re-price the stalest catalog entries.
 *
 * Prices come from the bulk endpoint (50 SKUs/call — cheap), which carries no
 * title/brand/image, so fetched variants are MERGED onto the stored product
 * rather than replacing it: identity fields stay, offers/sizes refresh, and
 * upsertCatalog recomputes the denormalized discovery columns. The catalog
 * invariant holds — a SKU the batch didn't return is left untouched (still
 * stale), never removed.
 */
export interface RefreshOutcome {
  requested: number; // stale SKUs attempted this round
  refreshed: number; // entries actually re-priced
  missed: number; // stale SKUs the bulk call did not return
}

export async function refreshStaleCatalog(
  source: SourceLike,
  market: string,
  ttlSeconds: number,
  limit = 100,
): Promise<RefreshOutcome> {
  const stale = await listStaleSkus(market, ttlSeconds, limit);
  if (stale.length === 0) return { requested: 0, refreshed: 0, missed: 0 };

  const existing = await getAnyBySkus(market, stale);
  const byStockxId = new Map<string, SourceProduct>();
  for (const p of existing.values()) byStockxId.set(p.stockxId, p);

  const fetched = await source.getPricesBatch(stale, market);
  const merged: SourceProduct[] = [];
  for (const f of fetched) {
    const current =
      (f.sku ? existing.get(skuKey(f.sku)) : undefined) ?? byStockxId.get(f.stockxId);
    if (!current) continue; // not ours — ignore rather than inserting a headless entry
    merged.push({
      ...current,
      variants: f.variants,
      currency: f.currency || current.currency,
    });
  }

  await upsertCatalog(market, merged);
  return { requested: stale.length, refreshed: merged.length, missed: stale.length - merged.length };
}
