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
  notFound: string[]; // SKUs StockX genuinely has no product for
  failed: SkuFailure[]; // SKUs KicksDB could not answer for — worth retrying
}

/** A SKU whose lookup errored out. Not a verdict on the SKU — on the request. */
export interface SkuFailure {
  sku: string;
  error: string;
}

/** Outcome of growing the ever-increasing catalog from a set of SKUs. */
export interface CatalogGrowth {
  total: number; // total unique SKUs in the catalog (this market) after growth
  added: number; // brand-new, GET-verified SKUs inserted this run
  rejected: string[]; // new SKUs StockX has no product for (a real answer: "no")
  failed: SkuFailure[]; // new SKUs whose lookup errored (429/5xx/timeout) — retry
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

  // Fetch misses with the same bounded concurrency growth uses, so a large,
  // cold manual SKU list resolves in parallel instead of one-by-one.
  const fetchedProducts: SourceProduct[] = [];
  const notFound: string[] = [];
  const failed: SkuFailure[] = [];
  await forEachLimit(misses, 6, async (sku) => {
    try {
      const product = await source.findBySku(sku, market);
      if (product) {
        fetchedProducts.push(product);
        products.push(product);
      } else {
        notFound.push(sku);
      }
    } catch (e) {
      // One rate-limited SKU used to abort the whole preview. It is now its
      // own line in the report; every other SKU still resolves.
      failed.push({ sku, error: errorText(e) });
    }
  });

  await store.upsert(market, fetchedProducts);

  return { products, fromCache, fetched: fetchedProducts.length, notFound, failed };
}

/** Readable one-liner for an unknown thrown value. */
function errorText(e: unknown): string {
  const message = e instanceof Error ? e.message : String(e);
  return message.length > 200 ? `${message.slice(0, 200)}…` : message;
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
 * is confirmed against KicksDB with an exact-SKU lookup; ONLY SKUs that
 * resolve to a matching product are added, so every catalog entry is
 * guaranteed fetchable. Verification cost is paid once per new SKU — repeat
 * uploads of known SKUs are free.
 *
 * The two ways a SKU can fail to join are reported apart, because the operator
 * does different things about them: `rejected` means KicksDB answered and has
 * no such product (re-importing changes nothing), `failed` means KicksDB never
 * answered — a 429, a timeout, a 5xx (re-importing is exactly the fix). Folding
 * both into one list is what made a rate-limited import look like twelve dead
 * style codes.
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
  const failed: SkuFailure[] = [];

  await forEachLimit(candidates, opts.concurrency ?? 6, async (sku) => {
    try {
      const product = await source.findBySku(sku, market);
      if (product) verified.push(product);
      else rejected.push(sku); // KicksDB answered: no such product
    } catch (e) {
      failed.push({ sku, error: errorText(e) }); // KicksDB did not answer
    }
  });

  await store.upsert(market, verified);

  return { total: await store.count(market), added: verified.length, rejected, failed };
}
