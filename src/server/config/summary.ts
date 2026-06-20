import type { AppConfig, MarkupTier } from "@core/config";

export type RoundingMode = "none" | "integer" | "charm" | "nearest";

export interface PricingSummary {
  markupPercent: number | null;
  markupTiers: MarkupTier[] | null; // non-null when dynamic markup is enabled
  vatRatePercent: number | null;
  roundingMode: RoundingMode | null;
  increment: number | null;
  minAsks: number | null;
  hasGuardrail: boolean;
}

/** A compact view of the active pricing for the UI (reads the first rule). */
export function pricingSummary(cfg: AppConfig): PricingSummary {
  const r = cfg.pricingRules[0];
  const tiers = r?.markupTiers;
  return {
    markupPercent: r?.markupPercent ?? null,
    markupTiers: tiers && tiers.length ? tiers : null,
    vatRatePercent: r?.tax?.vatRatePercent ?? null,
    roundingMode: r?.rounding?.mode ?? null,
    increment: r?.rounding?.increment ?? null,
    minAsks: r?.minAsks ?? null,
    hasGuardrail: cfg.pricingRules.some((x) => x.maxDeltaPercent != null),
  };
}
