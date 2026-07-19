import type { SourcePort, SourceProduct } from "@core/core-spine";
import type { Cache } from "@/server/cache/memory";

/** Just the read methods we need — lets tests pass a fake source. */
export type SourceLike = Pick<SourcePort, "getPricesBatch" | "getProduct">;

export interface FetchResult {
  products: SourceProduct[];
  fromCache: number; // count of requested keys served from cache
  fetched: number; // count of requested keys that hit the API
}

const queryKey = (market: string, query: string) =>
  `kicks:query:${market}:${query.trim().toLowerCase()}`;

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
