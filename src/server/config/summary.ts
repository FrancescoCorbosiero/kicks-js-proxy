import type { AppConfig } from "@core/config";

export interface PricingSummary {
  markupPercent: number | null;
  vatRatePercent: number | null;
  rounding: string | null;
  hasGuardrail: boolean;
}

/** A compact view of the active pricing for the UI (reads the first rule). */
export function pricingSummary(cfg: AppConfig): PricingSummary {
  const r = cfg.pricingRules[0];
  return {
    markupPercent: r?.markupPercent ?? null,
    vatRatePercent: r?.tax?.vatRatePercent ?? null,
    rounding: r?.rounding ? `${r.rounding.mode}${r.rounding.increment ? ` ${r.rounding.increment}` : ""}` : null,
    hasGuardrail: cfg.pricingRules.some((x) => x.maxDeltaPercent != null),
  };
}
