import type { SourceProduct } from "@core/core-spine";
import { skuKey } from "@/lib/skus";
import type { SourceLike } from "@/server/kicks/service";

/** The persistence seam the catalog service needs — lets tests pass a fake. */
export interface CatalogStore {
  getFresh(market: string, skus: string[], ttlSeconds: number): Promise<Map<string, SourceProduct>>;
  /** Catalog entries regardless of freshness — used to skip already-known SKUs. */
  getAny(market: string, skus: string[]): Promise<Map<string, SourceProduct>>;
  upsert(market: string, products: SourceProduct[]): Promise<void>;
  /** Total unique SKUs in the catalog for a market (the catalog size). */
  count(market: string): Promise<number>;
}

export interface SkuResolveResult {
  products: SourceProduct[];
  fromCache: number; // SKUs served from the fresh catalog
  fetched: number; // SKUs fetched live from KicksDB
  notFound: string[]; // SKUs with no matching StockX product
}

/** Outcome of growing the ever-increasing catalog from a set of SKUs. */
export interface CatalogGrowth {
  total: number; // total unique SKUs in the catalog (this market) after growth
  added: number; // brand-new, GET-verified SKUs inserted this run
  rejected: string[]; // new SKUs that were NOT fetchable on KicksDB (no GET 200 match)
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

/** Run an async task over items with a bounded number of concurrent workers. */
async function forEachLimit<T>(
  items: T[],
  limit: number,
  fn: (item: T) => Promise<void>,
): Promise<void> {
  const queue = [...items];
  const worker = async () => {
    for (let item = queue.shift(); item !== undefined; item = queue.shift()) {
      await fn(item);
    }
  };
  await Promise.all(Array.from({ length: Math.min(limit, queue.length) }, worker));
}

/**
 * Grow the persistent, ever-increasing catalog with brand-new SKUs only.
 *
 * The catalog is unique by (market, sku) and entries are permanent: a SKU
 * already present is left untouched and never removed. Each genuinely new SKU
 * is confirmed against KicksDB with a GET /stockx/products lookup; ONLY SKUs
 * that return a matching product (HTTP 200) are added, so every catalog entry
 * is guaranteed fetchable. SKUs whose GET errors, 404s, or returns no exact
 * match are reported in `rejected` and NOT added. Verification cost is paid
 * once per new SKU — repeat uploads of known SKUs are free.
 */
export async function growCatalogFromSkus(
  source: SourceLike,
  store: CatalogStore,
  skus: string[],
  market: string,
  opts: { concurrency?: number } = {},
): Promise<CatalogGrowth> {
  // De-duplicate by canonical key, keeping a representative original spelling.
  const byKey = new Map<string, string>();
  for (const s of skus) if (s && !byKey.has(skuKey(s))) byKey.set(skuKey(s), s);

  // Skip SKUs already in the permanent catalog — they stay regardless of TTL.
  const known = await store.getAny(market, [...byKey.values()]);
  const candidates = [...byKey]
    .filter(([key]) => !known.has(key))
    .map(([, original]) => original);

  const verified: SourceProduct[] = [];
  const rejected: string[] = [];

  await forEachLimit(candidates, opts.concurrency ?? 6, async (sku) => {
    try {
      const product = await fetchProductBySku(source, sku, market);
      if (product) verified.push(product);
      else rejected.push(sku); // 200 but no exact-SKU match
    } catch {
      rejected.push(sku); // non-200 / network — treat as not fetchable
    }
  });

  await store.upsert(market, verified);

  return { total: await store.count(market), added: verified.length, rejected };
}
