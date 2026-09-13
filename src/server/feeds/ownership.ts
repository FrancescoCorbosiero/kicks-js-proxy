import type { SourceProduct } from "@core/core-spine";
import { skuKey } from "@/lib/skus";

/**
 * How the sources are mixed once ownership is known. Pure module — no DB, no
 * HTTP, no server-only imports — because this is the rule that decides whether
 * a supplier-only store can be synced at all, and it deserves tests.
 */

export interface GsOwnedProduct {
  product: SourceProduct;
  /** euNorm → available quantity (real stock, unlike KicksDB's sell-on-demand). */
  stockBySize: Record<string, number>;
  /** Every size GS has EVER listed for this SKU — the takeover keep-set. */
  knownSizes: Set<string>;
}

/**
 * Merge an already-resolved ownership map into a fetched product list: owned
 * SKUs replace their KicksDB product (or are appended when KicksDB had
 * nothing), keeping the richer KicksDB identity where there is one.
 */
export function mergeGsOwned(
  products: SourceProduct[],
  owned: Map<string, GsOwnedProduct>,
): { products: SourceProduct[]; gsSkus: Set<string> } {
  if (owned.size === 0) return { products, gsSkus: new Set() };

  const out: SourceProduct[] = [];
  const replaced = new Set<string>();
  for (const p of products) {
    const gs = owned.get(skuKey(p.sku));
    if (gs) {
      // Only the VARIANTS and pricing source come from the feed.
      out.push({
        ...gs.product,
        title: p.title || gs.product.title,
        brand: p.brand || gs.product.brand,
        image: p.image || gs.product.image,
      });
      replaced.add(skuKey(p.sku));
    } else {
      out.push(p);
    }
  }
  for (const [sku, gs] of owned) {
    if (!replaced.has(sku)) out.push(gs.product); // feed-only: KicksDB had nothing
  }
  return { products: out, gsSkus: new Set(owned.keys()) };
}

export interface SecondaryFetch {
  products: SourceProduct[];
  /** Set when the source was skipped or failed but the run still stands. */
  warning?: string;
}

/**
 * Fetch the products the feed does NOT own from the secondary source
 * (KicksDB), under the rule that makes this app provider-agnostic:
 *
 *  - feed-owned SKUs are never requested — the feed IS their truth, and on a
 *    supplier-only store that is every SKU, so KicksDB is not called at all;
 *  - an unconfigured secondary source is a warning, not an error: a shop with
 *    no KicksDB account is a supported setup, not a broken one;
 *  - a failing secondary source is fatal ONLY when it was the sole source in
 *    play. Otherwise the feed-owned products are still fully plannable, and
 *    burying them under another provider's outage is what made the sync look
 *    dead on a store the feed covers entirely.
 */
export async function fetchSecondarySource(
  skus: string[],
  opts: {
    ownedCount: number;
    configured: boolean;
    fetch: (skus: string[]) => Promise<SourceProduct[]>;
    describeError?: (e: unknown) => string;
  },
): Promise<SecondaryFetch> {
  if (skus.length === 0) return { products: [] };
  if (!opts.configured) {
    return {
      products: [],
      warning: `KicksDB is not configured — ${skus.length} store product(s) it would price were left untouched.`,
    };
  }
  try {
    return { products: await opts.fetch(skus) };
  } catch (e) {
    if (opts.ownedCount === 0) throw e;
    const describe = opts.describeError ?? ((x: unknown) => (x instanceof Error ? x.message : String(x)));
    return {
      products: [],
      warning: `KicksDB unreachable (${describe(e)}) — only feed-owned products were planned.`,
    };
  }
}
