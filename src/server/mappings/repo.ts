import "server-only";
import { inArray, sql } from "drizzle-orm";
import type { SourceProduct, VariantMapping } from "@core/core-spine";
import { db } from "@/server/db/client";
import { variantMappings } from "@/server/db/schema";

/**
 * Load confirmed StockX-variant -> Woo-variation mappings for the given variant
 * ids. This is the cheap rerun path: matches persisted by a prior apply/import.
 * Variants with no row are absent from the map -> buildPlan treats them as
 * "create".
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

/** Persist confirmed matches so subsequent resolutions are cheap. */
export async function upsertMappings(
  product: SourceProduct,
  mappings: Map<string, VariantMapping>,
): Promise<void> {
  if (mappings.size === 0) return;
  const upcByVariant = new Map(product.variants.map((v) => [v.stockxVariantId, v.upc]));
  const now = new Date();

  const values = [...mappings.values()].map((m) => {
    const upc = upcByVariant.get(m.stockxVariantId) ?? null;
    return {
      stockxVariantId: m.stockxVariantId,
      storeProductId: m.storeProductId,
      storeVariationId: m.storeVariationId,
      upc,
      currentPrice: m.currentPrice,
      strategy: (upc ? "upc" : "skuPattern") as "upc" | "skuPattern" | "manual",
      confirmed: true,
      updatedAt: now,
    };
  });

  await db
    .insert(variantMappings)
    .values(values)
    .onConflictDoUpdate({
      target: variantMappings.stockxVariantId,
      set: {
        storeProductId: sql`excluded.store_product_id`,
        storeVariationId: sql`excluded.store_variation_id`,
        upc: sql`excluded.upc`,
        currentPrice: sql`excluded.current_price`,
        strategy: sql`excluded.strategy`,
        updatedAt: sql`excluded.updated_at`,
      },
    });
}
