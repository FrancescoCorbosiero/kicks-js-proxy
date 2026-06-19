import { describe, it, expect } from "vitest";
import { resolveEffectiveRule } from "../config";
import type { AppConfig, ScopedPricingRule } from "../config";
import type { SourceProduct, SourceVariant } from "../core-spine";

const product: SourceProduct = {
  stockxId: "p1",
  sku: "CT8012-047",
  title: "Air Jordan 1 Retro High",
  brand: "Jordan",
  image: "",
  market: "IT",
  currency: "EUR",
  variants: [],
};
const variant: SourceVariant = {
  stockxVariantId: "v1",
  sizeLabel: "9",
  sizeType: "us m",
  offers: [],
};

function makeConfig(rules: ScopedPricingRule[]): AppConfig {
  return {
    source: {
      market: "IT",
      defaultDeliveryType: "standard",
      batchChunkSize: 50,
      cacheTtlSeconds: 900,
      query: { sort: "release_date", limit: 10, display: { traits: true, variants: true, identifiers: true, prices: true } },
    },
    pricingRules: rules,
    matching: { strategyOrder: ["upc", "skuPattern", "manual"], skuTemplate: "{sku}" },
    apply: {
      includeActions: ["update"],
      dryRunByDefault: true,
      requireApprovalAboveDeltaPercent: 25,
      concurrency: 3,
      wooBatchSize: 100,
      retry: { attempts: 4, backoffMs: 500 },
      schedule: null,
    },
    connection: { kicksDbApiKey: "x", woo: { baseUrl: "https://s", consumerKey: "k", consumerSecret: "s" }, marketToCurrency: { IT: "EUR" } },
  };
}

const rule = (r: Partial<ScopedPricingRule> & { id: string }): ScopedPricingRule => ({
  scope: {},
  enabled: true,
  ...r,
});

describe("resolveEffectiveRule", () => {
  it("returns null when no rule matches", () => {
    const cfg = makeConfig([rule({ id: "a", scope: { brand: "Adidas" }, markupPercent: 10 })]);
    expect(resolveEffectiveRule(product, variant, cfg)).toBeNull();
  });

  it("returns null when a rule matches but none sets a markup", () => {
    const cfg = makeConfig([rule({ id: "a", scope: {}, floor: 50 })]);
    expect(resolveEffectiveRule(product, variant, cfg)).toBeNull();
  });

  it("ignores disabled rules", () => {
    const cfg = makeConfig([rule({ id: "a", scope: {}, markupPercent: 10, enabled: false })]);
    expect(resolveEffectiveRule(product, variant, cfg)).toBeNull();
  });

  it("more-specific rule overrides markup, less-specific fills the rest", () => {
    const cfg = makeConfig([
      rule({ id: "general", scope: {}, markupPercent: 10, floor: 50, rounding: { mode: "charm", increment: 0.99 } }),
      rule({ id: "byBrand", scope: { brand: "Jordan" }, markupPercent: 25 }),
    ]);
    const eff = resolveEffectiveRule(product, variant, cfg)!;
    expect(eff.markupPercent).toBe(25); // specific wins
    expect(eff.floor).toBe(50); // inherited from general
    expect(eff.rounding).toEqual({ mode: "charm", increment: 0.99 }); // inherited
  });

  it("defaults sourceDeliveryType from source config when unset", () => {
    const cfg = makeConfig([rule({ id: "g", scope: {}, markupPercent: 10 })]);
    const eff = resolveEffectiveRule(product, variant, cfg)!;
    expect(eff.sourceDeliveryType).toBe("standard");
  });

  it("respects size range scoping", () => {
    const cfg = makeConfig([
      rule({ id: "g", scope: {}, markupPercent: 10 }),
      rule({ id: "big", scope: { sizeMin: 12 }, markupPercent: 30 }),
    ]);
    // variant size 9 -> big rule does not apply
    expect(resolveEffectiveRule(product, variant, cfg)!.markupPercent).toBe(10);
    const big = { ...variant, sizeLabel: "13" };
    expect(resolveEffectiveRule(product, big, cfg)!.markupPercent).toBe(30);
  });
});
