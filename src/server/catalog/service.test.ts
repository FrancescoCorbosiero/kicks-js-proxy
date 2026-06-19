import { describe, it, expect, vi } from "vitest";
import type { SourceProduct } from "@core/core-spine";
import { skuKey } from "@/lib/skus";
import type { SourceLike } from "@/server/kicks/service";
import { resolveSkusViaCatalog, type CatalogStore } from "./service";

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

/** In-memory CatalogStore with an injectable clock to exercise TTL freshness. */
function fakeStore() {
  const data = new Map<string, { product: SourceProduct; fetchedAt: number }>();
  let now = 10_000;
  const store: CatalogStore = {
    async getFresh(market, skus, ttlSeconds) {
      const m = new Map<string, SourceProduct>();
      for (const s of skus) {
        const e = data.get(`${market}:${skuKey(s)}`);
        if (e && e.fetchedAt > now - ttlSeconds * 1000) m.set(skuKey(s), e.product);
      }
      return m;
    },
    async upsert(market, products) {
      for (const p of products) data.set(`${market}:${skuKey(p.sku)}`, { product: p, fetchedAt: now });
    },
  };
  return { store, setNow: (n: number) => (now = n) };
}

describe("resolveSkusViaCatalog", () => {
  it("fetches on cold catalog and serves the warm second call from cache", async () => {
    const { store } = fakeStore();
    const getProduct = vi.fn(async (q: string) => [product(q)]);
    const source: SourceLike = { getPricesBatch: vi.fn(), getProduct };

    const first = await resolveSkusViaCatalog(source, store, ["A", "B"], "IT", 60);
    expect(first.fetched).toBe(2);
    expect(first.fromCache).toBe(0);
    expect(first.products.map((p) => p.sku).sort()).toEqual(["A", "B"]);
    expect(getProduct).toHaveBeenCalledTimes(2);

    const second = await resolveSkusViaCatalog(source, store, ["A", "B"], "IT", 60);
    expect(second.fromCache).toBe(2);
    expect(second.fetched).toBe(0);
    expect(getProduct).toHaveBeenCalledTimes(2); // no new fetches
  });

  it("refetches once the catalog entry goes stale (past TTL)", async () => {
    const { store, setNow } = fakeStore();
    const getProduct = vi.fn(async (q: string) => [product(q)]);
    const source: SourceLike = { getPricesBatch: vi.fn(), getProduct };

    await resolveSkusViaCatalog(source, store, ["A"], "IT", 60); // fetched at 10_000
    setNow(10_000 + 61_000); // 61s later, TTL 60s -> stale
    const res = await resolveSkusViaCatalog(source, store, ["A"], "IT", 60);
    expect(res.fetched).toBe(1);
    expect(getProduct).toHaveBeenCalledTimes(2);
  });

  it("reports SKUs that resolve to no StockX product as notFound", async () => {
    const { store } = fakeStore();
    const source: SourceLike = { getPricesBatch: vi.fn(), getProduct: vi.fn(async () => []) };

    const res = await resolveSkusViaCatalog(source, store, ["NOPE"], "IT", 60);
    expect(res.notFound).toEqual(["NOPE"]);
    expect(res.products).toHaveLength(0);
    expect(res.fetched).toBe(0);
  });

  it("keeps only the exact-SKU match from a fuzzy products query", async () => {
    const { store } = fakeStore();
    const getProduct = vi.fn(async (q: string) => [product("DIFFERENT"), product(q)]);
    const source: SourceLike = { getPricesBatch: vi.fn(), getProduct };

    const res = await resolveSkusViaCatalog(source, store, ["CT8012-047"], "IT", 60);
    expect(res.products.map((p) => p.sku)).toEqual(["CT8012-047"]);
  });

  it("de-duplicates SKUs differing only by case/whitespace", async () => {
    const { store } = fakeStore();
    const getProduct = vi.fn(async (q: string) => [product(q.trim())]);
    const source: SourceLike = { getPricesBatch: vi.fn(), getProduct };

    const res = await resolveSkusViaCatalog(source, store, ["abc", "ABC", " abc "], "IT", 60);
    expect(res.products).toHaveLength(1);
    expect(getProduct).toHaveBeenCalledTimes(1);
  });
});
