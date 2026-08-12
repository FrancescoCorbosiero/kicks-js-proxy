import { describe, it, expect } from "vitest";
import { mapKicksProduct, mapKicksPrices, mergeProductsBySku } from "../core-spine";

describe("mapKicksProduct size normalization", () => {
  it("normalizes the sizes[] array, lowercasing the system and tolerating key variants", () => {
    const sp = mapKicksProduct(
      {
        id: "p1",
        sku: "DM7866-202",
        title: "Air Jordan 1",
        brand: "Jordan",
        image: "",
        variants: [
          {
            id: "v1",
            size: "9",
            size_type: "us m",
            sizes: [
              { size: "9", size_type: "US M" },
              { size: "42.5", type: "EU" }, // alternate key name
              { value: "8", system: "uk" }, // alternate value/system keys
              { size_type: "cm" }, // no size -> dropped
            ],
            prices: [],
          },
        ],
      },
      "IT",
    );

    expect(sp.variants[0].sizes).toEqual([
      { system: "us m", size: "9" },
      { system: "eu", size: "42.5" },
      { system: "uk", size: "8" },
    ]);
  });

  it("maps catalog metadata and dedupes the gallery against the thumbnail", () => {
    const sp = mapKicksProduct(
      {
        id: "p1",
        sku: "AA3834-100",
        title: "Jordan 1 Retro High Alaska",
        brand: "Jordan",
        image: "https://img/alaska.jpg",
        model: "Jordan 1 Retro High",
        gender: "men",
        category: "Air Jordan",
        secondary_category: "One",
        product_type: "sneakers",
        description: "The Air Jordan 1 …",
        // Real-world shape: thumbnail duplicated (twice here), then extras.
        gallery: [
          "https://img/alaska.jpg",
          "https://img/alaska.jpg",
          "https://img/alaska-side.jpg",
        ],
        variants: [],
      },
      "IT",
    );
    expect(sp.model).toBe("Jordan 1 Retro High");
    expect(sp.gender).toBe("men");
    expect(sp.category).toBe("Air Jordan");
    expect(sp.secondaryCategory).toBe("One");
    expect(sp.productType).toBe("sneakers");
    expect(sp.description).toBe("The Air Jordan 1 …");
    expect(sp.gallery).toEqual(["https://img/alaska-side.jpg"]);
  });

  it("omits metadata fields entirely when the API sends none", () => {
    const sp = mapKicksProduct(
      { id: "p1", sku: "X", title: "T", brand: "B", image: "", variants: [] },
      "IT",
    );
    expect(sp.model).toBeUndefined();
    expect(sp.category).toBeUndefined();
    expect(sp.gallery).toBeUndefined();
  });

  it("falls back to variant-level lowest_ask when prices[] is empty", () => {
    const sp = mapKicksProduct(
      {
        id: "p1",
        sku: "X",
        title: "T",
        brand: "B",
        image: "",
        variants: [
          { id: "v1", size: "9", size_type: "us m", prices: [], lowest_ask: 174, total_asks: 12 },
          { id: "v2", size: "10", size_type: "us m", prices: [], lowest_ask: 0, total_asks: 0 },
        ],
      },
      "IT",
    );
    expect(sp.variants[0].offers).toEqual([
      { deliveryType: "standard", lowestAsk: 174, asks: 12 },
    ]);
    expect(sp.variants[1].offers).toEqual([]); // no ask -> no offer
  });

  it("maps the flat bulk-prices shape (product_id + per-variant price/asks/type)", () => {
    const sp = mapKicksPrices(
      {
        product_id: "abc-123",
        sku: "1183C468-700",
        variants: [
          { id: "v1", size: "5", size_type: "us m", price: 197, asks: 4, type: "standard" },
          { id: "v2", size: "11", size_type: "us m", price: 196, asks: 5, type: "standard" },
        ],
      },
      "IT",
    );
    expect(sp.stockxId).toBe("abc-123");
    expect(sp.sku).toBe("1183C468-700");
    expect(sp.variants).toHaveLength(2);
    expect(sp.variants[0]).toMatchObject({
      stockxVariantId: "v1",
      sizeLabel: "5",
      offers: [{ deliveryType: "standard", lowestAsk: 197, asks: 4 }],
    });
  });

  it("groups repeated variant ids and drops 0-price (no-ask) tiers", () => {
    const sp = mapKicksPrices(
      {
        product_id: "p",
        sku: "X",
        variants: [
          // express tiers with no ask (price 0) + a real standard ask
          { id: "v1", size: "4", size_type: "us m", price: 0, asks: 0, type: "express_expedited" },
          { id: "v1", size: "4", size_type: "us m", price: 0, asks: 0, type: "express_standard" },
          { id: "v1", size: "4", size_type: "us m", price: 253, asks: 5, type: "standard" },
        ],
      },
      "IT",
    );
    expect(sp.variants).toHaveLength(1);
    expect(sp.variants[0].offers).toEqual([
      { deliveryType: "standard", lowestAsk: 253, asks: 5 },
    ]);
  });

  it("keeps the EU conversion from bulk sizes[] for matching", () => {
    const sp = mapKicksPrices(
      {
        product_id: "p",
        sku: "X",
        variants: [
          {
            id: "v1",
            size: "4",
            size_type: "us m",
            sizes: [{ size: "EU 36", type: "eu" }],
            price: 253,
            asks: 5,
            type: "standard",
          },
        ],
      },
      "IT",
    );
    expect(sp.variants[0].sizes).toContainEqual({ system: "eu", size: "EU 36" });
  });

  it("yields an empty sizes array when none are provided", () => {
    const sp = mapKicksProduct(
      { id: "p1", sku: "X", title: "T", brand: "B", image: "", variants: [{ id: "v1", size: "9", size_type: "us m" }] },
      "IT",
    );
    expect(sp.variants[0].sizes).toEqual([]);
  });
});

