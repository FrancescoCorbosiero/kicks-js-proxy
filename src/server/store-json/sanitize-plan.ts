import type { StoreProductModel, StoreVariation } from "./model";
import { sanitizeProduct, type ProductSanitizeResult } from "./sanitize";

/**
 * Turn the sanitize engine into concrete Woo REST operations.
 *
 * The file flow rewrites a whole export; the REST sync instead needs the exact
 * per-variation operations: which orphan/duplicate variations to DELETE, which
 * survivors to rewrite (realigned pa_taglia, made-available stock), and the
 * parent's realigned pa_taglia option list to PUT. This planner runs the same
 * `sanitizeProduct` engine on a clone and diffs it against the original, so
 * REST cleanup and file cleanup can never disagree.
 *
 * Pure and non-mutating — the returned `sanitized` clone is the desired end
 * state, reusable to patch the stored snapshot after a successful apply.
 */

export interface VariationRestWrite {
  id: number;
  /** Realigned pa_taglia, in the shape the store uses (REST array passed back as-is). */
  attributes?: StoreVariation["attributes"];
  stock_status?: string;
  manage_stock?: boolean;
}

export interface ProductSanitizeOps {
  storeProductId: number;
  sku: string;
  /** Ghosts + stale duplicates — permanently removed from the store. */
  deleteVariationIds: number[];
  /** Surviving variations that need a rewrite (pa_taglia and/or stock). */
  variationWrites: VariationRestWrite[];
  /** Full attributes payload for the parent PUT, when the option list changed. */
  parentAttributes: unknown | null;
  counts: ProductSanitizeResult;
  /** The desired post-cleanup product (before any price writes). */
  sanitized: StoreProductModel;
  /** Set by the feed-takeover planner: deletions are out-of-feed variants. */
  takeover?: boolean;
}

const sameJson = (a: unknown, b: unknown) => JSON.stringify(a ?? null) === JSON.stringify(b ?? null);

/**
 * Plan the cleanup for one product, or null when it is already aligned.
 *
 * Attribute rewrites are only emitted when the variation carries the REST
 * array shape (the shape a REST pull produces) — Woo's variation update
 * endpoint matches attributes by id/name, so an array entry updated in place
 * round-trips exactly. Object-shaped attributes (file exports) are left to the
 * file flow; stock/delete operations apply regardless of shape.
 */
export function planProductSanitize(
  product: StoreProductModel,
  keepAvailable: ReadonlySet<number> = new Set(),
): ProductSanitizeOps | null {
  const sanitized: StoreProductModel = structuredClone(product);
  const counts = sanitizeProduct(sanitized, keepAvailable);
  if (!counts.changed) return null;

  const after = new Map(sanitized.variations.map((v) => [v.id, v]));
  const deleteVariationIds = product.variations
    .filter((v) => !after.has(v.id))
    .map((v) => v.id);

  const variationWrites: VariationRestWrite[] = [];
  for (const before of product.variations) {
    const now = after.get(before.id);
    if (!now) continue;
    const write: VariationRestWrite = { id: before.id };
    let touched = false;

    if (!sameJson(before.attributes, now.attributes) && Array.isArray(now.attributes)) {
      write.attributes = now.attributes;
      touched = true;
    }
    if (before.stock_status !== now.stock_status && typeof now.stock_status === "string") {
      write.stock_status = now.stock_status;
      touched = true;
    }
    if (before.manage_stock !== now.manage_stock && typeof now.manage_stock === "boolean") {
      write.manage_stock = now.manage_stock;
      touched = true;
    }
    if (touched) variationWrites.push(write);
  }

  const beforeAttrs = (product as { attributes?: unknown }).attributes;
  const afterAttrs = (sanitized as { attributes?: unknown }).attributes;
  const parentAttributes =
    !sameJson(beforeAttrs, afterAttrs) && Array.isArray(afterAttrs) ? afterAttrs : null;

  if (deleteVariationIds.length === 0 && variationWrites.length === 0 && parentAttributes == null) {
    return null; // every change was in a shape REST can't address — nothing to do live
  }

  return {
    storeProductId: product.id,
    sku: product.sku,
    deleteVariationIds,
    variationWrites,
    parentAttributes,
    counts,
    sanitized,
  };
}
