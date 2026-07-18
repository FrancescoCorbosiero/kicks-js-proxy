import "server-only";
import { and, eq, gte, ilike, inArray, lt, lte, or, sql, type SQL } from "drizzle-orm";
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

/**
 * List every known-fetchable SKU for a market (the whole catalog), lightest
 * columns only, ordered brand then SKU. Best-effort: a DB error degrades to an
 * empty list rather than failing the page.
 */
export async function listCatalogEntries(
  market: string,
): Promise<{ sku: string; title: string; brand: string }[]> {
  try {
    return await db
      .select({
        sku: catalogProducts.sku,
        title: catalogProducts.title,
        brand: catalogProducts.brand,
      })
      .from(catalogProducts)
      .where(eq(catalogProducts.market, market))
      .orderBy(catalogProducts.brand, catalogProducts.sku);
  } catch (e) {
    console.warn("[catalog] list skipped (cache unavailable):", describeDbError(e));
    return [];
  }
}

/* ------------------------------------------------------------------ */
/* Discovery: server-side filtered / sorted / paginated catalog pages  */
/* ------------------------------------------------------------------ */

export type CatalogSort = "brand" | "title" | "added" | "fetched" | "priceAsc" | "priceDesc";
export type CatalogFreshness = "all" | "fresh" | "stale";

export interface CatalogPageFilters {
  brand?: string;
  q?: string; // substring on SKU / title
  freshness?: CatalogFreshness;
  priceMin?: number;
  priceMax?: number;
  sort?: CatalogSort;
  page?: number; // 1-based
  perPage?: number;
}

export interface CatalogPageItem {
  sku: string;
  title: string;
  brand: string;
  image: string;
  minAsk: number | null;
  variantCount: number;
  addedAt: string; // ISO
  fetchedAt: string; // ISO
  fresh: boolean; // fetchedAt within the TTL
}

export interface CatalogPage {
  items: CatalogPageItem[];
  total: number; // rows matching the filters (not just this page)
  page: number;
  perPage: number;
  pageCount: number;
}

function pageConditions(market: string, f: CatalogPageFilters, threshold: Date): SQL[] {
  const conds: SQL[] = [eq(catalogProducts.market, market)];
  if (f.brand) conds.push(eq(catalogProducts.brand, f.brand));
  if (f.q?.trim()) {
    const like = `%${f.q.trim()}%`;
    conds.push(or(ilike(catalogProducts.sku, like), ilike(catalogProducts.title, like))!);
  }
  if (f.freshness === "fresh") conds.push(gte(catalogProducts.fetchedAt, threshold));
  if (f.freshness === "stale") conds.push(lt(catalogProducts.fetchedAt, threshold));
  if (f.priceMin != null) conds.push(gte(catalogProducts.minAsk, f.priceMin));
  if (f.priceMax != null) conds.push(lte(catalogProducts.minAsk, f.priceMax));
  return conds;
}

function pageOrder(sort: CatalogSort): SQL[] {
  switch (sort) {
    case "title":
      return [sql`${catalogProducts.title} asc`, sql`${catalogProducts.sku} asc`];
    case "added":
      return [sql`${catalogProducts.addedAt} desc`, sql`${catalogProducts.sku} asc`];
    case "fetched":
      return [sql`${catalogProducts.fetchedAt} desc`, sql`${catalogProducts.sku} asc`];
    case "priceAsc":
      return [sql`${catalogProducts.minAsk} asc nulls last`, sql`${catalogProducts.sku} asc`];
    case "priceDesc":
      return [sql`${catalogProducts.minAsk} desc nulls last`, sql`${catalogProducts.sku} asc`];
    case "brand":
    default:
      return [sql`${catalogProducts.brand} asc`, sql`${catalogProducts.sku} asc`];
  }
}

/**
 * One page of the discovery grid, filtered/sorted/paginated in SQL — the
 * catalog is ever-increasing, so the browser never loads the whole set.
 * Best-effort like the rest of the repo: a DB error degrades to an empty page.
 */
