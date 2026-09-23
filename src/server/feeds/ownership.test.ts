import { describe, it, expect, vi } from "vitest";
import type { SourceProduct } from "@core/core-spine";
import {
  carryIdentifiers,
  DELISTED_VARIANT_PREFIX,
  delistedSource,
  fetchSecondarySource,
  mergeGsOwned,
  type GsOwnedProduct,
} from "./ownership";

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
    expect(res).toEqual({ products: [], unanswered: [] });
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
    expect(res.unanswered).toEqual(["CZ0790"]); // unanswered, not missing
    expect(res.warning).toMatch(/503 Service Unavailable/);
  });

  it("a slice with no feed product is not a store without a feed (soleSource)", async () => {
    const res = await fetchSecondarySource(["CZ0790"], {
      ownedCount: 0, // this slice: all KicksDB products
      soleSource: false, // the store: the feed is in use
      configured: true,
      fetch: async () => {
        throw new Error("fetch failed");
      },
    });
    expect(res.unanswered).toEqual(["CZ0790"]);
    expect(res.warning).toMatch(/fetch failed/);
  });

  it("an unconfigured KicksDB leaves nothing unanswered — there was nothing to ask", async () => {
    const res = await fetchSecondarySource(["A", "B"], { ownedCount: 0, configured: false, fetch: vi.fn() });
    expect(res.unanswered).toEqual([]);
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

describe("carryIdentifiers", () => {
  const variant = (id: string, sizeLabel: string, upc?: string) => ({
    stockxVariantId: id,
    sizeLabel,
    sizeType: "eu",
    sizes: [{ system: "eu", size: sizeLabel }],
    ...(upc ? { upc } : {}),
    offers: [],
  });

  it("fills the GTINs the bulk price endpoint does not return", () => {
    // The sync runs on prices (no identifiers); the catalog holds them.
    const fetched = [product("IE4931", { variants: [variant("v1", "42"), variant("v2", "43")] })];
    const known = new Map([
      [
        "IE4931",
        product("IE4931", {
          variants: [variant("v1", "42", "4067907638411"), variant("v2", "43", "4067898487401")],
        }),
      ],
    ]);
    expect(carryIdentifiers(fetched, known)[0].variants.map((v) => v.upc)).toEqual([
      "4067907638411",
      "4067898487401",
    ]);
  });

  it("falls back to the size when variant ids differ between endpoints", () => {
    const fetched = [product("IE4931", { variants: [variant("other-id", "42")] })];
    const known = new Map([
      ["IE4931", product("IE4931", { variants: [variant("v1", "42", "4067907638411")] })],
    ]);
    expect(carryIdentifiers(fetched, known)[0].variants[0].upc).toBe("4067907638411");
  });

  it("never overwrites an identifier the source already sent", () => {
    const fetched = [product("IE4931", { variants: [variant("v1", "42", "4067898487401")] })];
    const known = new Map([
      ["IE4931", product("IE4931", { variants: [variant("v1", "42", "4067907638411")] })],
    ]);
    expect(carryIdentifiers(fetched, known)[0].variants[0].upc).toBe("4067898487401");
  });

  it("passes products through when the catalog knows nothing", () => {
    const fetched = [product("IE4931", { variants: [variant("v1", "42")] })];
    expect(carryIdentifiers(fetched, new Map())).toBe(fetched);
    expect(carryIdentifiers(fetched, new Map([["ZZ0000", product("ZZ0000")]]))[0].variants[0].upc)
      .toBeUndefined();
  });
});

describe("delistedSource", () => {
  const store = {
    id: 7,
    sku: "M990JJ3",
    name: "New Balance 990v3",
    variations: [
      { id: 71, sku: "M990JJ3-42", regular_price: "200", attributes: { attribute_pa_taglia: "42" } },
      { id: 72, sku: "M990JJ3-43", regular_price: "200", attributes: { attribute_pa_taglia: "43" } },
      { id: 0, sku: "M990JJ3-44", attributes: { attribute_pa_taglia: "44" } }, // no real id
    ],
  };
  const kicksVariant = (id: string, eu: string) => ({
    stockxVariantId: id,
    sizeLabel: eu,
    sizeType: "eu",
    sizes: [{ system: "eu", size: eu }],
    offers: [{ deliveryType: "standard" as const, lowestAsk: 150, asks: 9 }],
  });

  it("uncovered: one bare variant per store size, nothing priced", () => {
    const p = delistedSource("M990JJ3", store, undefined, "IT")!;
    expect(p.source).toBe("goldensneakers");
    expect(p.title).toBe("New Balance 990v3");
    expect(p.variants.map((v) => v.sizeLabel)).toEqual(["42", "43"]);
    expect(p.variants.every((v) => v.offers.length === 0)).toBe(true);
    expect(p.variants.every((v) => v.stockxVariantId.startsWith(DELISTED_VARIANT_PREFIX))).toBe(true);
  });

  it("covered: keeps the KicksDB variants that land on the store, adds the rest bare", () => {
    const priced = product("M990JJ3", {
      variants: [kicksVariant("k42", "42"), kicksVariant("k47", "47")], // 47 not on the store
    });
    const p = delistedSource("M990JJ3", store, priced, "IT")!;
    expect(p.source).toBeUndefined(); // KicksDB pricing rules still apply
    expect(p.variants.map((v) => v.stockxVariantId)).toEqual(["k42", `${DELISTED_VARIANT_PREFIX}M990JJ3:43`]);
  });

  it("null when the store has no writable variation", () => {
    expect(delistedSource("X", { id: 1, sku: "X", variations: [] }, undefined, "IT")).toBeNull();
  });
});
