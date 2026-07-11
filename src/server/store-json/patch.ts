import type { StoreModel, StoreVariation } from "./model";
import { alignParentOptions, sanitizeProduct } from "./sanitize";

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
  salesCleared: number;
}

/**
 * When we set a price from Kicks (or a manual lock), that price IS the price — the
 * variation must not stay on sale. Clear an active sale_price so WooCommerce stops
 * marking it as discounted. Returns true if a live sale was actually cleared.
 */
function clearSale(vrt: StoreVariation): boolean {
  const s = vrt.sale_price;
  if (s == null || s === "") return false;
  const n = Number.parseFloat(String(s));
  if (Number.isNaN(n) || n <= 0) return false; // nothing meaningful to clear
  vrt.sale_price = "";
  return true;
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
  let salesCleared = 0;

  for (const p of clone.products) {
    for (const vrt of p.variations) {
      const patch = patches.get(vrt.id);
      if (!patch) continue;
      let touched = false;
      if (patch.price != null) {
        vrt.regular_price = patch.price.toFixed(2);
        if (clearSale(vrt)) salesCleared += 1; // priced -> not on sale
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

  return { output: clone, productsChanged: changedProducts.size, variationsChanged, gtinsWritten, salesCleared };
}

export interface ReimportOutcome {
  output: StoreModel; // only changed products, every other field preserved
  productsChanged: number;
  variationsChanged: number; // variations repriced
  gtinsWritten: number;
  salesCleared: number; // stale sale_price removed from a repriced variation
  ghostsRemoved: number; // zero-stock variations dropped — NOT on KicksDB (sanitize)
  stockSynthesized: number; // zero-stock variations kept + made available — on KicksDB
  taglieRealigned: number; // pa_taglia values corrected (sanitize)
  parentAttributesRealigned: number; // parent option lists realigned (sanitize)
}

export interface ReimportOptions {
  sanitize: boolean;
  /**
   * Store variation ids present (and priceable) on KicksDB. A zero-stock variation
   * in this set is KEPT and made available (StockX carries the size) instead of
   * being dropped as a ghost. Defaults to empty — treat every zero-stock as a ghost.
   */
  kicksdbVariationIds?: ReadonlySet<number>;
  /**
   * Store product ids that were part of the preview (we have KicksDB data for them).
   * Sanitize only touches these, so a subset/manual run never cuts variations of
   * products it never fetched. Omit to sanitize every product (whole-store runs).
   */
  previewedProductIds?: ReadonlySet<number>;
}

/**
 * The single re-import build: **sanitize first, then reprice**, in one pass, so
 * one downloaded file both fixes prices and cleans the store. Sanitizing first
 * means ghost variations are gone before repricing, so a patch never lands on a
 * variation that's about to be removed. Crucially, a zero-stock variation that is
 * on KicksDB is NOT a ghost — it's kept and made available — because KicksDB has
 * no stock field and StockX can source the size. A product is kept in the output
 * if it was repriced OR sanitized; everything else (SEO, GMC, stock, images) is
 * preserved. When `sanitize` is false this degrades to a pure reprice. Never
 * mutates the input.
 */
export function buildReimport(
  model: StoreModel,
  patches: Map<number, VariationPatch>,
  options: ReimportOptions,
): ReimportOutcome {
  const clone: StoreModel = structuredClone(model);
  const keepAvailable = options.kicksdbVariationIds ?? new Set<number>();
  const previewed = options.previewedProductIds; // undefined => sanitize all products
  const changed = new Set<number>();
  let variationsChanged = 0;
  let gtinsWritten = 0;
  let salesCleared = 0;
  let ghostsRemoved = 0;
  let stockSynthesized = 0;
  let taglieRealigned = 0;
  let parentAttributesRealigned = 0;

  for (const p of clone.products) {
    // 1. Sanitize (only products we have KicksDB data for) before repricing.
    let sanitized = false;
    if (options.sanitize && (!previewed || previewed.has(p.id))) {
      const r = sanitizeProduct(p, keepAvailable);
      ghostsRemoved += r.ghostsRemoved;
      stockSynthesized += r.stockSynthesized;
      taglieRealigned += r.taglieRealigned;
      if (r.parentRealigned) parentAttributesRealigned += 1;
      if (r.changed) changed.add(p.id);
      sanitized = true;
    }

    // 2. Reprice the surviving, selected variations.
    for (const vrt of p.variations) {
      const patch = patches.get(vrt.id);
      if (!patch) continue;
      let touched = false;
      if (patch.price != null) {
        vrt.regular_price = patch.price.toFixed(2);
        if (clearSale(vrt)) salesCleared += 1; // priced from Kicks -> not on sale
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

    // 3. Any product we emit must carry a pa_taglia option list that matches its
    // variations — else the importer's option-replace drifts the dropdown.
    // Sanitize already did this; do it for emitted-but-not-sanitized products too.
    if (!sanitized && changed.has(p.id) && alignParentOptions(p)) {
      parentAttributesRealigned += 1;
    }
  }

  clone.products = clone.products.filter((p) => changed.has(p.id));
  if (typeof clone.product_count === "number") clone.product_count = clone.products.length;

  return {
    output: clone,
    productsChanged: changed.size,
    variationsChanged,
    gtinsWritten,
    salesCleared,
    ghostsRemoved,
    stockSynthesized,
    taglieRealigned,
    parentAttributesRealigned,
  };
}
