import type { SourceProduct } from "@core/core-spine";
import { skuKey } from "@/lib/skus";
import type { SourceLike } from "@/server/kicks/service";

/** The persistence seam the catalog service needs — lets tests pass a fake. */
export interface CatalogStore {
  getFresh(market: string, skus: string[], ttlSeconds: number): Promise<Map<string, SourceProduct>>;
  upsert(market: string, products: SourceProduct[]): Promise<void>;
}

export interface SkuResolveResult {
  products: SourceProduct[];
  fromCache: number; // SKUs served from the fresh catalog
  fetched: number; // SKUs fetched live from KicksDB
  notFound: string[]; // SKUs with no matching StockX product
}

/** Fetch one product by exact SKU via the (working) products endpoint. */
async function fetchProductBySku(
  source: SourceLike,
  sku: string,
  market: string,
): Promise<SourceProduct | null> {
  const list = await source.getProduct(sku, market);
  return list.find((p) => skuKey(p.sku) === skuKey(sku)) ?? null;
}

/**
 * Resolve a set of SKUs to products, smart-caching through the persistent
 * catalog: fresh hits come from the DB; misses are fetched from KicksDB and
 * upserted so the next lookup is free until the TTL lapses. SKUs that don't
 * resolve to a StockX product are reported in `notFound`.
 */
export async function resolveSkusViaCatalog(
  source: SourceLike,
  store: CatalogStore,
  skus: string[],
  market: string,
  ttlSeconds: number,
): Promise<SkuResolveResult> {
  // De-duplicate by canonical key while preserving a representative original.
  const byKey = new Map<string, string>();
  for (const s of skus) if (!byKey.has(skuKey(s))) byKey.set(skuKey(s), s);

  const fresh = await store.getFresh(market, [...byKey.values()], ttlSeconds);
  const products: SourceProduct[] = [];
  let fromCache = 0;
  const misses: string[] = [];

  for (const [key, original] of byKey) {
    const hit = fresh.get(key);
    if (hit) {
      products.push(hit);
      fromCache += 1;
    } else {
      misses.push(original);
    }
  }

  const fetchedProducts: SourceProduct[] = [];
  const notFound: string[] = [];
  for (const sku of misses) {
    const product = await fetchProductBySku(source, sku, market);
    if (product) {
      fetchedProducts.push(product);
      products.push(product);
    } else {
      notFound.push(sku);
    }
  }

  await store.upsert(market, fetchedProducts);

  return { products, fromCache, fetched: fetchedProducts.length, notFound };
}
