import { describe, it, expect, vi } from "vitest";
import type { SourceProduct } from "@core/core-spine";
import { skuKey } from "@/lib/skus";
import type { SourceLike } from "@/server/kicks/service";
import { resolveSkusViaCatalog, growCatalogFromSkus, type CatalogStore } from "./service";

/**
 * A source built around the exact-SKU port. Its lookup can answer three ways —
 * a product, null for "no such product", or a throw for "could not answer" —
 * and the catalog acts differently on each, so the fake models all three.
 */
function fakeSource(findBySku: (sku: string, market: string) => Promise<SourceProduct | null>) {
  const spy = vi.fn(findBySku);
  const source: SourceLike = {
    getPricesBatch: vi.fn(),
    getProduct: vi.fn(async () => []),
    findBySku: spy,
  };
  return { source, findBySku: spy };
}

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
    async getAny(market, skus) {
      const m = new Map<string, SourceProduct>();
      for (const s of skus) {
        const e = data.get(`${market}:${skuKey(s)}`);
        if (e) m.set(skuKey(s), e.product);
      }
      return m;
    },
    async upsert(market, products) {
      for (const p of products) data.set(`${market}:${skuKey(p.sku)}`, { product: p, fetchedAt: now });
    },
    async count(market) {
      let n = 0;
      for (const key of data.keys()) if (key.startsWith(`${market}:`)) n += 1;
      return n;
    },
  };
  return { store, setNow: (n: number) => (now = n) };
}

describe("resolveSkusViaCatalog", () => {
  it("fetches on cold catalog and serves the warm second call from cache", async () => {
    const { store } = fakeStore();
    const { source, findBySku } = fakeSource(async (sku) => product(sku));

    const first = await resolveSkusViaCatalog(source, store, ["A", "B"], "IT", 60);
    expect(first.fetched).toBe(2);
    expect(first.fromCache).toBe(0);
    expect(first.products.map((p) => p.sku).sort()).toEqual(["A", "B"]);
    expect(findBySku).toHaveBeenCalledTimes(2);

    const second = await resolveSkusViaCatalog(source, store, ["A", "B"], "IT", 60);
    expect(second.fromCache).toBe(2);
    expect(second.fetched).toBe(0);
    expect(findBySku).toHaveBeenCalledTimes(2); // no new fetches
  });

  it("refetches once the catalog entry goes stale (past TTL)", async () => {
    const { store, setNow } = fakeStore();
    const { source, findBySku } = fakeSource(async (sku) => product(sku));

    await resolveSkusViaCatalog(source, store, ["A"], "IT", 60); // fetched at 10_000
    setNow(10_000 + 61_000); // 61s later, TTL 60s -> stale
    const res = await resolveSkusViaCatalog(source, store, ["A"], "IT", 60);
    expect(res.fetched).toBe(1);
    expect(findBySku).toHaveBeenCalledTimes(2);
  });

  it("reports SKUs the source has no product for as notFound", async () => {
    const { store } = fakeStore();
    const { source } = fakeSource(async () => null);

    const res = await resolveSkusViaCatalog(source, store, ["NOPE"], "IT", 60);
    expect(res.notFound).toEqual(["NOPE"]);
    expect(res.failed).toEqual([]);
    expect(res.products).toHaveLength(0);
    expect(res.fetched).toBe(0);
  });

  it("keeps a failed lookup out of notFound and resolves the rest", async () => {
    const { store } = fakeStore();
    const { source } = fakeSource(async (sku) => {
      if (sku === "BOOM") throw new Error("HTTP 429 rate limited");
      return product(sku);
    });

    const res = await resolveSkusViaCatalog(source, store, ["A", "BOOM", "B"], "IT", 60);
    // One rate-limited SKU used to abort the entire preview.
    expect(res.products.map((p) => p.sku).sort()).toEqual(["A", "B"]);
    expect(res.notFound).toEqual([]);
    expect(res.failed).toEqual([{ sku: "BOOM", error: "HTTP 429 rate limited" }]);
  });

  it("de-duplicates SKUs differing only by case/whitespace", async () => {
    const { store } = fakeStore();
    const { source, findBySku } = fakeSource(async (sku) => product(sku.trim()));

    const res = await resolveSkusViaCatalog(source, store, ["abc", "ABC", " abc "], "IT", 60);
    expect(res.products).toHaveLength(1);
    expect(findBySku).toHaveBeenCalledTimes(1);
  });
});

describe("growCatalogFromSkus", () => {
  it("adds only verified new SKUs and grows the unique catalog", async () => {
    const { store } = fakeStore();
    const { source, findBySku } = fakeSource(async (sku) =>
      skuKey(sku) === "GHOST" ? null : product(sku),
    );

    const res = await growCatalogFromSkus(source, store, ["A", "B", "GHOST"], "IT");
    expect(res.added).toBe(2);
    expect(res.rejected).toEqual(["GHOST"]);
    expect(res.failed).toEqual([]);
    expect(res.total).toBe(2);
    expect(findBySku).toHaveBeenCalledTimes(3);
  });

  it("skips SKUs already in the catalog (permanent, verified once)", async () => {
    const { store } = fakeStore();
    const { source, findBySku } = fakeSource(async (sku) => product(sku));

    const first = await growCatalogFromSkus(source, store, ["A", "B"], "IT");
    expect(first.added).toBe(2);

    // Re-uploading A/B plus a new C only verifies C.
    const second = await growCatalogFromSkus(source, store, ["a", "B", "C"], "IT");
    expect(second.added).toBe(1);
    expect(second.total).toBe(3);
    expect(findBySku).toHaveBeenCalledTimes(3); // 2 first run + 1 for C
  });

  /**
   * The bug this whole change exists for: a rate-limited or timed-out lookup
   * was filed next to genuinely absent style codes, so the operator read
   * "12 rejected" and went looking for twelve bad SKUs that were all fine.
   */
  it("separates an unanswered lookup from a genuine rejection", async () => {
    const { store } = fakeStore();
    const { source } = fakeSource(async (sku) => {
      if (sku === "BOOM") throw new Error("HTTP 429 for /stockx/products");
      if (sku === "GHOST") return null;
      return product(sku);
    });

    const res = await growCatalogFromSkus(source, store, ["A", "GHOST", "BOOM"], "IT");
    expect(res.added).toBe(1);
    expect(res.rejected).toEqual(["GHOST"]); // the API said no
    expect(res.failed).toEqual([{ sku: "BOOM", error: "HTTP 429 for /stockx/products" }]);
    expect(res.total).toBe(1);
  });

  it("leaves a failed SKU out of the catalog so a retry can still add it", async () => {
    const { store } = fakeStore();
    let down = true;
    const { source } = fakeSource(async (sku) => {
      if (down) throw new Error("HTTP 503");
      return product(sku);
    });

    const first = await growCatalogFromSkus(source, store, ["A"], "IT");
    expect(first.added).toBe(0);
    expect(first.failed.map((f) => f.sku)).toEqual(["A"]);

    down = false;
    const retry = await growCatalogFromSkus(source, store, ["A"], "IT");
    expect(retry.added).toBe(1);
    expect(retry.failed).toEqual([]);
  });

  it("truncates a runaway error message instead of carrying it to the UI", async () => {
    const { store } = fakeStore();
    const { source } = fakeSource(async () => {
      throw new Error("x".repeat(500));
    });

    const res = await growCatalogFromSkus(source, store, ["A"], "IT");
    expect(res.failed[0].error).toHaveLength(201); // 200 chars + the ellipsis
    expect(res.failed[0].error.endsWith("\u2026")).toBe(true);
  });
});
