import "server-only";
import { getActiveConfig } from "@/server/config/repo";
import { getSource } from "@/server/adapters/kicksdb";
import { skuKey } from "@/lib/skus";
import { listSkusMissingMetadata, touchCatalogSkus, upsertCatalog } from "./repo";

/**
 * Metadata backfill: rows imported before the schema learned category/gender/
 * model/gallery have no metadata (category = ''). Re-fetching a SKU through
 * GET /stockx/products returns the full product — metadata AND fresh variants —
 * so one upsert enriches the row and re-prices it in the same pass. The daily
 * scheduler drains this queue in bounded batches; new imports come enriched
 * from day one, so the queue only ever shrinks (except for SKUs whose metadata
 * KicksDB genuinely lacks — those rotate to the back via fetchedAt and retry
 * on later days).
 */
export interface EnrichOutcome {
  scanned: number; // queue rows attempted this run
  enriched: number; // rows re-written with a full product
  missed: number; // fetch failed / no exact-SKU match — rotated to the back
}

const CONCURRENCY = 4;

export async function backfillCatalogMetadata(limit: number): Promise<EnrichOutcome> {
  const config = await getActiveConfig();
  const market = config.source.market;

  const queue = await listSkusMissingMetadata(market, limit);
  if (queue.length === 0) return { scanned: 0, enriched: 0, missed: 0 };

  const source = getSource(config);
  const fetched: import("@core/core-spine").SourceProduct[] = [];
  const missed: string[] = [];

  const pending = [...queue];
  const worker = async () => {
    for (let sku = pending.shift(); sku !== undefined; sku = pending.shift()) {
      try {
        const list = await source.getProduct(sku, market);
        const product = list.find((p) => skuKey(p.sku) === skuKey(sku));
        if (product) fetched.push(product);
        else missed.push(sku);
      } catch {
        missed.push(sku);
      }
    }
  };
  await Promise.all(Array.from({ length: Math.min(CONCURRENCY, queue.length) }, worker));

  await upsertCatalog(market, fetched);
  await touchCatalogSkus(market, missed); // rotate failures to the back of the queue

  return { scanned: queue.length, enriched: fetched.length, missed: missed.length };
}
