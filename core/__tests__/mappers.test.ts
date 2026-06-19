import { describe, it, expect } from "vitest";
import { mapKicksProduct, mapKicksPrices } from "../core-spine";

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
