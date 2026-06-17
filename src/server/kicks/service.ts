import type { SourcePort, SourceProduct } from "@core/core-spine";
import type { Cache } from "@/server/cache/memory";

/** Just the read methods we need — lets tests pass a fake source. */
export type SourceLike = Pick<SourcePort, "getPricesBatch" | "getProduct">;

export interface FetchResult {
  products: SourceProduct[];
  fromCache: number; // count of requested keys served from cache
  fetched: number; // count of requested keys that hit the API
}

const priceKey = (market: string, sku: string) => `kicks:price:${market}:${sku.toUpperCase()}`;
const queryKey = (market: string, query: string) =>
  `kicks:query:${market}:${query.trim().toLowerCase()}`;

/**
 * Fetch prices by SKU with per-SKU caching, so a partly-warm set only hits the
 * API for the missing SKUs. SKUs with no returned product are cached as an empty
 * array (negative cache) so we don't re-query them within the TTL.
 */
export async function fetchPricesCached(
  source: SourceLike,
  cache: Cache,
  skus: string[],
  market: string,
  ttlSeconds: number,
): Promise<FetchResult> {
  const products: SourceProduct[] = [];
  const misses: string[] = [];
  let fromCache = 0;

  for (const sku of skus) {
    const cached = await cache.get<SourceProduct[]>(priceKey(market, sku));
    if (cached !== null) {
      products.push(...cached);
      fromCache += 1;
    } else {
      misses.push(sku);
    }
  }

  if (misses.length > 0) {
    const fetched = await source.getPricesBatch(misses, market);
    const bySku = new Map<string, SourceProduct[]>();
    for (const p of fetched) {
      const k = p.sku.toUpperCase();
      (bySku.get(k) ?? bySku.set(k, []).get(k)!).push(p);
    }
    for (const sku of misses) {
      await cache.set(priceKey(market, sku), bySku.get(sku.toUpperCase()) ?? [], ttlSeconds);
    }
    products.push(...fetched);
  }

  return { products, fromCache, fetched: misses.length };
}

/** Fetch products by query with whole-result caching. */
export async function fetchProductsCached(
  source: SourceLike,
  cache: Cache,
  query: string,
  market: string,
  ttlSeconds: number,
): Promise<FetchResult> {
  const key = queryKey(market, query);
  const cached = await cache.get<SourceProduct[]>(key);
  if (cached !== null) return { products: cached, fromCache: 1, fetched: 0 };

  const products = await source.getProduct(query, market);
  await cache.set(key, products, ttlSeconds);
  return { products, fromCache: 0, fetched: 1 };
}
