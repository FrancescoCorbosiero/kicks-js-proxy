import { describe, it, expect } from "vitest";
import { mapKicksProduct } from "../core-spine";

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

  it("yields an empty sizes array when none are provided", () => {
    const sp = mapKicksProduct(
      { id: "p1", sku: "X", title: "T", brand: "B", image: "", variants: [{ id: "v1", size: "9", size_type: "us m" }] },
      "IT",
    );
    expect(sp.variants[0].sizes).toEqual([]);
  });
});
