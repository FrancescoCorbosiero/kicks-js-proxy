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
