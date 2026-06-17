"use server";

import { z } from "zod";
import { getActiveConfig } from "@/server/config/repo";
import { getStore } from "@/server/adapters/woo";
import { getAnyBySkus } from "@/server/catalog/repo";
import { getPlanRefs } from "@/server/plans/repo";
import { resolveLiveMappings } from "@/server/mappings/service";
import { skuKey } from "@/lib/skus";

const ImportInputSchema = z.object({ planIds: z.array(z.string().min(1)).min(1) });
export type ImportInput = z.infer<typeof ImportInputSchema>;

export interface ImportResult {
  ok: boolean;
  error?: string;
  created: { sku: string; storeProductId: number }[];
  failed: { sku: string; error: string }[];
}

/**
 * M3: create the selected products on WooCommerce (variable product + variations
 * with UPC written to global_unique_id), then resolve+persist mappings so the
 * normal apply path can price them. Idempotent: existing products/variations are
 * left intact.
 */
export async function importProducts(input: ImportInput): Promise<ImportResult> {
  const parsed = ImportInputSchema.safeParse(input);
  if (!parsed.success) {
    return { ok: false, error: "invalid input", created: [], failed: [] };
  }

  const config = await getActiveConfig();
  const store = getStore(config);
  const refs = await getPlanRefs(parsed.data.planIds);

  const created: ImportResult["created"] = [];
  const failed: ImportResult["failed"] = [];

  for (const ref of refs) {
    const product = (await getAnyBySkus(ref.market, [ref.sku])).get(skuKey(ref.sku));
    if (!product) {
      failed.push({ sku: ref.sku, error: "product not in catalog — re-run preview" });
      continue;
    }
    try {
      const { storeProductId } = await store.upsertProduct(product);
      await resolveLiveMappings(store, product); // persist exact matches for repricing
      created.push({ sku: ref.sku, storeProductId });
    } catch (e) {
      failed.push({ sku: ref.sku, error: e instanceof Error ? e.message : String(e) });
    }
  }

  return { ok: failed.length === 0, created, failed };
}
