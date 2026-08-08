import "server-only";
import { and, eq, gte, ilike, inArray, lt, lte, ne, notInArray, or, sql, type SQL } from "drizzle-orm";
import type { SourceProduct } from "@core/core-spine";
import { db } from "@/server/db/client";
import { catalogProducts } from "@/server/db/schema";
import { skuKey } from "@/lib/skus";
import { chunkArray } from "@/lib/chunk";

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
          // The store mirror is inventory, never a price source: a "woo" row
          // must read as a cache MISS so the normal KicksDB fetch happens
          // (and, when verified, flips the row to kicksdb).
          ne(catalogProducts.source, "woo"),
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
      .where(
        and(
          eq(catalogProducts.market, market),
          inArray(catalogProducts.sku, skus.map(skuKey)),
          // Same as getFreshBySkus: "woo" rows are the store's own mirror —
          // apply/rebuild must never treat them as a source of truth.
          ne(catalogProducts.source, "woo"),
        ),
      );
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
/**
 * Ownership lens: who currently DRIVES the product.
 *  - goldensneakers: the feed covers the SKU (minus manual KicksDB pins);
 *  - woo: store-only inventory (registered from the snapshot, no feed linked);
 *  - kicksdb: everything else — StockX-priced.
 */
export type CatalogOwnerFilter = "all" | "kicksdb" | "goldensneakers" | "woo";

/** URL token for the empty-string category/gender bucket (rows without metadata). */
export const UNCATEGORIZED = "none";

export interface CatalogPageFilters {
  brand?: string;
  /** Category filter; the UNCATEGORIZED token selects rows with no metadata. */
  category?: string;
  secondaryCategory?: string;
  gender?: string;
  q?: string; // substring on SKU / title
  freshness?: CatalogFreshness;
  owner?: CatalogOwnerFilter;
  /** SKUs manually pinned back to KicksDB — excluded from GS ownership. */
  pinnedToKicksdb?: string[];
  priceMin?: number;
  priceMax?: number;
  sort?: CatalogSort;
  page?: number; // 1-based
  perPage?: number;
}

/**
 * True when GoldenSneakers effectively owns this catalog SKU. Mirrors
 * gsOwnedProducts (src/server/feeds/owner.ts): at least one ACTIVE row, and at
 * least one row with a sellable presented price (the priced row may be a
 * deactivated size — the variant set includes those at qty 0).
 */
const GS_COVERED_SQL = sql<boolean>`(exists (
  select 1 from "feed_items" fi
  where fi."feed" = 'goldensneakers' and fi."active" = true and fi."sku" = ${catalogProducts.sku}
) and exists (
  select 1 from "feed_items" fi
  where fi."feed" = 'goldensneakers' and fi."presented_price" > 0 and fi."sku" = ${catalogProducts.sku}
))`;

/**
 * Effective GS ownership for the grid: feed coverage MINUS the SKUs the
 * operator pinned back to KicksDB — the same precedence the sync applies
 * (see src/server/feeds/owner.ts), so the badge never lies about who prices
 * a product.
 */
function gsOwnedSql(pinnedToKicksdb: string[]): SQL<boolean> {
  if (pinnedToKicksdb.length === 0) return GS_COVERED_SQL;
  return sql<boolean>`(${GS_COVERED_SQL} and ${notInArray(catalogProducts.sku, pinnedToKicksdb)})`;
}

