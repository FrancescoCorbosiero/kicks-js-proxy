import { describe, it, expect } from "vitest";
import { WooStoreAdapter, renderSkuTemplate } from "../core-spine";
import type { SourceProduct } from "../core-spine";
import type { MatchingConfig } from "../config";

const matching: MatchingConfig = {
  strategyOrder: ["upc", "skuPattern", "manual"],
  skuTemplate: "{sku}-{size}",
};

function product(): SourceProduct {
  return {
    stockxId: "p1",
    sku: "CT8012-047",
    title: "Air Jordan 1",
    brand: "Jordan",
    image: "",
    market: "IT",
    currency: "EUR",
    variants: [
      { stockxVariantId: "v1", sizeLabel: "9", sizeType: "us m", upc: "U1", offers: [] },
      { stockxVariantId: "v2", sizeLabel: "9.5", sizeType: "us m", offers: [] },
    ],
  };
}

function fakeWoo(opts: {
  products?: unknown[];
  variations?: unknown[];
  newProductId?: number;
}) {
  const calls: { method: string; path: string; body?: unknown }[] = [];
  const client = {
    async get<T>(path: string): Promise<T> {
      calls.push({ method: "get", path });
      if (path === "products") return (opts.products ?? []) as T;
      if (/^products\/\d+\/variations$/.test(path)) return (opts.variations ?? []) as T;
      return [] as T;
    },
    async post<T>(path: string, body: unknown): Promise<T> {
      calls.push({ method: "post", path, body });
      if (path === "products") return { id: opts.newProductId ?? 999 } as T;
      return {} as T;
    },
  };
  return { client, calls };
}

describe("renderSkuTemplate", () => {
  it("substitutes tokens and dashes spaces", () => {
    expect(
      renderSkuTemplate("{sku}-{sizeType}-{size}", { sku: "AB1", brand: "X" }, { sizeLabel: "9", sizeType: "us m" }),
    ).toBe("AB1-us-m-9");
  });
});

describe("WooStoreAdapter.resolveMappings", () => {
  it("matches by UPC first, then the SKU template, reading current prices", async () => {
    const { client } = fakeWoo({
      products: [{ id: 10, sku: "CT8012-047" }],
      variations: [
        { id: 100, global_unique_id: "U1", regular_price: "199.99" },
        { id: 101, sku: "CT8012-047-9.5", regular_price: "150.00" },
      ],
    });
    const adapter = new WooStoreAdapter(client, matching);

    const map = await adapter.resolveMappings(product());
    expect(map.get("v1")).toEqual({
      stockxVariantId: "v1",
      storeProductId: 10,
      storeVariationId: 100,
      currentPrice: 199.99,
    });
    expect(map.get("v2")).toEqual({
      stockxVariantId: "v2",
      storeProductId: 10,
      storeVariationId: 101,
      currentPrice: 150,
    });
  });

  it("returns an empty map when the parent product is not on the store", async () => {
    const { client } = fakeWoo({ products: [] });
    const adapter = new WooStoreAdapter(client, matching);
    expect((await adapter.resolveMappings(product())).size).toBe(0);
  });
});

describe("WooStoreAdapter.upsertProduct", () => {
  it("creates the variable product and variations, writing UPC to global_unique_id", async () => {
    const { client, calls } = fakeWoo({ products: [], variations: [], newProductId: 77 });
    const adapter = new WooStoreAdapter(client, matching);

    const res = await adapter.upsertProduct(product());
    expect(res.storeProductId).toBe(77);

    const createProduct = calls.find((c) => c.method === "post" && c.path === "products");
    expect(createProduct?.body).toMatchObject({ type: "variable", sku: "CT8012-047" });

    const createVars = calls.find((c) => c.path === "products/77/variations/batch");
    const body = createVars?.body as { create: { sku: string; global_unique_id?: string }[] };
    expect(body.create).toContainEqual(
      expect.objectContaining({ sku: "CT8012-047-9", global_unique_id: "U1" }),
    );
  });

  it("does not recreate variations that already exist (idempotent)", async () => {
    const { client, calls } = fakeWoo({
      products: [{ id: 10, sku: "CT8012-047" }],
      variations: [
        { id: 100, sku: "CT8012-047-9", global_unique_id: "U1" },
        { id: 101, sku: "CT8012-047-9.5" },
      ],
    });
    const adapter = new WooStoreAdapter(client, matching);

    await adapter.upsertProduct(product());
    expect(calls.some((c) => c.path.endsWith("/variations/batch"))).toBe(false);
  });
});