describe("mergeProductsBySku", () => {
  const variant = (id: string, price: number, type = "standard") => ({
    stockxVariantId: id,
    sizeLabel: "42",
    sizeType: "eu",
    offers: [{ deliveryType: type as "standard", lowestAsk: price, asks: 1 }],
  });

  it("collapses duplicate SKU entries into one product (the duplicate-plans bug)", () => {
    const merged = mergeProductsBySku([
      { stockxId: "a", sku: "IQ7604-100", title: "", brand: "", image: "", market: "IT", currency: "EUR", variants: [variant("v1", 100)] },
      { stockxId: "a", sku: "iq7604-100 ", title: "Travis", brand: "Jordan", image: "x", market: "IT", currency: "EUR", variants: [variant("v1", 90, "express_standard"), variant("v2", 120)] },
      { stockxId: "b", sku: "OTHER-1", title: "", brand: "", image: "", market: "IT", currency: "EUR", variants: [variant("v9", 50)] },
    ]);
    expect(merged).toHaveLength(2);
    const first = merged[0];
    // variants merged by id; offers merged across entries by delivery type
    expect(first.variants).toHaveLength(2);
    const v1 = first.variants.find((v) => v.stockxVariantId === "v1")!;
    expect(v1.offers.map((o) => o.deliveryType).sort()).toEqual(["express_standard", "standard"]);
    // richest identity survives
    expect(first.title).toBe("Travis");
  });

  it("keeps the HIGHEST price when duplicate entries disagree on the same tier", () => {
    // Entry order is arbitrary — first-wins once made the shelf price a coin
    // flip between the real ask and a lower payout-style value, so products
    // could be listed far below market. Max never undersells.
    const merged = mergeProductsBySku([
      { stockxId: "a", sku: "X", title: "", brand: "", image: "", market: "IT", currency: "EUR", variants: [variant("v1", 60)] },
      { stockxId: "a", sku: "X", title: "", brand: "", image: "", market: "IT", currency: "EUR", variants: [variant("v1", 82)] },
    ]);
    expect(merged[0].variants[0].offers).toEqual([
      { deliveryType: "standard", lowestAsk: 82, asks: 1 },
    ]);
    // Same result with the entries reversed — order must not matter.
    const reversed = mergeProductsBySku([
      { stockxId: "a", sku: "X", title: "", brand: "", image: "", market: "IT", currency: "EUR", variants: [variant("v1", 82)] },
      { stockxId: "a", sku: "X", title: "", brand: "", image: "", market: "IT", currency: "EUR", variants: [variant("v1", 60)] },
    ]);
    expect(reversed[0].variants[0].offers).toEqual([
      { deliveryType: "standard", lowestAsk: 82, asks: 1 },
    ]);
  });
});

describe("conflicting same-tier price rows (the underpriced-variant bug)", () => {
  it("bulk mapper: duplicate standard rows for one variant collapse to the highest price", () => {
    const sp = mapKicksPrices(
      {
        product_id: "p1",
        sku: "HP8695",
        variants: [
          // The API sometimes emits a second, LOWER row for the same variant
          // and tier (payout-style value riding along). Row order is arbitrary.
          { id: "v46", size: "46", size_type: "eu", price: 55.5, asks: 2, type: "standard" },
          { id: "v46", size: "46", size_type: "eu", price: 78, asks: 2, type: "standard" },
          { id: "v47", size: "47", size_type: "eu", price: 72, asks: 3, type: "standard" },
        ],
      },
      "IT",
    );
    const v46 = sp.variants.find((v) => v.stockxVariantId === "v46")!;
    expect(v46.offers).toEqual([{ deliveryType: "standard", lowestAsk: 78, asks: 2 }]);
    const v47 = sp.variants.find((v) => v.stockxVariantId === "v47")!;
    expect(v47.offers).toEqual([{ deliveryType: "standard", lowestAsk: 72, asks: 3 }]);
  });

  it("product mapper: duplicate-tier prices[] entries collapse to the highest price", () => {
    const sp = mapKicksProduct(
      {
        id: "p1",
        sku: "HP8695",
        title: "Foam RNNR",
        brand: "adidas",
        image: "",
        variants: [
          {
            id: "v1",
            size: "48.5",
            size_type: "eu",
            prices: [
              { price: 43.7, asks: 1, type: "standard" },
              { price: 60, asks: 1, type: "standard" },
              { price: 65, asks: 1, type: "express_standard" },
            ],
          },
        ],
      },
      "IT",
    );
    expect(sp.variants[0].offers).toEqual([
      { deliveryType: "standard", lowestAsk: 60, asks: 1 },
      { deliveryType: "express_standard", lowestAsk: 65, asks: 1 },
    ]);
  });
});