export interface CatalogPageItem {
  sku: string;
  title: string;
  brand: string;
  source: string; // row provenance: "kicksdb" | feed name
  gsOwned: boolean; // the feed currently DRIVES this product (grid badge)
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
  const gsOwned = gsOwnedSql(f.pinnedToKicksdb ?? []);
  if (f.brand) conds.push(eq(catalogProducts.brand, f.brand));
  if (f.category) {
    conds.push(eq(catalogProducts.category, f.category === UNCATEGORIZED ? "" : f.category));
    // Sub-category only narrows within an explicit category.
    if (f.secondaryCategory) {
      conds.push(eq(catalogProducts.secondaryCategory, f.secondaryCategory));
    }
  }
  if (f.gender) {
    conds.push(eq(catalogProducts.gender, f.gender === UNCATEGORIZED ? "" : f.gender));
  }
  if (f.q?.trim()) {
    const like = `%${f.q.trim()}%`;
    conds.push(or(ilike(catalogProducts.sku, like), ilike(catalogProducts.title, like))!);
  }
  if (f.freshness === "fresh") conds.push(gte(catalogProducts.fetchedAt, threshold));
  if (f.freshness === "stale") conds.push(lt(catalogProducts.fetchedAt, threshold));
  if (f.owner === "goldensneakers") conds.push(sql`${gsOwned}`);
  if (f.owner === "kicksdb")
    conds.push(sql`(not ${gsOwned} and ${ne(catalogProducts.source, "woo")})`);
  if (f.owner === "woo")
    conds.push(sql`(not ${gsOwned} and ${eq(catalogProducts.source, "woo")})`);
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
          source: catalogProducts.source,
          gsOwned: gsOwnedSql(filters.pinnedToKicksdb ?? []),
          image: catalogProducts.image,
          minAsk: catalogProducts.minAsk,
          variantCount: catalogProducts.variantCount,
          addedAt: catalogProducts.addedAt,
          fetchedAt: catalogProducts.fetchedAt,
        })
        .from(catalogProducts)
        .where(where)
        .orderBy(...pageOrder(filters.sort ?? "added"))
        .limit(perPage)
        .offset((page - 1) * perPage),
    ]);

    const total = countRows[0]?.n ?? 0;
    return {
      items: rows.map((r) => ({
        sku: r.sku,
        title: r.title,
        brand: r.brand,
        source: r.source,
        gsOwned: r.gsOwned === true,
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

export interface CatalogOwnerCounts {
  total: number;
  kicksdb: number;
  goldensneakers: number;
  /** Store-only inventory: registered from the Woo snapshot, no feed linked. */
  woo: number;
}

/**
 * How many catalog products each source currently DRIVES (feed coverage minus
 * manual KicksDB pins) — the numbers behind the catalog's provider tabs.
 */
export async function countByOwner(
  market: string,
  pinnedToKicksdb: string[] = [],
): Promise<CatalogOwnerCounts> {
  const gsOwned = gsOwnedSql(pinnedToKicksdb);
  try {
    const rows = await db
      .select({
        total: sql<number>`count(*)::int`,
        goldensneakers: sql<number>`count(*) filter (where ${gsOwned})::int`,
        woo: sql<number>`count(*) filter (where not ${gsOwned} and ${eq(catalogProducts.source, "woo")})::int`,
      })
      .from(catalogProducts)
      .where(eq(catalogProducts.market, market));
    const total = rows[0]?.total ?? 0;
    const goldensneakers = rows[0]?.goldensneakers ?? 0;
    const woo = rows[0]?.woo ?? 0;
    return { total, goldensneakers, woo, kicksdb: total - goldensneakers - woo };
  } catch (e) {
    console.warn("[catalog] owner counts skipped (cache unavailable):", describeDbError(e));
    return { total: 0, kicksdb: 0, goldensneakers: 0, woo: 0 };
  }
}

export interface CategoryCount {
  category: string; // "" = uncategorized (no metadata yet)
  secondaryCategory: string; // "" = none
  count: number;
}

/**
 * Category → sub-category counts for a market (the discovery sidebar tree).
 * Rows without metadata come back under category "" — the Uncategorized bucket.
 */
export async function listCategoryCounts(market: string): Promise<CategoryCount[]> {
  try {
    return await db
      .select({
        category: catalogProducts.category,
        secondaryCategory: catalogProducts.secondaryCategory,
        count: sql<number>`count(*)::int`,
      })
      .from(catalogProducts)
      .where(eq(catalogProducts.market, market))
      .groupBy(catalogProducts.category, catalogProducts.secondaryCategory)
      .orderBy(catalogProducts.category, catalogProducts.secondaryCategory);
  } catch (e) {
    console.warn("[catalog] category counts skipped (cache unavailable):", describeDbError(e));
    return [];
  }
}

/** Gender values present in a market with counts (the discovery chip row). */
export async function listGenderCounts(
  market: string,
): Promise<{ gender: string; count: number }[]> {
  try {
    return await db
      .select({ gender: catalogProducts.gender, count: sql<number>`count(*)::int` })
      .from(catalogProducts)
      .where(eq(catalogProducts.market, market))
      .groupBy(catalogProducts.gender)
      .orderBy(catalogProducts.gender);
  } catch (e) {
    console.warn("[catalog] gender counts skipped (cache unavailable):", describeDbError(e));
    return [];
  }
}

/**
 * KicksDB-sourced SKUs still missing catalog metadata (category = ''), least
 * recently fetched first — the enrichment backfill's queue. Ordering by
 * fetchedAt keeps SKUs whose metadata the API genuinely lacks rotating to the
 * back (each attempt bumps fetchedAt) instead of monopolizing the daily batch.
 */
export async function listSkusMissingMetadata(market: string, limit: number): Promise<string[]> {
  try {
    const rows = await db
      .select({ sku: catalogProducts.sku })
      .from(catalogProducts)
      .where(
        and(
          eq(catalogProducts.market, market),
          eq(catalogProducts.source, "kicksdb"),
          eq(catalogProducts.category, ""),
        ),
      )
      .orderBy(catalogProducts.fetchedAt)
      .limit(limit);
    return rows.map((r) => r.sku);
  } catch (e) {
    console.warn("[catalog] metadata queue skipped (cache unavailable):", describeDbError(e));
    return [];
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
  source: string; // row provenance: "kicksdb" | "goldensneakers" | "woo"
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
      source: r.source,
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

/**
 * KicksDB-sourced SKUs whose prices are past the TTL, oldest first (the
 * refresh feed's queue). Feed-sourced entries are refreshed by their own
 * feed's sync, never by KicksDB lookups that would just miss.
 */
export async function listStaleSkus(
  market: string,
  ttlSeconds: number,
  limit: number,
): Promise<string[]> {
  const threshold = new Date(Date.now() - ttlSeconds * 1000);
  try {
    const rows = await db
      .select({ sku: catalogProducts.sku })
      .from(catalogProducts)
      .where(
        and(
          eq(catalogProducts.market, market),
          eq(catalogProducts.source, "kicksdb"),
          lt(catalogProducts.fetchedAt, threshold),
        ),
      )
      .orderBy(catalogProducts.fetchedAt)
      .limit(limit);
    return rows.map((r) => r.sku);
  } catch (e) {
    console.warn("[catalog] stale list skipped (cache unavailable):", describeDbError(e));
    return [];
  }
}

/** How many KicksDB-sourced entries are past the TTL for a market. */
export async function countStale(market: string, ttlSeconds: number): Promise<number> {
  const threshold = new Date(Date.now() - ttlSeconds * 1000);
  try {
    const rows = await db
      .select({ n: sql<number>`count(*)::int` })
      .from(catalogProducts)
      .where(
        and(
          eq(catalogProducts.market, market),
          eq(catalogProducts.source, "kicksdb"),
          lt(catalogProducts.fetchedAt, threshold),
        ),
      );
    return rows[0]?.n ?? 0;
  } catch (e) {
    console.warn("[catalog] stale count skipped (cache unavailable):", describeDbError(e));
    return 0;
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
    source: p.source ?? "kicksdb",
    stockxId: p.stockxId,
    title: p.title,
    brand: p.brand,
    image: p.image ?? "",
    category: p.category ?? "",
    secondaryCategory: p.secondaryCategory ?? "",
    gender: p.gender ?? "",
    model: p.model ?? "",
    productType: p.productType ?? "",
    minAsk: minAskOf(p),
    variantCount: p.variants.length,
    data: p,
    addedAt: now,
    fetchedAt: now,
    updatedAt: now,
  }));

  try {
    // Chunked: a whole-store registration can be thousands of rows, and a
    // single multi-row INSERT would overflow Postgres's parameter limit.
    for (const chunk of chunkArray(values, 500)) {
      await db
        .insert(catalogProducts)
        .values(chunk)
        .onConflictDoUpdate({
          target: [catalogProducts.market, catalogProducts.sku],
          set: {
            source: sql`excluded.source`,
            stockxId: sql`excluded.stockx_id`,
            title: sql`excluded.title`,
            brand: sql`excluded.brand`,
            // A refresh without an image must never blank a known-good one;
            // the jsonb copy is patched to match so data.image never diverges
            // from the denormalized column.
            image: sql`case when excluded.image = '' then ${catalogProducts.image} else excluded.image end`,
            category: sql`excluded.category`,
            secondaryCategory: sql`excluded.secondary_category`,
            gender: sql`excluded.gender`,
            model: sql`excluded.model`,
            productType: sql`excluded.product_type`,
            minAsk: sql`excluded.min_ask`,
            variantCount: sql`excluded.variant_count`,
            data: sql`case when excluded.image = '' and ${catalogProducts.image} <> ''
              then jsonb_set(excluded.data, '{image}', to_jsonb(${catalogProducts.image}))
              else excluded.data end`,
            fetchedAt: sql`excluded.fetched_at`,
            updatedAt: sql`excluded.updated_at`,
            // added_at intentionally NOT updated: it records first insert.
          },
        });
    }
  } catch (e) {
    console.warn("[catalog] write skipped (cache unavailable):", describeDbError(e));
  }
}

/**
 * Rotate SKUs the refresh attempted but could not re-price — the bulk endpoint
 * ANSWERED without them (delisted, or the API 500s on the product's own data) —
 * to the back of the stale queue by bumping fetchedAt. The stored prices are
 * kept (a retry has no better data); the entry simply waits a full TTL cycle
 * again instead of permanently clogging the head of the queue and starving
 * every SKU behind it. Never called on an outage: that throws upstream.
 */
export async function touchCatalogSkus(market: string, skus: string[]): Promise<void> {
  if (skus.length === 0) return;
  const now = new Date();
  try {
    for (const part of chunkArray(skus.map(skuKey), 500)) {
      await db
        .update(catalogProducts)
        .set({ fetchedAt: now, updatedAt: now })
        .where(and(eq(catalogProducts.market, market), inArray(catalogProducts.sku, part)));
    }
  } catch (e) {
    console.warn("[catalog] touch skipped (cache unavailable):", describeDbError(e));
  }
}

/** Provenance of existing entries — feed syncs must never overwrite kicksdb rows. */
export async function getCatalogSources(
  market: string,
  skus: string[],
): Promise<Map<string, string>> {
  const out = new Map<string, string>();
  if (skus.length === 0) return out;
  try {
    const rows = await db
      .select({ sku: catalogProducts.sku, source: catalogProducts.source })
      .from(catalogProducts)
      .where(and(eq(catalogProducts.market, market), inArray(catalogProducts.sku, skus.map(skuKey))));
    for (const r of rows) out.set(r.sku, r.source);
  } catch (e) {
    console.warn("[catalog] sources skipped (cache unavailable):", describeDbError(e));
  }
  return out;
}

/** Surface the underlying pg message (drizzle wraps it) for actionable logs. */
function describeDbError(e: unknown): string {
  const cause = (e as { cause?: { message?: string } })?.cause;
  if (cause?.message) return cause.message;
  return e instanceof Error ? e.message : String(e);
}
