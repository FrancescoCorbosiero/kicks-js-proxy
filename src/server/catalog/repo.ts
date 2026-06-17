import "server-only";
import { and, eq, gte, inArray, sql } from "drizzle-orm";
import type { SourceProduct } from "@core/core-spine";
import { db } from "@/server/db/client";
import { catalogProducts } from "@/server/db/schema";
import { skuKey } from "@/lib/skus";

/**
 * Return catalog entries for the given SKUs that are still FRESH (fetched within
 * ttlSeconds), keyed by canonical SKU. Stale or missing SKUs are simply absent,
 * so the caller refetches and upserts them.
 */
export async function getFreshBySkus(
  market: string,
  skus: string[],
  ttlSeconds: number,
): Promise<Map<string, SourceProduct>> {
  const out = new Map<string, SourceProduct>();
  if (skus.length === 0) return out;

  const keys = skus.map(skuKey);
  const threshold = new Date(Date.now() - ttlSeconds * 1000);

  const rows = await db
    .select()
    .from(catalogProducts)
    .where(
      and(
        eq(catalogProducts.market, market),
        inArray(catalogProducts.sku, keys),
        gte(catalogProducts.fetchedAt, threshold),
      ),
    );

  for (const r of rows) out.set(r.sku, r.data);
  return out;
}

/** Upsert (insert-or-refresh) the products that were just fetched from KicksDB. */
export async function upsertCatalog(market: string, products: SourceProduct[]): Promise<void> {
  if (products.length === 0) return;

  const now = new Date();
  const values = products.map((p) => ({
    market,
    sku: skuKey(p.sku),
    stockxId: p.stockxId,
    title: p.title,
    brand: p.brand,
    data: p,
    fetchedAt: now,
    updatedAt: now,
  }));

  await db
    .insert(catalogProducts)
    .values(values)
    .onConflictDoUpdate({
      target: [catalogProducts.market, catalogProducts.sku],
      set: {
        stockxId: sql`excluded.stockx_id`,
        title: sql`excluded.title`,
        brand: sql`excluded.brand`,
        data: sql`excluded.data`,
        fetchedAt: sql`excluded.fetched_at`,
        updatedAt: sql`excluded.updated_at`,
      },
    });
}
