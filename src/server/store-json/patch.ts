import type { StoreModel } from "./model";

export interface PatchOutcome {
  output: StoreModel; // only changed products, every other field preserved
  productsChanged: number;
  variationsChanged: number;
}

/**
 * Produce the re-import model: clone the snapshot, set regular_price on the
 * changed variations (by id), and keep only the products that actually changed.
 * Everything else on those products/variations (SEO, GMC, stock, images) is
 * preserved byte-faithfully.
 */
export function applyPricesToModel(
  model: StoreModel,
  changes: Map<number, number>,
): PatchOutcome {
  const clone: StoreModel = structuredClone(model);
  const changedProducts = new Set<number>();
  let variationsChanged = 0;

  for (const p of clone.products) {
    for (const vrt of p.variations) {
      const price = changes.get(vrt.id);
      if (price == null) continue;
      vrt.regular_price = price.toFixed(2);
      variationsChanged += 1;
      changedProducts.add(p.id);
    }
  }

  clone.products = clone.products.filter((p) => changedProducts.has(p.id));
  if (typeof clone.product_count === "number") clone.product_count = clone.products.length;

  return { output: clone, productsChanged: changedProducts.size, variationsChanged };
}
