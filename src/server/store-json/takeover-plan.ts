import type { StoreProductModel, StoreVariation } from "./model";
import {
  humanEuSize,
  preferStoreVariation,
  readTaglia,
  variationEuSize,
  variationSizeLabel,
  writeTaglia,
} from "./match";
import { rebuildParentAttributes } from "./rebuild-plan";
import type { ProductSanitizeOps } from "./sanitize-plan";
import type { ProductSanitizeResult } from "./sanitize";

/**
 * Feed TAKEOVER cleanup: when a feed (GoldenSneakers) owns a product, the
 * store's variation set must contain ONLY sizes the feed has ever known.
 *
 *  - a size the feed has NEVER listed (KicksDB-era leftovers, unparseable
 *    junk) → DELETED — those variants can no longer be sourced;
 *  - a feed-known size → kept (its quantity is written by the plan's stock
 *    sync: active rows carry real qty, deactivated ones zero out);
 *  - duplicate variations for one size → best twin kept, the rest deleted;
 *  - pa_taglia realigned on survivors and on the parent's option list.
 *
 * Pure and non-mutating — emits the same ops shape as the KicksDB sanitize
 * planner, so the apply executor treats both identically.
 */
export function planFeedTakeover(
  product: StoreProductModel,
  knownSizes: ReadonlySet<string>, // euNorm keys the feed has ever listed
  tagliaAttributeId?: number,
): ProductSanitizeOps | null {
  if (knownSizes.size === 0) return null; // never trim against an empty truth

  // Pick the best variation per feed-known size; everything else goes.
  const bestBySize = new Map<string, StoreVariation>();
  let duplicatesRemoved = 0;
  for (const vrt of product.variations) {
    const size = variationEuSize(product.sku, vrt);
    if (!size || !knownSizes.has(size)) continue;
    const cur = bestBySize.get(size);
    if (!cur) bestBySize.set(size, vrt);
    else {
      duplicatesRemoved += 1;
      if (preferStoreVariation(product.sku, vrt, cur) < 0) bestBySize.set(size, vrt);
    }
  }

  const keepIds = new Set([...bestBySize.values()].map((v) => v.id));
  const deleteVariationIds = product.variations
    .filter((v) => !keepIds.has(v.id))
    .map((v) => v.id);
  const takeoverRemoved = deleteVariationIds.length - duplicatesRemoved;

  // Realign survivors' pa_taglia (REST array shape only — same contract as the
  // sanitize planner; object-shaped attributes belong to the file flow).
  const sanitizedVariations: StoreVariation[] = [];
  const variationWrites: ProductSanitizeOps["variationWrites"] = [];
  const labels: string[] = [];
  let taglieRealigned = 0;
  for (const [size, vrt] of bestBySize) {
    // Human label from the variation itself ("36 2/3"), not the numeric key
    // ("36.67") — same derivation the sanitize engine uses.
    const label = variationSizeLabel(product.sku, vrt) ?? humanEuSize(size) ?? size;
    labels.push(label);
    const clone: StoreVariation = structuredClone(vrt);
    if (readTaglia(clone) !== label) {
      writeTaglia(clone, label);
      if (Array.isArray(clone.attributes)) {
        variationWrites.push({ id: vrt.id, attributes: clone.attributes });
        taglieRealigned += 1;
      }
    }
    sanitizedVariations.push(clone);
  }
  sanitizedVariations.sort((a, b) => a.id - b.id);

  // Parent option list = exactly the feed-known sizes that survived.
  const sortedLabels = [...labels].sort((a, b) => {
    const na = Number.parseFloat(a);
    const nb = Number.parseFloat(b);
    return Number.isNaN(na) || Number.isNaN(nb) ? a.localeCompare(b) : na - nb;
  });
  const nextAttributes = rebuildParentAttributes(
    (product as { attributes?: unknown }).attributes,
    sortedLabels,
    tagliaAttributeId,
  );
  const parentChanged =
    JSON.stringify((product as { attributes?: unknown }).attributes ?? null) !==
    JSON.stringify(nextAttributes);

  if (deleteVariationIds.length === 0 && variationWrites.length === 0 && !parentChanged) {
    return null; // already a pure feed product
  }

  const counts: ProductSanitizeResult = {
    ghostsRemoved: takeoverRemoved, // out-of-feed variants (reported separately)
    stockSynthesized: 0,
    duplicatesRemoved,
    taglieRealigned,
    parentRealigned: parentChanged,
    changed: true,
  };

  const sanitized: StoreProductModel = {
    ...structuredClone(product),
    attributes: nextAttributes,
    variations: sanitizedVariations,
  };

  return {
    storeProductId: product.id,
    sku: product.sku,
    deleteVariationIds,
    variationWrites,
    parentAttributes: parentChanged ? nextAttributes : null,
    counts,
    sanitized,
    takeover: true,
  };
}
