import "server-only";
import { inArray } from "drizzle-orm";
import type { VariantMapping } from "@core/core-spine";
import { db } from "@/server/db/client";
import { variantMappings } from "@/server/db/schema";

/**
 * Load confirmed StockX-variant -> Woo-variation mappings for the given variant
 * ids. This is the cheap rerun path: matches persisted by a prior apply/import.
 * Variants with no row are absent from the map -> buildPlan treats them as
 * "create". (Live Woo matching by UPC/SKU lands when writes are wired in M2/M3.)
 */
export async function getMappingsForVariants(
  variantIds: string[],
): Promise<Map<string, VariantMapping>> {
  const map = new Map<string, VariantMapping>();
  if (variantIds.length === 0) return map;

  const rows = await db
    .select()
    .from(variantMappings)
    .where(inArray(variantMappings.stockxVariantId, variantIds));

  for (const r of rows) {
    map.set(r.stockxVariantId, {
      stockxVariantId: r.stockxVariantId,
      storeProductId: r.storeProductId,
      storeVariationId: r.storeVariationId,
      currentPrice: r.currentPrice,
    });
  }
  return map;
}
