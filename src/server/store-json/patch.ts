import type { StoreModel } from "./model";

/** A per-variation change: a new price, a GTIN to stamp, and/or an out-of-stock flag. */
export interface VariationPatch {
  price?: number;
  gtin?: string;
  outOfStock?: boolean; // size not on KicksDB -> hide it (stock_status: outofstock)
}

export interface PatchOutcome {
  output: StoreModel; // only changed products, every other field preserved
  productsChanged: number;
  variationsChanged: number;
  gtinsWritten: number;
  sizesRemoved: number; // variations set out of stock (sizes not on KicksDB)
}

/**
 * Produce the re-import model: clone the snapshot, apply per-variation patches by
 * id (regular_price, global_unique_id for GMC, and/or out-of-stock for sizes not
 * on KicksDB), and keep only the products that actually changed. Everything else
 * (SEO, GMC attributes, stock, images) is preserved. Never mutates the input.
 */
export function applyModelPatch(
  model: StoreModel,
  patches: Map<number, VariationPatch>,
): PatchOutcome {
  const clone: StoreModel = structuredClone(model);
  const changedProducts = new Set<number>();
  let variationsChanged = 0;
  let gtinsWritten = 0;
  let sizesRemoved = 0;

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
      if (patch.outOfStock) {
        // Reversible "removal": keep the variation but make it unbuyable. Cover
        // both stock modes (status-based and quantity-managed).
        vrt.stock_status = "outofstock";
        vrt.stock_quantity = 0;
        sizesRemoved += 1;
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

  return {
    output: clone,
    productsChanged: changedProducts.size,
    variationsChanged,
    gtinsWritten,
    sizesRemoved,
  };
}
