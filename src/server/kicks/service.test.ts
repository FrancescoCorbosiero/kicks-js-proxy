import { describe, it, expect, vi } from "vitest";
import type { SourceProduct } from "@core/core-spine";
import { MemoryCache } from "@/server/cache/memory";
import { fetchProductsCached, type SourceLike } from "./service";

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
