import type { StoreModel } from "./model";

/** A per-variation change: a new price and/or a GTIN to stamp into global_unique_id. */
export interface VariationPatch {
  price?: number;
  gtin?: string;
}

export interface PatchOutcome {
  output: StoreModel; // only changed products, every other field preserved
  productsChanged: number;
  variationsChanged: number;
  gtinsWritten: number;
}

/**
 * Produce the re-import model: clone the snapshot, apply per-variation patches by
 * id (regular_price and/or global_unique_id for GMC), and keep only the products
 * that actually changed. Everything else (SEO, GMC attributes, stock, images) is
 * preserved. Never mutates the input.
 */
export function applyModelPatch(
  model: StoreModel,
  patches: Map<number, VariationPatch>,
): PatchOutcome {
  const clone: StoreModel = structuredClone(model);
  const changedProducts = new Set<number>();
  let variationsChanged = 0;
  let gtinsWritten = 0;

  for (const p of clone.products) {
    for (const vrt of p.variations) {
      const patch = patches.get(vrt.id);
      if (!patch) continue;
      let touched = false;
      if (patch.price != null) {
        vrt.regular_price = patch.price.toFixed(2);
        touched = true;
      }
      if (patch.gtin && vrt.global_unique_id !== patch.gtin) {
        vrt.global_unique_id = patch.gtin;
        gtinsWritten += 1;
        touched = true;
      }
      if (touched) {
        variationsChanged += 1;
        changedProducts.add(p.id);
      }
    }
  }

  clone.products = clone.products.filter((p) => changedProducts.has(p.id));
  if (typeof clone.product_count === "number") clone.product_count = clone.products.length;

  return { output: clone, productsChanged: changedProducts.size, variationsChanged, gtinsWritten };
}