export async function listCatalogPage(
  market: string,
  ttlSeconds: number,
  filters: CatalogPageFilters = {},
): Promise<CatalogPage> {
  const perPage = Math.min(Math.max(filters.perPage ?? 24, 1), 96);
  const page = Math.max(filters.page ?? 1, 1);
  const threshold = new Date(Date.now() - ttlSeconds * 1000);
  const where = and(...pageConditions(market, filters, threshold));

  try {
    const [countRows, rows] = await Promise.all([
      db.select({ n: sql<number>`count(*)::int` }).from(catalogProducts).where(where),
      db
        .select({
          sku: catalogProducts.sku,
          title: catalogProducts.title,
          brand: catalogProducts.brand,
          image: catalogProducts.image,
          minAsk: catalogProducts.minAsk,
          variantCount: catalogProducts.variantCount,
          addedAt: catalogProducts.addedAt,
          fetchedAt: catalogProducts.fetchedAt,
        })
        .from(catalogProducts)
        .where(where)
        .orderBy(...pageOrder(filters.sort ?? "brand"))
        .limit(perPage)
        .offset((page - 1) * perPage),
    ]);

    const total = countRows[0]?.n ?? 0;
    return {
      items: rows.map((r) => ({
        sku: r.sku,
        title: r.title,
        brand: r.brand,
        image: r.image,
        minAsk: r.minAsk,
        variantCount: r.variantCount,
        addedAt: r.addedAt.toISOString(),
        fetchedAt: r.fetchedAt.toISOString(),
        fresh: r.fetchedAt >= threshold,
      })),
      total,
      page,
      perPage,
      pageCount: Math.max(1, Math.ceil(total / perPage)),
    };
  } catch (e) {
    console.warn("[catalog] page skipped (cache unavailable):", describeDbError(e));
    return { items: [], total: 0, page: 1, perPage, pageCount: 1 };
  }
}

/** Brands present in a market with per-brand counts (for the discovery sidebar). */
export async function listBrandCounts(
  market: string,
): Promise<{ brand: string; count: number }[]> {
  try {
    const rows = await db
      .select({ brand: catalogProducts.brand, count: sql<number>`count(*)::int` })
      .from(catalogProducts)
      .where(eq(catalogProducts.market, market))
      .groupBy(catalogProducts.brand)
      .orderBy(catalogProducts.brand);
    return rows.filter((r) => r.brand !== "");
  } catch (e) {
    console.warn("[catalog] brands skipped (cache unavailable):", describeDbError(e));
    return [];
  }
}

export interface CatalogEntry {
  sku: string;
  title: string;
  brand: string;
  image: string;
  minAsk: number | null;
  addedAt: string;
  fetchedAt: string;
  product: SourceProduct;
}

/** One full catalog entry (drawer detail), or null when unknown. */
export async function getCatalogEntry(market: string, sku: string): Promise<CatalogEntry | null> {
  try {
    const rows = await db
      .select()
      .from(catalogProducts)
      .where(and(eq(catalogProducts.market, market), eq(catalogProducts.sku, skuKey(sku))))
      .limit(1);
    if (rows.length === 0) return null;
    const r = rows[0];
    return {
      sku: r.sku,
      title: r.title,
      brand: r.brand,
      image: r.image,
      minAsk: r.minAsk,
      addedAt: r.addedAt.toISOString(),
      fetchedAt: r.fetchedAt.toISOString(),
      product: r.data,
    };
  } catch (e) {
    console.warn("[catalog] entry skipped (cache unavailable):", describeDbError(e));
    return null;
  }
}

/** The lowest ask across every variant/offer of a product, or null when unpriced. */
export function minAskOf(p: SourceProduct): number | null {
  let min: number | null = null;
  for (const v of p.variants) {
    for (const o of v.offers) {
      if (o.lowestAsk > 0 && (min == null || o.lowestAsk < min)) min = o.lowestAsk;
    }
  }
  return min;
}

/**
 * Upsert (insert-or-refresh) the products that were just fetched from KicksDB.
 * The denormalized discovery columns (image/minAsk/variantCount) are recomputed
 * on every write; addedAt is only set on first insert (it means "joined the
 * catalog", while fetchedAt means "last refreshed").
 */
export async function upsertCatalog(market: string, products: SourceProduct[]): Promise<void> {
  if (products.length === 0) return;

  const now = new Date();
  const values = products.map((p) => ({
    market,
    sku: skuKey(p.sku),
    stockxId: p.stockxId,
    title: p.title,
    brand: p.brand,
    image: p.image ?? "",
    minAsk: minAskOf(p),
    variantCount: p.variants.length,
    data: p,
    addedAt: now,
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
          image: sql`excluded.image`,
          minAsk: sql`excluded.min_ask`,
          variantCount: sql`excluded.variant_count`,
          data: sql`excluded.data`,
          fetchedAt: sql`excluded.fetched_at`,
          updatedAt: sql`excluded.updated_at`,
          // added_at intentionally NOT updated: it records first insert.
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
