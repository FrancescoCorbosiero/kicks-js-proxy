/**
 * The Publish tab's list, filtered and paged on the SERVER.
 *
 * It used to be filtered in the browser, which meant the page had to carry
 * every unpublished catalog product to do it: 1.75 MB of serialized candidates
 * on a 4000-product shop, growing with the catalog, so that 300 rows could be
 * rendered. The delta is unbounded by nature — it is the whole catalog on a
 * shop that has published nothing — so the list is now resolved here and only
 * a page of it crosses into the browser, exactly like discovery does.
 *
 * Pure on purpose: the store-presence flag comes from the snapshot rather than
 * from SQL, so the rows cannot be filtered in the query — but they can be
 * filtered without touching a database, and then tested without one.
 */

/** Rows shipped to the browser. Beyond this, search narrows. */
export const PAGE_LIMIT = 300;

export type PublishSourceLens = "all" | "goldensneakers" | "kicksdb";

export interface PublishQuery {
  /** Case-insensitive substring over SKU / title / brand. */
  q?: string;
  /** The source lens. Ignored unless the pool really holds both sources. */
  source?: PublishSourceLens;
  /** Include products the store already has (for force reimport). */
  showOnStore?: boolean;
}

/** Everything the header counts, over the whole pool — never over the page. */
export interface PublishCounts {
  /** The current pool: the delta, or everything when showOnStore is on. */
  all: number;
  goldensneakers: number;
  kicksdb: number;
  /** The catalog→store delta, whatever the lens says. */
  missing: number;
  /** Every candidate the catalog holds. */
  total: number;
}

export interface PublishPage<T> {
  /** The page the browser receives. */
  candidates: T[];
  counts: PublishCounts;
  /** Rows matching the current query, including those past PAGE_LIMIT. */
  matched: number;
}

/** The fields the list is filtered by — anything else rides along untouched. */
export interface PublishFilterable {
  sku: string;
  title: string;
  brand: string;
  source: string;
  onStore: boolean;
}

/**
 * Both sources represented? Everything provider-specific in the tab hangs off
 * this: on a single-source shop the labels are noise, not information — and a
 * lens that cannot be seen must not be allowed to filter either.
 */
export function hasMixedSources(counts: PublishCounts): boolean {
  return counts.goldensneakers > 0 && counts.kicksdb > 0;
}

export function pagePublishTargets<T extends PublishFilterable>(
  rows: T[],
  query: PublishQuery = {},
  limit = PAGE_LIMIT,
): PublishPage<T> {
  const missing = rows.filter((r) => !r.onStore);
  const pool = query.showOnStore ? rows : missing;

  let goldensneakers = 0;
  for (const c of pool) if (c.source === "goldensneakers") goldensneakers += 1;
  const counts: PublishCounts = {
    all: pool.length,
    goldensneakers,
    kicksdb: pool.length - goldensneakers,
    missing: missing.length,
    total: rows.length,
  };

  // Counted BEFORE the lens, so the tab labels always show the full split.
  const mixed = hasMixedSources(counts);
  const q = (query.q ?? "").trim().toLowerCase();
  const matched = pool.filter((c) => {
    if (mixed && query.source === "goldensneakers" && c.source !== "goldensneakers") return false;
    if (mixed && query.source === "kicksdb" && c.source === "goldensneakers") return false;
    if (!q) return true;
    return (
      c.sku.toLowerCase().includes(q) ||
      c.title.toLowerCase().includes(q) ||
      c.brand.toLowerCase().includes(q)
    );
  });

  return { candidates: matched.slice(0, limit), counts, matched: matched.length };
}
