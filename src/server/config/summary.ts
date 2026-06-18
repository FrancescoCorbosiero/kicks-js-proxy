import type { AppConfig } from "@core/config";

export type RoundingMode = "none" | "integer" | "charm" | "nearest";

export interface PricingSummary {
  markupPercent: number | null;
  vatRatePercent: number | null;
  roundingMode: RoundingMode | null;
  increment: number | null;
  minAsks: number | null;
  hasGuardrail: boolean;
}

/** A compact view of the active pricing for the UI (reads the first rule). */
export function pricingSummary(cfg: AppConfig): PricingSummary {
  const r = cfg.pricingRules[0];
  return {
    markupPercent: r?.markupPercent ?? null,
    vatRatePercent: r?.tax?.vatRatePercent ?? null,
    roundingMode: r?.rounding?.mode ?? null,
    increment: r?.rounding?.increment ?? null,
    minAsks: r?.minAsks ?? null,
    hasGuardrail: cfg.pricingRules.some((x) => x.maxDeltaPercent != null),
  };
}
