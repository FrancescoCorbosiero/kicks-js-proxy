import { describe, it, expect } from "vitest";
import type {
  Plan,
  SourceProduct,
  StorePort,
  VariantMapping,
} from "@core/core-spine";
import type { AppConfig } from "@core/config";
import { executeApply } from "./executor";

function config(approvalThreshold: number): AppConfig {
  return {
    source: {
      market: "IT",
      defaultDeliveryType: "standard",
      batchChunkSize: 50,
      cacheTtlSeconds: 900,
      query: { sort: "release_date", limit: 10, display: { traits: true, variants: true, identifiers: true, prices: true } },
    },
    pricingRules: [
      {
        id: "g",
        scope: {},
        enabled: true,
        markupPercent: 0,
        rounding: { mode: "none" },
        tax: { priceIncludesVat: false, vatRatePercent: 0 },
      },
    ],
    matching: { strategyOrder: ["upc"], skuTemplate: "{sku}" },
    apply: {
      includeActions: ["update"],
      dryRunByDefault: true,
      requireApprovalAboveDeltaPercent: approvalThreshold,
      concurrency: 1,
      wooBatchSize: 100,
      retry: { attempts: 1, backoffMs: 1 },
      schedule: null,
    },
    connection: { kicksDbApiKey: "", woo: { baseUrl: "", consumerKey: "", consumerSecret: "" }, marketToCurrency: {} },
  };
}

function product(ask: number): SourceProduct {
  return {
    stockxId: "p1",
    sku: "SKU1",
    title: "T",
    brand: "B",
    image: "",
    market: "IT",
    currency: "EUR",
    variants: [
      { stockxVariantId: "v1", sizeLabel: "9", sizeType: "us m", offers: [{ deliveryType: "standard", lowestAsk: ask, asks: 5 }] },
    ],
  };
}

function fakeStore(current: number | null) {
  const applied: Plan[] = [];
  const mapping: VariantMapping = {
    stockxVariantId: "v1",
    storeProductId: 1,
    storeVariationId: 11,
    currentPrice: current,
  };
  const store: StorePort = {
    async resolveMappings() {
      return new Map([["v1", mapping]]);
    },
    async applyPrices(plan) {
      applied.push(plan);
      return { updated: plan.items.length, failed: [] };
    },
    async upsertProduct() {
      return { storeProductId: 1 };
    },
  };
  return { store, applied };
}

const target = { product: product(100), selected: ["v1"] };

describe("executeApply", () => {
  it("writes the update to the store on a real run", async () => {
    const { store, applied } = fakeStore(90); // 90 -> 100
    const out = await executeApply(store, config(1000), [target], { dryRun: false, approved: false });
    expect(out.updated).toBe(1);
    expect(applied).toHaveLength(1);
  });

  it("dry run computes the change but writes nothing", async () => {
    const { store, applied } = fakeStore(90);
    const out = await executeApply(store, config(1000), [target], { dryRun: true, approved: false });
    expect(out.updated).toBe(1);
    expect(applied).toHaveLength(0);
  });

  it("is idempotent: current == proposed yields a noop and zero writes", async () => {
    const { store, applied } = fakeStore(100); // already 100
    const out = await executeApply(store, config(1000), [target], { dryRun: false, approved: false });
    expect(out.updated).toBe(0);
    expect(out.skipped).toBe(1);
    expect(applied).toHaveLength(0);
  });

  it("holds a change above the approval threshold until approved", async () => {
    const heldRun = await executeApply(fakeStore(90).store, config(5), [target], { dryRun: false, approved: false });
    expect(heldRun.heldForApproval).toBe(1);
    expect(heldRun.updated).toBe(0);

    const { store, applied } = fakeStore(90);
    const approvedRun = await executeApply(store, config(5), [target], { dryRun: false, approved: true });
    expect(approvedRun.updated).toBe(1);
    expect(applied).toHaveLength(1);
  });

  it("counts create rows (no mapping) as pending import", async () => {
    const store: StorePort = {
      async resolveMappings() {
        return new Map();
      },
      async applyPrices(plan) {
        return { updated: plan.items.length, failed: [] };
      },
      async upsertProduct() {
        return { storeProductId: 1 };
      },
    };
    const out = await executeApply(store, config(1000), [target], { dryRun: false, approved: false });
    expect(out.createPending).toBe(1);
    expect(out.updated).toBe(0);
  });
});
