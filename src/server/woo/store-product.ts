import type { StoreProductModel } from "@/server/store-json/model";
import type { WooRestProduct, WooRestVariation } from "./client";

/**
 * Trim a Woo REST product + its variations to the store-model shape the
 * matching/plan engine reads (id, sku, name, variations with price/stock/
 * GTIN/pa_taglia). We deliberately do NOT keep the full REST payload: the
 * REST apply patches prices in place, so nothing needs to round-trip.
 */
export function toStoreProduct(p: WooRestProduct, variations: WooRestVariation[]): StoreProductModel {
  return {
    id: p.id,
    sku: p.sku ?? "",
    name: p.name ?? null,
    status: p.status ?? null,
    permalink: p.permalink ?? null,
    date_modified: p.date_modified ?? null,
    // First image only (src) — enough for the catalog card of store-only products.
    images: p.images?.[0]?.src ? [{ src: p.images[0].src }] : null,
    // Parent attributes carry the pa_taglia option list the cleanup realigns.
    attributes: p.attributes ?? null,
    variations: variations.map((v) => ({
      id: v.id,
      sku: v.sku ?? null,
      regular_price: v.regular_price ?? null,
      sale_price: v.sale_price ?? null,
      global_unique_id: v.global_unique_id ?? null,
      stock_quantity: v.stock_quantity ?? null,
      manage_stock: v.manage_stock ?? null,
      stock_status: v.stock_status ?? null,
      attributes: v.attributes ?? null,
    })),
  };
}
