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
 *
 * Best-effort: the catalog is a cache, so a DB error (e.g. the table not yet
 * migrated) degrades to "no cache" rather than failing the whole preview.
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

  try {
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
  } catch (e) {
    console.warn("[catalog] read skipped (cache unavailable):", describeDbError(e));
  }
  return out;
}

/** Load catalog products by SKU regardless of freshness (used by apply). */
export async function getAnyBySkus(
  market: string,
  skus: string[],
): Promise<Map<string, SourceProduct>> {
  const out = new Map<string, SourceProduct>();
  if (skus.length === 0) return out;
  try {
    const rows = await db
      .select()
      .from(catalogProducts)
      .where(and(eq(catalogProducts.market, market), inArray(catalogProducts.sku, skus.map(skuKey))));
    for (const r of rows) out.set(r.sku, r.data);
  } catch (e) {
    console.warn("[catalog] read skipped (cache unavailable):", describeDbError(e));
  }
  return out;
}

/** Total number of unique SKUs known in the catalog for a market (the catalog size). */
export async function countCatalog(market: string): Promise<number> {
  try {
    const rows = await db
      .select({ n: sql<number>`count(*)::int` })
      .from(catalogProducts)
      .where(eq(catalogProducts.market, market));
    return rows[0]?.n ?? 0;
  } catch (e) {
    console.warn("[catalog] count skipped (cache unavailable):", describeDbError(e));
    return 0;
  }
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

  try {
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
  } catch (e) {
    console.warn("[catalog] write skipped (cache unavailable):", describeDbError(e));
  }
}

/** Surface the underlying pg message (drizzle wraps it) for actionable logs. */
function describeDbError(e: unknown): string {
  const cause = (e as { cause?: { message?: string } })?.cause;
  if (cause?.message) return cause.message;
  return e instanceof Error ? e.message : String(e);
}
