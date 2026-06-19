import { describe, it, expect } from "vitest";
import { WooStoreAdapter } from "../core-spine";
import type { Plan, PlanItem } from "../core-spine";

// Minimal fake matching the WooClient shape ({ get, post }); records POST calls.
function fakeWoo() {
  const calls: { path: string; body: unknown }[] = [];
  const client = {
    get: async <T>() => ({}) as T,
    post: async <T>(path: string, body: unknown) => {
      calls.push({ path, body });
      return {} as T;
    },
  };
  return { client, calls };
}

const item = (p: Partial<PlanItem> & Pick<PlanItem, "stockxVariantId" | "action">): PlanItem => ({
  sizeLabel: "9",
  storeProductId: null,
  storeVariationId: null,
  currentPrice: null,
  proposedPrice: null,
  ...p,
});

const plan = (items: PlanItem[]): Plan => ({
  sku: "CT8012-047",
  currency: "EUR",
  generatedAt: new Date().toISOString(),
  items,
});

describe("WooStoreAdapter.applyPrices", () => {
  it("groups updates by parent product — one batch call per product", async () => {
    const { client, calls } = fakeWoo();
    const adapter = new WooStoreAdapter(client);

    const result = await adapter.applyPrices(
      plan([
        item({ stockxVariantId: "a", action: "update", storeProductId: 1, storeVariationId: 10, proposedPrice: 199.99 }),
        item({ stockxVariantId: "b", action: "update", storeProductId: 1, storeVariationId: 11, proposedPrice: 209.5 }),
        item({ stockxVariantId: "c", action: "update", storeProductId: 2, storeVariationId: 20, proposedPrice: 149 }),
      ]),
    );

    expect(calls).toHaveLength(2); // two parents -> two calls
    expect(calls[0].path).toBe("products/1/variations/batch");
    expect(calls[0].body).toEqual({
      update: [
        { id: 10, regular_price: "199.99" },
        { id: 11, regular_price: "209.50" },
      ],
    });
    expect(calls[1].path).toBe("products/2/variations/batch");
    expect(result.updated).toBe(3);
    expect(result.failed).toHaveLength(0);
  });

  it("is idempotent — a plan of noop/skip items writes nothing", async () => {
    const { client, calls } = fakeWoo();
    const adapter = new WooStoreAdapter(client);

    const result = await adapter.applyPrices(
      plan([
        item({ stockxVariantId: "a", action: "noop", storeProductId: 1, storeVariationId: 10, currentPrice: 100, proposedPrice: 100 }),
        item({ stockxVariantId: "b", action: "skip", storeProductId: 1, storeVariationId: 11 }),
      ]),
    );

    expect(calls).toHaveLength(0);
    expect(result.updated).toBe(0);
  });

  it("excludes 'create' items without a store product id (handled by upsert)", async () => {
    const { client, calls } = fakeWoo();
    const adapter = new WooStoreAdapter(client);

    await adapter.applyPrices(
      plan([item({ stockxVariantId: "a", action: "create", proposedPrice: 120 })]),
    );
    expect(calls).toHaveLength(0);
  });
});
