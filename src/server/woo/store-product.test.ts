import { describe, it, expect } from "vitest";
import { toStoreProduct } from "./store-product";
import type { WooRestProduct, WooRestVariation } from "./client";

/**
 * This mapper now has two callers: the store pull, and the publisher — which
 * uses it to record a product the live check found already on the store.
 * Before that, skipping such a product left the snapshot none the wiser, so
 * the Publish tab offered it again on the next render and every render after.
 *
 * What the fix rests on is pinned here: the record must key under the SKU the
 * snapshot indexes by, and must carry real sizes. A presence-only entry would
 * stop the re-offering and silently cost the product its price syncs instead.
 */

const parent = {
  id: 41,
  sku: "HQ4307-600",
  name: "Nike Mind 001 Solar Red",
  status: "publish",
  permalink: "https://shop.example.com/p/41",
} as unknown as WooRestProduct;

const variations = [
  { id: 101, sku: "HQ4307-600-42", regular_price: "189.00", stock_quantity: 2 },
  { id: 102, sku: "HQ4307-600-43", regular_price: "189.00", stock_quantity: 0 },
] as unknown as WooRestVariation[];

describe("toStoreProduct", () => {
  it("keys the record under the SKU the snapshot indexes by", () => {
    expect(toStoreProduct(parent, variations).sku).toBe("HQ4307-600");
  });

  it("carries the real sizes, so a reconciled product still gets priced", () => {
    const got = toStoreProduct(parent, variations);
    expect(got.variations).toHaveLength(2);
    expect(got.variations.map((v) => v.id)).toEqual([101, 102]);
    expect(got.variations[0].regular_price).toBe("189.00");
  });

  it("keeps the store id the sync needs to write back", () => {
    expect(toStoreProduct(parent, variations).id).toBe(41);
  });

  it("survives a product the store describes sparsely", () => {
    const bare = { id: 7 } as unknown as WooRestProduct;
    const got = toStoreProduct(bare, []);
    expect(got.sku).toBe(""); // never undefined: the snapshot keys on this
    expect(got.variations).toEqual([]);
  });
});
