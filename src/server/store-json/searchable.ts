import { skuKey } from "@/lib/skus";
import type { StoreModel } from "./model";

/**
 * "Searchable" = the SKU resolves to a StockX product on KicksDB. Roughly half a
 * shop's catalog never does (own-brand, apparel, dead listings), so every price
 * pass wastes effort matching and re-importing rows that can never change.
 * Stripping the round-trip down to the searchable SKUs is the core optimization:
 * fewer KicksDB lookups, a smaller import file, and a clean unmatched report.
 */

export interface SearchablePartition {
  /** The model containing only products whose SKU is searchable. */
  searchable: StoreModel;
  /** Original SKUs that resolve on KicksDB. */
  searchableSkus: string[];
  /** Original SKUs that do NOT resolve (stripped out). */
  strippedSkus: string[];
}

/**
 * Split a round-trip model into searchable / non-searchable by SKU. `knownKeys`
 * is the set of canonical SKU keys (skuKey) known to resolve on KicksDB — e.g.
 * the SKUs the bulk price endpoint returned, or the catalog's known SKUs.
 */
export function partitionSearchable(model: StoreModel, knownKeys: Set<string>): SearchablePartition {
  const searchableProducts: StoreModel["products"] = [];
  const searchableSkus: string[] = [];
  const strippedSkus: string[] = [];

  for (const p of model.products) {
    if (knownKeys.has(skuKey(p.sku))) {
      searchableProducts.push(p);
      searchableSkus.push(p.sku);
    } else {
      strippedSkus.push(p.sku);
    }
  }

  const searchable: StoreModel = {
    ...model,
    products: searchableProducts,
    ...(typeof model.product_count === "number" ? { product_count: searchableProducts.length } : {}),
  };

  return { searchable, searchableSkus, strippedSkus };
}
