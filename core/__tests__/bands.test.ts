import { describe, it, expect } from "vitest";
import { computePrice, type SourceVariant, type SourceProduct } from "../core-spine";
import {
  markupForAsk,
  resolveEffectiveRule,
  sortMarkupBands,
  type AppConfig,
  type EffectivePricingRule,
  type MarkupBand,
} from "../config";

const BANDS: MarkupBand[] = [
  { upTo: 150, percent: 35 },
  { upTo: 300, percent: 30 },
  { upTo: 500, percent: 25 },
  { upTo: null, percent: 19 },
];

function rule(overrides: Partial<EffectivePricingRule> = {}): EffectivePricingRule {
  return {
    sourceDeliveryType: "standard",
    markupPercent: 19,
    markupBands: BANDS,
    rounding: { mode: "none" },
    tax: { priceIncludesVat: false, vatRatePercent: 0 },
    ...overrides,
  };
}

function variant(ask: number): SourceVariant {
  return {
    stockxVariantId: "v1",
    sizeLabel: "42",
    sizeType: "eu",
    offers: [{ deliveryType: "standard", lowestAsk: ask, asks: 5 }],
  };
}

describe("markupForAsk — dynamic markup by ask band", () => {
  it("picks the band covering the ask", () => {
    expect(markupForAsk(1, rule())).toBe(35);
    expect(markupForAsk(100, rule())).toBe(35);
    expect(markupForAsk(200, rule())).toBe(30);
    expect(markupForAsk(400, rule())).toBe(25);
    expect(markupForAsk(800, rule())).toBe(19);
  });

  it("treats band boundaries as inclusive (≤ upTo)", () => {
    expect(markupForAsk(150, rule())).toBe(35);
    expect(markupForAsk(150.01, rule())).toBe(30);
    expect(markupForAsk(300, rule())).toBe(30);
    expect(markupForAsk(500, rule())).toBe(25);
    expect(markupForAsk(500.01, rule())).toBe(19);
  });

  it("falls back to the flat markupPercent without bands", () => {
    expect(markupForAsk(100, rule({ markupBands: undefined, markupPercent: 17 }))).toBe(17);
  });

  it("sortMarkupBands orders ascending with the unbounded band last", () => {
    const shuffled: MarkupBand[] = [BANDS[3], BANDS[1], BANDS[0], BANDS[2]];
    expect(sortMarkupBands(shuffled)).toEqual(BANDS);
  });
});

describe("computePrice with bands", () => {
  it("applies the band markup to the raw ask (pre-VAT)", () => {
    expect(computePrice(variant(100), rule())).toBe(135); // 100 * 1.35
    expect(computePrice(variant(200), rule())).toBe(260); // 200 * 1.30
    expect(computePrice(variant(400), rule())).toBe(500); // 400 * 1.25
    expect(computePrice(variant(800), rule())).toBe(952); // 800 * 1.19
  });

  it("band selection happens BEFORE VAT — the retail price does not shift bands", () => {
    // 140 ask lands in the 35% band even though 140*1.35*1.22 > 150.
    const withVat = rule({ tax: { priceIncludesVat: true, vatRatePercent: 22 } });
    expect(computePrice(variant(140), withVat)).toBeCloseTo(140 * 1.35 * 1.22, 2);
  });
});

describe("resolveEffectiveRule with bands", () => {
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

  function config(rules: AppConfig["pricingRules"]): AppConfig {
    return {
      source: {
        market: "IT",
        defaultDeliveryType: "standard",
        batchChunkSize: 50,
        cacheTtlSeconds: 900,
        query: { sort: "release_date", limit: 10, display: { traits: true, variants: true, identifiers: true, prices: true } },
      },
      pricingRules: rules,
      matching: { strategyOrder: ["upc"], skuTemplate: "{sku}-{size}" },
      apply: {
        includeActions: ["update"],
        dryRunByDefault: true,
        requireApprovalAboveDeltaPercent: 25,
        concurrency: 3,
        wooBatchSize: 100,
        retry: { attempts: 1, backoffMs: 1 },
        schedule: null,
      },
      connection: { kicksDbApiKey: "", woo: { baseUrl: "", consumerKey: "", consumerSecret: "" }, marketToCurrency: { IT: "EUR" } },
    };
  }

  it("a bands-only rule resolves, using the top band as the flat fallback", () => {
    const resolved = resolveEffectiveRule(
      product,
      variant(100),
      config([{ id: "g", scope: {}, enabled: true, markupBands: BANDS }]),
    );
    expect(resolved).not.toBeNull();
    expect(resolved!.markupPercent).toBe(19); // top band doubles as fallback
    expect(resolved!.markupBands).toEqual(BANDS);
  });

  it("a more specific flat rule overrides the percent but keeps general bands unless it clears them", () => {
    const resolved = resolveEffectiveRule(
      product,
      variant(100),
      config([
        { id: "g", scope: {}, enabled: true, markupBands: BANDS, markupPercent: 19 },
        { id: "nike", scope: { brand: "Nike" }, enabled: true, markupPercent: 10 },
      ]),
    );
    // Field-by-field merge: bands still present (they win in computePrice);
    // the specific flat percent only changes the fallback.
    expect(resolved!.markupPercent).toBe(10);
    expect(resolved!.markupBands).toEqual(BANDS);
  });
});
