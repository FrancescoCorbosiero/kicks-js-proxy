import { describe, it, expect } from "vitest";
import {
  buildPlan,
  type SourceProduct,
  type SourceVariant,
  type VariantMapping,
} from "../core-spine";
import type { AppConfig } from "../config";

/**
 * Finite-supply planning (manageStockFromSource): quantity drift alone makes a
 * row actionable, sold-out sizes zero their store stock instead of being
 * silently skipped (the oversell hole), and KicksDB products never touch stock.
 */

function config(): AppConfig {
  return {
    source: {
      market: "IT",
      defaultDeliveryType: "standard",
      batchChunkSize: 50,
      cacheTtlSeconds: 900,
      query: { sort: "release_date", limit: 10, display: { traits: true, variants: true, identifiers: true, prices: true } },
    },
    pricingRules: [
      // The GS passthrough shape: price flows verbatim, qty 0 unpriceable.
      { id: "gs", scope: {}, enabled: true, sourceDeliveryType: "standard", markupPercent: 0, minAsks: 1, rounding: { mode: "none" }, tax: { priceIncludesVat: false, vatRatePercent: 0 } },
    ],
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

function variant(id: string, price: number, qty: number): SourceVariant {
  return {
    stockxVariantId: id,
    sizeLabel: String(36 + Number(id.slice(-1))),
    sizeType: "eu",
    offers: [{ deliveryType: "standard", lowestAsk: price, asks: qty }],
  };
}

function product(variants: SourceVariant[]): SourceProduct {
  return {
    stockxId: "gs:X",
    sku: "X-1",
    title: "T",
    brand: "B",
    image: "",
    market: "IT",
    currency: "EUR",
    source: "goldensneakers",
    variants,
  };
}

function mapping(id: string, over: Partial<VariantMapping> = {}): [string, VariantMapping] {
  return [
    id,
    { stockxVariantId: id, storeProductId: 1, storeVariationId: 10, currentPrice: 72, ...over },
  ];
}

const managed = { manageStockFromSource: true };

describe("buildPlan with manageStockFromSource", () => {
  it("stock drift alone makes a priced row an update carrying the quantity", () => {
    const plan = buildPlan(
      product([variant("v1", 72, 2)]),
      config(),
      new Map([mapping("v1", { currentStock: 5 })]),
      managed,
    );
    expect(plan.items[0].action).toBe("update");
    expect(plan.items[0].reason).toBe("stock change");
    expect(plan.items[0].stockQuantity).toBe(2);
  });

  it("unmanaged store stock counts as drift — finite supply must be managed", () => {
    const plan = buildPlan(
      product([variant("v1", 72, 1)]),
      config(),
      new Map([mapping("v1", { currentStock: null })]),
      managed,
    );
    expect(plan.items[0].action).toBe("update");
    expect(plan.items[0].stockQuantity).toBe(1);
  });

  it("a sold-out size becomes a STOCK-ONLY update to qty 0 (the oversell fix)", () => {
    const plan = buildPlan(
      product([variant("v1", 72, 0)]), // qty 0 -> unpriceable (minAsks 1)
      config(),
      new Map([mapping("v1", { currentStock: 1 })]),
      managed,
    );
    expect(plan.items[0].action).toBe("update");
    expect(plan.items[0].proposedPrice).toBeNull();
    expect(plan.items[0].stockQuantity).toBe(0);
    expect(plan.items[0].reason).toContain("stock only");
  });

  it("a discounted size keeps its sale price but still syncs stock", () => {
    const plan = buildPlan(
      product([variant("v1", 72, 3)]),
      config(),
      new Map([mapping("v1", { saleActive: true, currentStock: 1 })]),
      managed,
    );
    expect(plan.items[0].action).toBe("update");
    expect(plan.items[0].proposedPrice).toBeNull(); // price untouched
    expect(plan.items[0].stockQuantity).toBe(3);
  });

  it("noop when price AND quantity already match", () => {
    const plan = buildPlan(
      product([variant("v1", 72, 2)]),
      config(),
      new Map([mapping("v1", { currentStock: 2 })]),
      managed,
    );
    expect(plan.items[0].action).toBe("noop");
  });

  it("KicksDB products (default options) never carry stock", () => {
    const plan = buildPlan(
      product([variant("v1", 72, 2)]),
      config(),
      new Map([mapping("v1", { currentStock: 5 })]),
      {}, // manageStockFromSource off
    );
    expect(plan.items[0].action).toBe("noop"); // price matches; stock ignored
    expect(plan.items[0].stockQuantity).toBeUndefined();
  });
});
