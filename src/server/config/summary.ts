import type { AppConfig, MarkupBand } from "@core/config";
import { sortMarkupBands } from "@core/config";

export type RoundingMode = "none" | "integer" | "charm" | "nearest";

export interface PricingSummary {
  markupPercent: number | null;
  /** Price-banded markup (ordered ascending); when set it wins over the flat percent. */
  markupBands: MarkupBand[] | null;
  vatRatePercent: number | null;
  roundingMode: RoundingMode | null;
  increment: number | null;
  minAsks: number | null;
  /** Anti-churn threshold: price drifts of at most this percent are not written. */
  minDeltaPercent: number | null;
  hasGuardrail: boolean;
}

/** A compact view of the active pricing for the UI (reads the first rule). */
export function pricingSummary(cfg: AppConfig): PricingSummary {
  const r = cfg.pricingRules[0];
  return {
    markupPercent: r?.markupPercent ?? null,
    markupBands: r?.markupBands?.length ? sortMarkupBands(r.markupBands) : null,
    // Only report VAT when it is actually ADDED on top — a rate that sits
    // inside the price would make the chip lie about the math.
    vatRatePercent: r?.tax?.priceIncludesVat ? (r.tax.vatRatePercent ?? null) : null,
    roundingMode: r?.rounding?.mode ?? null,
    increment: r?.rounding?.increment ?? null,
    minAsks: r?.minAsks ?? null,
    minDeltaPercent: r?.minDeltaPercent ?? null,
    hasGuardrail: cfg.pricingRules.some((x) => x.maxDeltaPercent != null),
  };
}
