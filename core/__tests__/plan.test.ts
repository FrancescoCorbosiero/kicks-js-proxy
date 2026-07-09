import { describe, it, expect } from "vitest";
import { buildPlan } from "../core-spine";
import type { SourceVariant, VariantMapping } from "../core-spine";
import { makeConfig, makeProduct, makeVariant, rule } from "./helpers";

const noopRounding = { mode: "none" as const };

// markup 0, no VAT, no rounding -> proposed price == lowestAsk, easy to assert.
const flatRule = (extra: Partial<Parameters<typeof rule>[0]> = {}) =>
  rule({ id: "g", scope: {}, markupPercent: 0, rounding: noopRounding, ...extra });

const mapping = (variationId: number, currentPrice: number | null): VariantMapping => ({
  stockxVariantId: "ignored",
  storeProductId: 100,
  storeVariationId: variationId,
  currentPrice,
});

describe("buildPlan", () => {
  it("skip — no pricing rule matches", () => {
    const cfg = makeConfig([rule({ id: "a", scope: { brand: "Adidas" }, markupPercent: 10 })]);
    const plan = buildPlan(makeProduct([makeVariant("v1", 100)]), cfg, new Map());
    expect(plan.items[0]).toMatchObject({ action: "skip", reason: "no pricing rule matches" });
  });

  it("skip — no priceable offer", () => {
    const cfg = makeConfig([flatRule()]);
    const v: SourceVariant = { stockxVariantId: "v1", sizeLabel: "9", sizeType: "us m", offers: [] };
    const plan = buildPlan(makeProduct([v]), cfg, new Map());
    expect(plan.items[0]).toMatchObject({ action: "skip", reason: "no priceable offer" });
  });

  it("create — priceable but not yet on the store", () => {
    const cfg = makeConfig([flatRule()]);
    const plan = buildPlan(makeProduct([makeVariant("v1", 100)]), cfg, new Map());
    expect(plan.items[0]).toMatchObject({
      action: "create",
      proposedPrice: 100,
      storeVariationId: null,
    });
  });

  it("noop — current price already equals proposed", () => {
    const cfg = makeConfig([flatRule()]);
    const map = new Map([["v1", mapping(11, 100)]]);
    const plan = buildPlan(makeProduct([makeVariant("v1", 100)]), cfg, map);
    expect(plan.items[0].action).toBe("noop");
  });

  it("update — current differs from proposed within delta", () => {
    const cfg = makeConfig([flatRule({ maxDeltaPercent: 40 })]);
    const map = new Map([["v1", mapping(11, 90)]]);
    const plan = buildPlan(makeProduct([makeVariant("v1", 100)]), cfg, map);
    expect(plan.items[0]).toMatchObject({ action: "update", currentPrice: 90, proposedPrice: 100 });
  });

  it("skip — discounted variation is left untouched (sale price wins)", () => {
    const cfg = makeConfig([flatRule()]);
    const map = new Map([["v1", { ...mapping(11, 90), saleActive: true }]]);
    const plan = buildPlan(makeProduct([makeVariant("v1", 100)]), cfg, map);
    expect(plan.items[0].action).toBe("skip");
    expect(plan.items[0].reason).toContain("discounted");
  });

  it("update — followSaleRule:false reprices a discounted variation", () => {
    const cfg = makeConfig([flatRule()]);
    const map = new Map([["v1", { ...mapping(11, 90), saleActive: true }]]);
    const plan = buildPlan(makeProduct([makeVariant("v1", 100)]), cfg, map, {
      followSaleRule: false,
    });
    expect(plan.items[0]).toMatchObject({ action: "update", proposedPrice: 100 });
  });

  it("update — manual price wins over the computed price and locks the row", () => {
    const cfg = makeConfig([flatRule()]);
    const map = new Map([["v1", { ...mapping(11, 90), manualPrice: 250 }]]);
    const plan = buildPlan(makeProduct([makeVariant("v1", 100)]), cfg, map);
    expect(plan.items[0]).toMatchObject({
      action: "update",
      proposedPrice: 250,
      locked: true,
    });
    expect(plan.items[0].reason).toContain("manual");
  });

  it("noop — manual price equal to the current price needs no change", () => {
    const cfg = makeConfig([flatRule()]);
    const map = new Map([["v1", { ...mapping(11, 250), manualPrice: 250 }]]);
    const plan = buildPlan(makeProduct([makeVariant("v1", 100)]), cfg, map);
    expect(plan.items[0]).toMatchObject({ action: "noop", locked: true });
  });

  it("manual price wins even over an active sale and a missing offer", () => {
    const cfg = makeConfig([flatRule()]);
    const noOffer: SourceVariant = { stockxVariantId: "v1", sizeLabel: "9", sizeType: "us m", offers: [] };
    const map = new Map([["v1", { ...mapping(11, 90), saleActive: true, manualPrice: 300 }]]);
    const plan = buildPlan(makeProduct([noOffer]), cfg, map);
    expect(plan.items[0]).toMatchObject({ action: "update", proposedPrice: 300, locked: true });
  });

  it("skip — change exceeds maxDeltaPercent guardrail", () => {
    const cfg = makeConfig([flatRule({ maxDeltaPercent: 5 })]);
    const map = new Map([["v1", mapping(11, 90)]]); // 90 -> 100 is ~11% > 5%
    const plan = buildPlan(makeProduct([makeVariant("v1", 100)]), cfg, map);
    expect(plan.items[0].action).toBe("skip");
    expect(plan.items[0].reason).toContain("maxDeltaPercent");
  });
});
