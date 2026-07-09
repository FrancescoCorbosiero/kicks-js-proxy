import { describe, it, expect } from "vitest";
import {
  emptyOverrides,
  normalizeOverrides,
  withGlobalSaleRule,
  withProductSaleRule,
  withVariationPrice,
  followSaleRuleFor,
  globalFollowSaleRule,
  manualPriceFor,
} from "./model";

describe("overrides model", () => {
  it("defaults to following the sale rule and no manual price", () => {
    const o = emptyOverrides();
    expect(followSaleRuleFor(o, "FV5029-010")).toBe(true);
    expect(globalFollowSaleRule(o)).toBe(true);
    expect(manualPriceFor(o, "FV5029-010", "43")).toBeNull();
  });

  it("keys product overrides case-insensitively by SKU", () => {
    const o = withProductSaleRule(emptyOverrides(), "fv5029-010", false);
    expect(followSaleRuleFor(o, "FV5029-010")).toBe(false);
  });

  it("global sale-rule applies to every product (bulk ignore discounts)", () => {
    const o = withGlobalSaleRule(emptyOverrides(), false);
    expect(globalFollowSaleRule(o)).toBe(false);
    expect(followSaleRuleFor(o, "FV5029-010")).toBe(false);
    expect(followSaleRuleFor(o, "DZ5485-612")).toBe(false);
  });

  it("a product override wins over the global default", () => {
    let o = withGlobalSaleRule(emptyOverrides(), false); // bulk: reprice discounts
    o = withProductSaleRule(o, "FV5029-010", true); // but keep this one's discounts
    expect(followSaleRuleFor(o, "FV5029-010")).toBe(true);
    expect(followSaleRuleFor(o, "DZ5485-612")).toBe(false); // still follows the global
  });

  it("clears the global sale-rule back to the default", () => {
    let o = withGlobalSaleRule(emptyOverrides(), false);
    o = withGlobalSaleRule(o, null);
    expect(globalFollowSaleRule(o)).toBe(true);
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
    expect(normalizeOverrides(null)).toEqual({ global: {}, products: {}, variations: {} });
    expect(normalizeOverrides({ products: { A: { followSaleRule: false } } })).toEqual({
      global: {},
      products: { A: { followSaleRule: false } },
      variations: {},
    });
  });
});
