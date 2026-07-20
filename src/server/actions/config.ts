"use server";

import { z } from "zod";
import { clearConfig, getActiveConfig, saveActiveConfig } from "@/server/config/repo";
import { pricingSummary, type PricingSummary } from "@/server/config/summary";

/** Wipe the stored config and re-seed from defaults.ts; return the new summary. */
export async function resetPricingToDefaults(): Promise<PricingSummary> {
  await clearConfig();
  return pricingSummary(await getActiveConfig());
}

const PricingInputSchema = z.object({
  markupPercent: z.number().min(0).max(1000),
  vatRatePercent: z.number().min(0).max(100),
  roundingMode: z.enum(["none", "integer", "charm", "nearest"]),
  increment: z.number().min(0).optional(),
  minAsks: z.number().int().min(0),
});
export type PricingInput = z.infer<typeof PricingInputSchema>;

/** Update the general pricing rule (markup / VAT / rounding / minAsks) and save. */
export async function updatePricing(
  input: PricingInput,
): Promise<{ ok: boolean; error?: string; summary?: PricingSummary }> {
  const parsed = PricingInputSchema.safeParse(input);
  if (!parsed.success) {
    return { ok: false, error: parsed.error.issues.map((i) => i.message).join("; ") };
  }
  const d = parsed.data;

  const cfg = await getActiveConfig();
  const rule = cfg.pricingRules[0] ?? {
    id: "general",
    scope: {},
    enabled: true,
    sourceDeliveryType: "standard" as const,
  };
  rule.markupPercent = d.markupPercent;
  // Saving an explicit flat markup switches banded pricing off — the operator
  // chose a single percent. "Reset" restores the banded defaults.
  delete rule.markupBands;
  rule.minAsks = d.minAsks;
  rule.rounding = {
    mode: d.roundingMode,
    ...(d.increment != null ? { increment: d.increment } : {}),
  };
  // VAT is added on top ONLY when the operator sets a rate here; 0 means the
  // markup is the total uplift (VAT inside the price) — the banded default.
  rule.tax = { priceIncludesVat: d.vatRatePercent > 0, vatRatePercent: d.vatRatePercent };
  if (cfg.pricingRules.length === 0) cfg.pricingRules.push(rule);

  try {
    await saveActiveConfig(cfg);
    return { ok: true, summary: pricingSummary(cfg) };
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : String(e) };
  }
}
