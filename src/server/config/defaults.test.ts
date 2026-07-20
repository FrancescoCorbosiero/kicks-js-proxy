import { describe, it, expect } from "vitest";
import type { SourceProduct, SourceVariant } from "@core/core-spine";
import { computePrice } from "@core/core-spine";
import { resolveEffectiveRule } from "@core/config";
import { buildDefaultConfig } from "./defaults";

/**
 * Regression guard for the agreed pricing semantics: the band is the TOTAL
 * shelf uplift over the raw KicksDB ask — VAT is inside the price, never
 * stacked on top of the markup.
 */

const product: SourceProduct = {
  stockxId: "x",
  sku: "AA-1",
  title: "Test",
  brand: "Nike",
  image: "",
  market: "IT",
  currency: "EUR",
  variants: [],
};

function variant(ask: number): SourceVariant {
  return {
    stockxVariantId: "v1",
    sizeLabel: "42",
    sizeType: "eu",
    offers: [{ deliveryType: "standard", lowestAsk: ask, asks: 5 }],
  };
}

function priceFor(ask: number): number | null {
  const config = buildDefaultConfig({
    kicksDbApiKey: "",
    woo: { baseUrl: "", consumerKey: "", consumerSecret: "" },
    marketToCurrency: { IT: "EUR" },
  });
  const rule = resolveEffectiveRule(product, variant(ask), config);
  expect(rule).not.toBeNull();
  return computePrice(variant(ask), rule!);
}

describe("default pricing — bands are the total uplift, no VAT stacking", () => {
  it("prices each band as ask × (1+band%) with charm .99, nothing more", () => {
    expect(priceFor(100)).toBe(135.99); // 35% band: 135 → charm
    expect(priceFor(200)).toBe(260.99); // 30% band
    expect(priceFor(400)).toBe(500.99); // 25% band
    expect(priceFor(800)).toBe(952.99); // 19% band
  });

  it("never multiplies by a VAT rate", () => {
    // If VAT-on-top regressed, 100 would price at 135 × 1.22 ≈ 164.99.
    const p = priceFor(100)!;
    expect(p).toBeLessThan(140);
  });
});
