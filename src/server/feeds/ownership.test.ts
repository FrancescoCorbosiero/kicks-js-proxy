import { describe, it, expect, vi } from "vitest";
import type { SourceProduct } from "@core/core-spine";
import { fetchSecondarySource, mergeGsOwned, type GsOwnedProduct } from "./ownership";

function product(sku: string, over: Partial<SourceProduct> = {}): SourceProduct {
  return {
    stockxId: sku,
    sku,
    title: `${sku} title`,
    brand: "Adidas",
    image: "",
    market: "IT",
    currency: "EUR",
    variants: [],
    ...over,
  };
}

function owned(sku: string): GsOwnedProduct {
  return {
    product: product(sku, { source: "goldensneakers", title: "", brand: "", image: "gs.png" }),
    stockBySize: { "42": 3 },
    knownSizes: new Set(["42"]),
  };
}

describe("mergeGsOwned", () => {
  it("replaces a KicksDB product but keeps its richer identity", () => {
    const merged = mergeGsOwned([product("IH6001", { image: "kicks.png" })], new Map([["IH6001", owned("IH6001")]]));
    expect(merged.products).toHaveLength(1);
    expect(merged.products[0].source).toBe("goldensneakers");
    expect(merged.products[0].title).toBe("IH6001 title"); // KicksDB identity
    expect(merged.products[0].image).toBe("kicks.png");
    expect([...merged.gsSkus]).toEqual(["IH6001"]);
  });

  it("appends feed-only products KicksDB never returned", () => {
    const merged = mergeGsOwned([], new Map([["IH6001", owned("IH6001")]]));
    expect(merged.products.map((p) => p.sku)).toEqual(["IH6001"]);
  });

  it("passes the list through untouched when the feed owns nothing", () => {
    const list = [product("CZ0790")];
    expect(mergeGsOwned(list, new Map()).products).toBe(list);
  });
});

describe("fetchSecondarySource", () => {
  it("never calls the secondary source when the feed owns every SKU", async () => {
    const fetch = vi.fn();
    const res = await fetchSecondarySource([], { ownedCount: 12, configured: true, fetch });
    expect(fetch).not.toHaveBeenCalled();
    expect(res).toEqual({ products: [] });
  });

  it("warns instead of failing when KicksDB is not configured", async () => {
    const fetch = vi.fn();
    const res = await fetchSecondarySource(["CZ0790"], { ownedCount: 3, configured: false, fetch });
    expect(fetch).not.toHaveBeenCalled();
    expect(res.products).toEqual([]);
    expect(res.warning).toMatch(/not configured/);
  });

  it("survives a KicksDB outage when the feed still covers products", async () => {
    const res = await fetchSecondarySource(["CZ0790"], {
      ownedCount: 340,
      configured: true,
      fetch: async () => {
        throw new Error("503 Service Unavailable");
      },
    });
    expect(res.products).toEqual([]);
    expect(res.warning).toMatch(/503 Service Unavailable/);
  });

  it("still fails loudly when KicksDB was the only source in play", async () => {
    await expect(
      fetchSecondarySource(["CZ0790"], {
        ownedCount: 0,
        configured: true,
        fetch: async () => {
          throw new Error("503 Service Unavailable");
        },
      }),
    ).rejects.toThrow("503 Service Unavailable");
  });

  it("asks only for the SKUs the feed does not own", async () => {
    const fetch = vi.fn(async (skus: string[]) => skus.map((s) => product(s)));
    const res = await fetchSecondarySource(["CZ0790"], { ownedCount: 2, configured: true, fetch });
    expect(fetch).toHaveBeenCalledWith(["CZ0790"]);
    expect(res.products.map((p) => p.sku)).toEqual(["CZ0790"]);
    expect(res.warning).toBeUndefined();
  });
});
