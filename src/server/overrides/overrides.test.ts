import { describe, it, expect } from "vitest";
import {
  emptyOverrides,
  normalizeOverrides,
  withProductSaleRule,
  withVariationPrice,
  followSaleRuleFor,
  manualPriceFor,
} from "./model";

describe("overrides model", () => {
  it("defaults to following the sale rule and no manual price", () => {
    const o = emptyOverrides();
    expect(followSaleRuleFor(o, "FV5029-010")).toBe(true);
    expect(manualPriceFor(o, "FV5029-010", "43")).toBeNull();
  });

  it("keys product overrides case-insensitively by SKU", () => {
    const o = withProductSaleRule(emptyOverrides(), "fv5029-010", false);
    expect(followSaleRuleFor(o, "FV5029-010")).toBe(false);
  });

  it("clears a product override when passed null (back to default)", () => {
    let o = withProductSaleRule(emptyOverrides(), "FV5029-010", false);
    o = withProductSaleRule(o, "FV5029-010", null);
    expect(followSaleRuleFor(o, "FV5029-010")).toBe(true);
    expect(o.products["FV5029-010"]).toBeUndefined();
  });

  it("stores and reads a manual price by parent SKU + EU size", () => {
    const o = withVariationPrice(emptyOverrides(), "FV5029-010", "43", 299);
    expect(manualPriceFor(o, "FV5029-010", "43")).toBe(299);
    expect(manualPriceFor(o, "FV5029-010", "44")).toBeNull(); // other size unaffected
  });

  it("clears a manual price when passed null", () => {
    let o = withVariationPrice(emptyOverrides(), "FV5029-010", "43", 299);
    o = withVariationPrice(o, "FV5029-010", "43", null);
    expect(manualPriceFor(o, "FV5029-010", "43")).toBeNull();
  });

  it("never mutates the input blob", () => {
    const base = emptyOverrides();
    withProductSaleRule(base, "X", false);
    withVariationPrice(base, "X", "43", 1);
    expect(base.products).toEqual({});
    expect(base.variations).toEqual({});
  });

  it("normalizes a missing or malformed blob", () => {
    expect(normalizeOverrides(null)).toEqual({ products: {}, variations: {} });
    expect(normalizeOverrides({ products: { A: { followSaleRule: false } } })).toEqual({
      products: { A: { followSaleRule: false } },
      variations: {},
    });
  });
});
