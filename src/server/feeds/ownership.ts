import type { SourceProduct, SourceVariant } from "@core/core-spine";
import { skuKey } from "@/lib/skus";
import {
  resolveFromModel,
  variationEuSize,
  variationSizeLabel,
} from "@/server/store-json/match";
import type { StoreProductModel } from "@/server/store-json/model";

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

/**
 * What the feed says about the SKUs asked for. Three answers, kept apart:
 *
 *  - `owned`: at least one ACTIVE row — the feed is the product's truth;
 *  - `delisted`: the feed HAS carried it, and every row is now inactive. The
 *    supplier said "no", which is not "I don't know": the store must stop
 *    selling it (stock 0), whoever still prices it;
 *  - absent from both: the feed has never carried it (or a pin hands it to
 *    KicksDB) — not the feed's business.
 */
export interface GsFeedStatus {
  owned: Map<string, GsOwnedProduct>;
  /** Canonical keys (skuKey) of the delisted SKUs. */
  delisted: Set<string>;
}

/** Prefix of the variant ids synthesized for a delisted product's store sizes. */
export const DELISTED_VARIANT_PREFIX = "delisted:";

/**
 * The source product a DELISTED SKU is planned from, so the ordinary pipeline
 * (buildPlan with `stockOverride: 0`) writes stock 0 to every store variation.
 *
 * Stock only ever enters a plan through a SourceProduct's variants, and a
 * delisted product nobody else covers has none — so its sizes come from the one
 * place that still knows them: the store's own variations. With `priced` (the
 * KicksDB product, when KicksDB covers the SKU) its variants that land on a
 * store variation are kept, so they are repriced; every store size they do not
 * reach is added bare (no offers → no price, stock only). KicksDB sizes the
 * store does not have are dropped: nothing is created for a product the
 * supplier stopped selling.
 *
 * Null when the store has nothing to zero.
 */
export function delistedSource(
  sku: string,
  store: StoreProductModel,
  priced: SourceProduct | undefined,
  market: string,
): SourceProduct | null {
  const index = new Map([[skuKey(store.sku), store]]);
  const variationEu = new Map<number, string>();
  for (const vrt of store.variations) {
    if (!(vrt.id > 0)) continue; // not a write target (see resolveFromModel)
    const eu = variationEuSize(store.sku, vrt);
    if (eu) variationEu.set(vrt.id, eu);
  }

  const kept: SourceVariant[] = [];
  const coveredEu = new Set<string>();
  if (priced) {
    const mappings = resolveFromModel(index, priced);
    for (const v of priced.variants) {
      const m = mappings.get(v.stockxVariantId);
      if (!m) continue;
      kept.push(v);
      const eu = variationEu.get(m.storeVariationId);
      if (eu) coveredEu.add(eu);
    }
  }

  const bare: SourceVariant[] = [];
  const seenEu = new Set<string>();
  for (const vrt of store.variations) {
    const eu = variationEu.get(vrt.id);
    if (!eu || coveredEu.has(eu) || seenEu.has(eu)) continue;
    seenEu.add(eu);
    bare.push({
      stockxVariantId: `${DELISTED_VARIANT_PREFIX}${skuKey(sku)}:${eu}`,
      sizeLabel: variationSizeLabel(store.sku, vrt) ?? eu,
      sizeType: "eu",
      sizes: [{ system: "eu", size: eu }],
      offers: [],
    });
  }

  if (kept.length === 0 && bare.length === 0) return null;
  if (priced) return { ...priced, variants: [...kept, ...bare] };
  return {
    stockxId: sku,
    sku,
    title: store.name ?? sku,
    brand: "",
    image: "",
    market,
    currency: "EUR", // the feed's currency (gsOffersToSource); nothing is priced anyway
    source: "goldensneakers",
    variants: bare,
  };
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

/**
 * Carry per-variant identifiers from the stored catalog onto freshly fetched
 * products.
 *
 * KicksDB's bulk price endpoint — the one the sync runs on — returns sizes and
 * prices but NO identifiers, while the per-product endpoint that fills the
 * catalog does return them. So the sync sees a product whose GTINs it already
 * knows, and would write none. This copies them across, matched on variant id
 * and falling back to the size label, so a KicksDB product is as complete on
 * an external catalog as a supplier-feed one.
 */
export function carryIdentifiers(
  products: SourceProduct[],
  catalog: ReadonlyMap<string, SourceProduct>,
): SourceProduct[] {
  if (catalog.size === 0) return products;
  return products.map((p) => {
    const known = catalog.get(skuKey(p.sku));
    if (!known) return p;
    const byVariantId = new Map<string, string>();
    const bySizeLabel = new Map<string, string>();
    for (const v of known.variants) {
      if (!v.upc) continue;
      byVariantId.set(v.stockxVariantId, v.upc);
      const label = `${v.sizeType}:${v.sizeLabel}`.toLowerCase();
      if (!bySizeLabel.has(label)) bySizeLabel.set(label, v.upc);
    }
    if (byVariantId.size === 0) return p;
    return {
      ...p,
      variants: p.variants.map((v) =>
        v.upc
          ? v
          : {
              ...v,
              upc:
                byVariantId.get(v.stockxVariantId) ??
                bySizeLabel.get(`${v.sizeType}:${v.sizeLabel}`.toLowerCase()),
            },
      ),
    };
  });
}
