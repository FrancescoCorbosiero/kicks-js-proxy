import "server-only";
import type { SourceProduct } from "@core/core-spine";
import { ownerPinFor, type StoreOverrides } from "@/server/overrides/model";
import { skuKey } from "@/lib/skus";
import { gsOffersToSource, type GsOffer } from "./goldensneakers-model";
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

export interface GsOwnedProduct {
  product: SourceProduct;
  /** euNorm → available quantity (real stock, unlike KicksDB's sell-on-demand). */
  stockBySize: Record<string, number>;
  /** Every size GS has EVER listed for this SKU — the takeover keep-set. */
  knownSizes: Set<string>;
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
 * Overlay ownership onto a fetched product list: GS-owned SKUs replace their
 * KicksDB product (or are appended when KicksDB had nothing). Returns the new
 * list plus the owned set for reporting.
 */
export async function overlayGsOwnership(
  products: SourceProduct[],
  skus: string[],
  market: string,
  overrides: StoreOverrides | null,
): Promise<{ products: SourceProduct[]; gsSkus: Set<string> }> {
  const owned = await gsOwnedProducts(skus, market, overrides);
  if (owned.size === 0) return { products, gsSkus: new Set() };

  const out: SourceProduct[] = [];
  const replaced = new Set<string>();
  for (const p of products) {
    const gs = owned.get(skuKey(p.sku));
    if (gs) {
      // Keep the richer KicksDB identity (title/brand/image) when present —
      // only the VARIANTS and pricing source come from the feed.
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
    if (!replaced.has(sku)) out.push(gs.product); // GS-only: KicksDB had nothing
  }
  return { products: out, gsSkus: new Set(owned.keys()) };
}
