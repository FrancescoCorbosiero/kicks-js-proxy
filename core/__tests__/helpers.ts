import type { AppConfig, ScopedPricingRule } from "../config";
import type { SourceProduct, SourceVariant } from "../core-spine";

export function makeConfig(rules: ScopedPricingRule[]): AppConfig {
  return {
    source: {
      market: "IT",
      defaultDeliveryType: "standard",
      batchChunkSize: 50,
      cacheTtlSeconds: 900,
      query: {
        sort: "release_date",
        limit: 10,
        display: { traits: true, variants: true, identifiers: true, prices: true },
      },
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
    connection: {
      kicksDbApiKey: "x",
      woo: { baseUrl: "https://s", consumerKey: "k", consumerSecret: "s" },
      marketToCurrency: { IT: "EUR" },
    },
  };
}

export const rule = (r: Partial<ScopedPricingRule> & { id: string }): ScopedPricingRule => ({
  scope: {},
  enabled: true,
  ...r,
});

export function makeVariant(id: string, lowestAsk: number, asks = 5): SourceVariant {
  return {
    stockxVariantId: id,
    sizeLabel: "9",
    sizeType: "us m",
    offers: [{ deliveryType: "standard", lowestAsk, asks }],
  };
}

export function makeProduct(variants: SourceVariant[]): SourceProduct {
  return {
    stockxId: "p1",
    sku: "CT8012-047",
    title: "Air Jordan 1 Retro High",
    brand: "Jordan",
    image: "",
    market: "IT",
    currency: "EUR",
    variants,
  };
}
