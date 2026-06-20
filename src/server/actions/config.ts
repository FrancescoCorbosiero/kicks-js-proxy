"use server";

import { z } from "zod";
import { clearConfig, getActiveConfig, saveActiveConfig } from "@/server/config/repo";
import { pricingSummary, type PricingSummary } from "@/server/config/summary";

/** Wipe the stored config and re-seed from defaults.ts; return the new summary. */
export async function resetPricingToDefaults(): Promise<PricingSummary> {
  await clearConfig();
  return pricingSummary(await getActiveConfig());
}

const MarkupTierSchema = z.object({
  upTo: z.number().positive().nullable(), // null = open-ended top band
  markupPercent: z.number().min(0).max(1000),
});

const PricingInputSchema = z.object({
  markupPercent: z.number().min(0).max(1000),
  // When present & non-empty, dynamic markup is enabled and overrides the flat
  // markupPercent. Omitted or empty => flat markup (dynamic markup turned off).
  markupTiers: z.array(MarkupTierSchema).optional(),
  vatRatePercent: z.number().min(0).max(100),
  roundingMode: z.enum(["none", "integer", "charm", "nearest"]),
  increment: z.number().min(0).optional(),
  minAsks: z.number().int().min(0),
});
export type PricingInput = z.infer<typeof PricingInputSchema>;

/** Sort tiers by band (ascending), keeping the open-ended top band (null) last. */
function normalizeTiers(tiers: { upTo: number | null; markupPercent: number }[]) {
  return [...tiers].sort((a, b) => (a.upTo ?? Infinity) - (b.upTo ?? Infinity));
}

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
  // Dynamic markup: a non-empty schedule enables it; empty/omitted clears it
  // (back to flat markupPercent).
  if (d.markupTiers && d.markupTiers.length > 0) rule.markupTiers = normalizeTiers(d.markupTiers);
  else delete rule.markupTiers;
  rule.minAsks = d.minAsks;
  rule.rounding = {
    mode: d.roundingMode,
    ...(d.increment != null ? { increment: d.increment } : {}),
  };
  rule.tax = { priceIncludesVat: true, vatRatePercent: d.vatRatePercent };
  if (cfg.pricingRules.length === 0) cfg.pricingRules.push(rule);

  try {
    await saveActiveConfig(cfg);
    return { ok: true, summary: pricingSummary(cfg) };
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : String(e) };
  }
}
