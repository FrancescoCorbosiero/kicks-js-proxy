import type { StoreModel } from "./model";
import { sanitizeProduct } from "./sanitize";

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

export interface ReimportOutcome {
  output: StoreModel; // only changed products, every other field preserved
  productsChanged: number;
  variationsChanged: number; // variations repriced
  gtinsWritten: number;
  ghostsRemoved: number; // zero-stock variations dropped (sanitize)
  taglieRealigned: number; // pa_taglia values corrected (sanitize)
  parentAttributesRealigned: number; // parent option lists realigned (sanitize)
}

/**
 * The single re-import build: **sanitize first, then reprice**, in one pass, so
 * one downloaded file both fixes prices and cleans the store. Sanitizing first
 * means ghost variations are gone before repricing, so a patch never lands on a
 * variation that's about to be removed. A product is kept if it was repriced OR
 * sanitized; everything else (SEO, GMC, stock, images) is preserved. When
 * `sanitize` is false this degrades to a pure reprice. Never mutates the input.
 */
export function buildReimport(
  model: StoreModel,
  patches: Map<number, VariationPatch>,
  options: { sanitize: boolean },
): ReimportOutcome {
  const clone: StoreModel = structuredClone(model);
  const changed = new Set<number>();
  let variationsChanged = 0;
  let gtinsWritten = 0;
  let ghostsRemoved = 0;
  let taglieRealigned = 0;
  let parentAttributesRealigned = 0;

  for (const p of clone.products) {
    // 1. Sanitize (drops ghosts, realigns pa_taglia) so repricing sees the clean set.
    if (options.sanitize) {
      const r = sanitizeProduct(p);
      ghostsRemoved += r.ghostsRemoved;
      taglieRealigned += r.taglieRealigned;
      if (r.parentRealigned) parentAttributesRealigned += 1;
      if (r.changed) changed.add(p.id);
    }

    // 2. Reprice the surviving, selected variations.
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
        changed.add(p.id);
      }
    }
  }

  clone.products = clone.products.filter((p) => changed.has(p.id));
  if (typeof clone.product_count === "number") clone.product_count = clone.products.length;

  return {
    output: clone,
    productsChanged: changed.size,
    variationsChanged,
    gtinsWritten,
    ghostsRemoved,
    taglieRealigned,
    parentAttributesRealigned,
  };
}
