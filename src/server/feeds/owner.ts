import "server-only";
import type { SourceProduct } from "@core/core-spine";
import { ownerPinFor, type StoreOverrides } from "@/server/overrides/model";
import { skuKey } from "@/lib/skus";
import { gsOffersToSource, type GsOffer } from "./goldensneakers-model";
import { mergeGsOwned, type GsOwnedProduct } from "./ownership";
import { GS_FEED, knownOffersBySku } from "./repo";
import type { FeedItemRow } from "@/server/db/schema";

/**
 * Product-level ownership: a product is owned by exactly ONE source.
 *
 *   manual pin (business owner)  >  goldensneakers (feed covers the SKU)  >  kicksdb
 *
 * A GS-owned product's variant set comes ENTIRELY from the feed — KicksDB
 * sizes are dropped by design (the agreed simplification that kills every
 * per-variant conflict).
 */

/** A deactivated row contributes its size at qty 0 — zeroed, never forgotten. */
function rowToOffer(r: FeedItemRow): GsOffer {
  return {
    sku: r.sku,
    euNorm: r.euNorm,
    sizeLabel: r.sizeLabel,
    sizeUs: r.sizeUs,
    barcode: r.barcode,
    offerPrice: r.offerPrice,
    presentedPrice: r.presentedPrice,
    quantity: r.active ? r.quantity : 0,
    productName: r.productName,
    brandName: r.brandName,
    image: r.image,
    raw: r.raw,
  };
}

/**
 * The GS-owned products among `skus`, honoring manual pins. Ownership requires
 * at least one ACTIVE row; the variant set then includes deactivated sizes at
 * qty 0. Best-effort: with no feed data everything stays kicksdb-owned.
 */
export async function gsOwnedProducts(
  skus: string[],
  market: string,
  overrides: StoreOverrides | null,
): Promise<Map<string, GsOwnedProduct>> {
  const out = new Map<string, GsOwnedProduct>();
  const bySku = await knownOffersBySku(GS_FEED, skus);
  for (const [sku, rows] of bySku) {
    if (!rows.some((r) => r.active)) continue; // fully delisted → back to kicksdb
    if (overrides && ownerPinFor(overrides, sku) === "kicksdb") continue; // pinned back
    const offers = rows.map(rowToOffer);
    const product = gsOffersToSource(sku, offers, market);
    if (product.variants.length === 0) continue; // nothing sellable
    const stockBySize: Record<string, number> = {};
    for (const o of offers) stockBySize[o.euNorm] = o.quantity;
    out.set(skuKey(sku), {
      product,
      stockBySize,
      knownSizes: new Set(offers.map((o) => o.euNorm)),
    });
  }
  return out;
}

/**
 * Resolve ownership for `skus` and overlay it onto a fetched product list.
 * Convenience for callers that query KicksDB before knowing who owns what.
 */
export async function overlayGsOwnership(
  products: SourceProduct[],
  skus: string[],
  market: string,
  overrides: StoreOverrides | null,
): Promise<{ products: SourceProduct[]; gsSkus: Set<string> }> {
  return mergeGsOwned(products, await gsOwnedProducts(skus, market, overrides));
}

export { mergeGsOwned, fetchSecondarySource } from "./ownership";
export type { GsOwnedProduct } from "./ownership";
