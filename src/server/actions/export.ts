"use server";

import { z } from "zod";
import { getActiveSnapshot } from "@/server/store-json/repo";
import { buildReimport, type VariationPatch } from "@/server/store-json/patch";
import { getPlanById } from "@/server/plans/repo";

const ExportInputSchema = z.object({
  selections: z
    .array(z.object({ planId: z.string().min(1), variantIds: z.array(z.string().min(1)).min(1) }))
    .default([]),
  // Also clean the store in the same file: drop ghosts + realign pa_taglia.
  sanitize: z.boolean().default(true),
});
export type ExportInput = z.infer<typeof ExportInputSchema>;

export interface ExportSummary {
  productsChanged: number;
  variationsChanged: number;
  gtinsWritten: number;
  unmatched: number;
  sanitized: boolean;
  ghostsRemoved: number;
  taglieRealigned: number;
  parentAttributesRealigned: number;
}

export interface ExportResult {
  ok: boolean;
  error?: string;
  json?: string;
  filename?: string;
  summary?: ExportSummary;
}

/**
 * Produce the re-import JSON in one shot: reprice the selected, matched "update"
 * variations AND (when enabled) sanitize the whole store — drop ghost variations
 * and realign pa_taglia. Only products that actually changed are included;
 * everything else is preserved. Synchronous — no Woo calls. Items that aren't on
 * the store (action "create") are reported as unmatched.
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
  }

  const sanitize = parsed.data.sanitize;
  const built = buildReimport(snapshot, patches, { sanitize });
  const stamp = new Date().toISOString().slice(0, 19).replace(/[:T]/g, "");

  return {
    ok: true,
    json: JSON.stringify(built.output, null, 2),
    filename: `${sanitize ? "repriced-clean" : "repriced"}-${stamp}.json`,
    summary: {
      productsChanged: built.productsChanged,
      variationsChanged: built.variationsChanged,
      gtinsWritten: built.gtinsWritten,
      unmatched,
      sanitized: sanitize,
      ghostsRemoved: built.ghostsRemoved,
      taglieRealigned: built.taglieRealigned,
      parentAttributesRealigned: built.parentAttributesRealigned,
    },
  };
}
