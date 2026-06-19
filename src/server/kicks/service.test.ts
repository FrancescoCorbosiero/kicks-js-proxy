import { describe, it, expect, vi } from "vitest";
import type { SourceProduct } from "@core/core-spine";
import { MemoryCache } from "@/server/cache/memory";
import { fetchPricesCached, fetchProductsCached, type SourceLike } from "./service";

function product(sku: string): SourceProduct {
  return {
    stockxId: `id-${sku}`,
    sku,
    title: sku,
    brand: "Nike",
    image: "",
    market: "IT",
    currency: "EUR",
    variants: [],
  };
}

describe("fetchPricesCached", () => {
  it("fetches all on cold cache, then serves the second call entirely from cache", async () => {
    const cache = new MemoryCache();
    const getPricesBatch = vi.fn(async (skus: string[]) => skus.map(product));
    const source: SourceLike = { getPricesBatch, getProduct: vi.fn() };

    const first = await fetchPricesCached(source, cache, ["A", "B"], "IT", 60);
    expect(first.fetched).toBe(2);
    expect(first.fromCache).toBe(0);
    expect(first.products.map((p) => p.sku).sort()).toEqual(["A", "B"]);
    expect(getPricesBatch).toHaveBeenCalledTimes(1);

    const second = await fetchPricesCached(source, cache, ["A", "B"], "IT", 60);
    expect(second.fromCache).toBe(2);
    expect(second.fetched).toBe(0);
    expect(getPricesBatch).toHaveBeenCalledTimes(1); // no new API call
  });

  it("only fetches the missing SKUs on a partly-warm cache", async () => {
    const cache = new MemoryCache();
    const getPricesBatch = vi.fn(async (skus: string[]) => skus.map(product));
    const source: SourceLike = { getPricesBatch, getProduct: vi.fn() };

    await fetchPricesCached(source, cache, ["A"], "IT", 60);
    getPricesBatch.mockClear();

    const res = await fetchPricesCached(source, cache, ["A", "B"], "IT", 60);
    expect(res.fromCache).toBe(1);
    expect(res.fetched).toBe(1);
    expect(getPricesBatch).toHaveBeenCalledWith(["B"], "IT");
  });

  it("negative-caches SKUs that return no product", async () => {
    const cache = new MemoryCache();
    const getPricesBatch = vi.fn(async () => [] as SourceProduct[]);
    const source: SourceLike = { getPricesBatch, getProduct: vi.fn() };

    await fetchPricesCached(source, cache, ["MISSING"], "IT", 60);
    const again = await fetchPricesCached(source, cache, ["MISSING"], "IT", 60);
    expect(again.fromCache).toBe(1);
    expect(getPricesBatch).toHaveBeenCalledTimes(1);
  });
});

describe("fetchProductsCached", () => {
  it("caches the whole query result", async () => {
    const cache = new MemoryCache();
    const getProduct = vi.fn(async () => [product("X"), product("Y")]);
    const source: SourceLike = { getPricesBatch: vi.fn(), getProduct };

    const first = await fetchProductsCached(source, cache, "Air Max", "IT", 60);
    expect(first.fetched).toBe(1);
    expect(first.products).toHaveLength(2);

    const second = await fetchProductsCached(source, cache, "Air Max", "IT", 60);
    expect(second.fromCache).toBe(1);
    expect(getProduct).toHaveBeenCalledTimes(1);
  });
});
