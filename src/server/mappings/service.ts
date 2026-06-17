import "server-only";
import type { StorePort, SourceProduct, VariantMapping } from "@core/core-spine";
import { getMappingsForVariants, upsertMappings } from "./repo";

/**
 * Resolve StockX variants to Woo variations for one product, best-effort:
 *  - ask the store (live UPC/SKU matching), persist what it finds, and return it;
 *  - if the store call fails (Woo down/misconfigured), fall back to the
 *    previously persisted mappings so preview/apply still work offline.
 *
 * Used by both preview (accurate current-price diffs) and apply.
 */
export async function resolveLiveMappings(
  store: StorePort,
  product: SourceProduct,
): Promise<Map<string, VariantMapping>> {
  try {
    const map = await store.resolveMappings(product);
    await upsertMappings(product, map).catch((e) =>
      console.warn("[mappings] persist skipped:", e instanceof Error ? e.message : String(e)),
    );
    return map;
  } catch (e) {
    console.warn(
      "[mappings] live resolve failed, using persisted:",
      e instanceof Error ? e.message : String(e),
    );
    return getMappingsForVariants(product.variants.map((v) => v.stockxVariantId));
  }
}
