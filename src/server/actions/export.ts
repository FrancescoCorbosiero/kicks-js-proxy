"use server";

import { z } from "zod";
import { getActiveSnapshot } from "@/server/store-json/repo";
import { applyModelPatch, type VariationPatch } from "@/server/store-json/patch";
import { variationEuSize } from "@/server/store-json/match";
import { getPlanById } from "@/server/plans/repo";
import { skuKey } from "@/lib/skus";

const ExportInputSchema = z.object({
  selections: z
    .array(z.object({ planId: z.string().min(1), variantIds: z.array(z.string().min(1)).min(1) }))
    .min(1),
  // Opt-in: set store sizes that aren't on KicksDB to out-of-stock (reversible).
  removeUnmatchedSizes: z.boolean().optional(),
});
export type ExportInput = z.infer<typeof ExportInputSchema>;

export interface ExportResult {
  ok: boolean;
  error?: string;
  json?: string;
  filename?: string;
  summary?: {
    productsChanged: number;
    variationsChanged: number;
    gtinsWritten: number;
    sizesRemoved: number;
    unmatched: number;
  };
}

/**
 * Produce the re-import JSON: patch regular_price on the selected, matched
 * "update" variations of the stored snapshot. Synchronous — no Woo calls. Items
 * that aren't on the store (action "create") are reported as unmatched. When
 * removeUnmatchedSizes is on, store sizes with no KicksDB counterpart (for the
 * exported products) are set out of stock.
 */
export async function exportRepricedJson(input: ExportInput): Promise<ExportResult> {
  const parsed = ExportInputSchema.safeParse(input);
  if (!parsed.success) return { ok: false, error: "invalid input" };

  const snapshot = await getActiveSnapshot();
  if (!snapshot) return { ok: false, error: "No store snapshot — upload your store JSON first." };

  const patches = new Map<number, VariationPatch>();
  let unmatched = 0;

  for (const sel of parsed.data.selections) {
    const plan = await getPlanById(sel.planId);
    if (!plan) continue;
    const selSet = new Set(sel.variantIds);
    for (const item of plan.items) {
      if (!selSet.has(item.stockxVariantId)) continue;
      if (item.action !== "update") {
        if (item.action === "create") unmatched += 1;
        continue;
      }
      if (item.storeVariationId == null || item.proposedPrice == null) continue;
      // Reprice + stamp the GTIN (for GMC) on the same matched variation.
      patches.set(item.storeVariationId, { price: item.proposedPrice, gtin: item.upc ?? undefined });
    }

    // Opt-in size removal: for this exported product, set every real store size
    // that didn't match a KicksDB variant to out of stock. Matched store
    // variations are exactly those any plan item links to (regardless of
    // selection), so the remainder are sizes StockX doesn't carry.
    if (parsed.data.removeUnmatchedSizes) {
      const matched = new Set<number>();
      for (const item of plan.items) {
        if (item.storeVariationId != null) matched.add(item.storeVariationId);
      }
      const product = snapshot.products.find((p) => skuKey(p.sku) === skuKey(plan.sku));
      for (const vrt of product?.variations ?? []) {
        // Only touch real, size-bearing variations we didn't match and aren't
        // already repricing.
        if (matched.has(vrt.id) || patches.has(vrt.id)) continue;
        if (variationEuSize(product!.sku, vrt) == null) continue;
        patches.set(vrt.id, { outOfStock: true });
      }
    }
  }

  const { output, productsChanged, variationsChanged, gtinsWritten, sizesRemoved } = applyModelPatch(
    snapshot,
    patches,
  );
  const stamp = new Date().toISOString().slice(0, 19).replace(/[:T]/g, "");

  return {
    ok: true,
    json: JSON.stringify(output, null, 2),
    filename: `repriced-${stamp}.json`,
    summary: { productsChanged, variationsChanged, gtinsWritten, sizesRemoved, unmatched },
  };
}
