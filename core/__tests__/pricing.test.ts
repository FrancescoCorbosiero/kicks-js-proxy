import { describe, it, expect } from "vitest";
import { computePrice, roundPrice } from "../core-spine";
import type { SourceVariant } from "../core-spine";
import type { EffectivePricingRule } from "../config";

function variant(offers: SourceVariant["offers"]): SourceVariant {
  return { stockxVariantId: "v1", sizeLabel: "9", sizeType: "us m", offers };
}

const baseRule: EffectivePricingRule = {
  sourceDeliveryType: "standard",
  markupPercent: 0,
  rounding: { mode: "none" },
  tax: { priceIncludesVat: false, vatRatePercent: 0 },
};

const std = (lowestAsk: number, asks = 5) =>
  variant([{ deliveryType: "standard", lowestAsk, asks }]);

describe("roundPrice", () => {
  it("none -> 2 decimals", () => {
    expect(roundPrice(134.2059, { mode: "none" })).toBe(134.21);
  });
  it("integer -> nearest whole", () => {
    expect(roundPrice(134.2, { mode: "integer" })).toBe(134);
  });
  it("charm -> floor + .99 tail", () => {
    expect(roundPrice(134.2, { mode: "charm", increment: 0.99 })).toBe(134.99);
    expect(roundPrice(134.2, { mode: "charm", increment: 0.95 })).toBe(134.95);
  });
  it("nearest -> multiple of increment", () => {
    expect(roundPrice(134.2, { mode: "nearest", increment: 5 })).toBe(135);
    expect(roundPrice(132, { mode: "nearest", increment: 10 })).toBe(130);
  });
});

describe("computePrice", () => {
  it("applies markup", () => {
    expect(computePrice(std(100), { ...baseRule, markupPercent: 10 })).toBe(110);
  });

  it("applies VAT on top of the marked-up net", () => {
    const rule = {
      ...baseRule,
      markupPercent: 10,
      tax: { priceIncludesVat: true, vatRatePercent: 22 },
    };
    // 100 * 1.10 = 110 ; 110 * 1.22 = 134.2
    expect(computePrice(std(100), rule)).toBe(134.2);
  });

  it("order is markup -> floor -> VAT -> rounding", () => {
    const rule: EffectivePricingRule = {
      sourceDeliveryType: "standard",
      markupPercent: 0,
      floor: 100, // floor on the net, before VAT
      tax: { priceIncludesVat: true, vatRatePercent: 22 },
      rounding: { mode: "charm", increment: 0.99 },
    };
    // ask 50 -> net 50 -> floored to 100 -> +22% = 122 -> charm = 122.99
    expect(computePrice(std(50), rule)).toBe(122.99);
  });

  it("skips when liquidity is below minAsks", () => {
    expect(computePrice(std(100, 0), { ...baseRule, markupPercent: 10, minAsks: 1 })).toBeNull();
  });

  it("skips when no offer matches the delivery type", () => {
    const v = variant([{ deliveryType: "express_standard", lowestAsk: 100, asks: 5 }]);
    expect(computePrice(v, { ...baseRule, markupPercent: 10 })).toBeNull();
  });
});

describe("distribution guard (outlierFloorPercent)", () => {
  const guarded: EffectivePricingRule = {
    sourceDeliveryType: "standard",
    markupPercent: 30,
    rounding: { mode: "none" },
    tax: { priceIncludesVat: false, vatRatePercent: 0 },
    outlierFloorPercent: 60,
  };

  it("lifts an absurdly low ask to the floor before markup", () => {
    // Median ask 115 → floor 69; the glitched 44 ask prices as if it were 69.
    expect(computePrice(std(44), guarded, { medianAsk: 115 })).toBe(69 * 1.3);
  });

  it("leaves normal and expensive sizes untouched", () => {
    expect(computePrice(std(100), guarded, { medianAsk: 115 })).toBe(130);
    expect(computePrice(std(180), guarded, { medianAsk: 115 })).toBe(234);
  });

  it("is inert without a median, with 0 percent, or when unset", () => {
    expect(computePrice(std(44), guarded, {})).toBe(44 * 1.3);
    expect(computePrice(std(44), guarded, { medianAsk: null })).toBe(44 * 1.3);
    expect(computePrice(std(44), { ...guarded, outlierFloorPercent: 0 }, { medianAsk: 115 })).toBe(44 * 1.3);
    expect(computePrice(std(44), { ...guarded, outlierFloorPercent: undefined }, { medianAsk: 115 })).toBe(44 * 1.3);
  });

  it("banded markup reads the LIFTED ask, so the outlier lands in the right band", () => {
    const banded: EffectivePricingRule = {
      ...guarded,
      markupBands: [
        { upTo: 50, percent: 50 },
        { upTo: null, percent: 30 },
      ],
    };
    // Without the guard the 44 ask would take the ≤50 band (50%); lifted to 69
    // it takes the top band like its siblings.
    expect(computePrice(std(44), banded, { medianAsk: 115 })).toBe(69 * 1.3);
  });
});

describe("medianTierAsk", () => {
  it("median across sizes with asks; null under 3 asks", async () => {
    const { medianTierAsk } = await import("../core-spine");
    const product = {
      stockxId: "p", sku: "S", title: "", brand: "", image: "", market: "IT", currency: "EUR",
      variants: [std(100), std(120), std(44), std(160), variant([])],
    };
    expect(medianTierAsk(product, "standard")).toBe(110); // 44,100,120,160 → (100+120)/2
    const thin = { ...product, variants: [std(100), std(120)] };
    expect(medianTierAsk(thin, "standard")).toBeNull();
  });
});

describe("guaranteed minimum margin (minMarginFixed)", () => {
  const rule = (extra: Partial<EffectivePricingRule>): EffectivePricingRule => ({
    sourceDeliveryType: "standard",
    markupPercent: 35,
    rounding: { mode: "none" },
    tax: { priceIncludesVat: false, vatRatePercent: 0 },
    ...extra,
  });

  it("lifts cheap-ask prices to ask + margin; the occasion stays listed, never at a loss", () => {
    // 35% of a 44€ ask is 15.40€ of margin — under the ~20€ fixed sourcing
    // costs. With minMarginFixed 20 the price becomes 64 instead of 59.40.
    expect(computePrice(std(44), rule({ minMarginFixed: 20 }))).toBe(64);
  });

  it("does nothing once the percent margin already covers it", () => {
    // 35% of 100 = 35€ ≥ 20€ → untouched.
    expect(computePrice(std(100), rule({ minMarginFixed: 20 }))).toBe(135);
  });

  it("applies on top of fixed-margin rules too", () => {
    expect(computePrice(std(50), rule({ markupFixed: 3, minMarginFixed: 20 }))).toBe(70);
  });

  it("is inert at 0 or when unset", () => {
    expect(computePrice(std(44), rule({ minMarginFixed: 0 }))).toBe(59.4);
    expect(computePrice(std(44), rule({}))).toBe(59.4);
  });
});
