import { describe, it, expect } from "vitest";
import type { SourceProduct } from "@core/core-spine";
import { parseStoreModel, type StoreModel } from "./model";
import { resolveFromModel, normSize, variationEuSize } from "./match";
import { applyPricesToModel } from "./patch";

const model: StoreModel = {
  format: "rp_cm_roundtrip",
  site_url: "https://resellpiacenza.shop",
  product_count: 1,
  products: [
    {
      id: 334121,
      sku: "IQ7604-100",
      name: "Jordan 1 Low Travis Scott Shy Pink",
      meta_title: "Nike Travis Scott Shy Pink | Sneaker Originali 2026", // SEO field to preserve
      variations: [
        {
          id: 334133,
          sku: "IQ7604-100-42.5",
          regular_price: "566.03",
          attributes: { attribute_pa_taglia: "42-5" },
          stock_quantity: 25, // unrelated field to preserve
        },
        {
          id: 334132,
          sku: "IQ7604-100-42",
          regular_price: "566.03",
          attributes: { attribute_pa_taglia: "42" },
        },
      ],
    },
  ],
};

function source(): SourceProduct {
  return {
    stockxId: "p1",
    sku: "IQ7604-100",
    title: "Jordan 1 Low Travis Scott Shy Pink",
    brand: "Jordan",
    image: "",
    market: "IT",
    currency: "EUR",
    variants: [
      {
        stockxVariantId: "v-425",
        sizeLabel: "9",
        sizeType: "us m",
        sizes: [{ system: "us m", size: "9" }, { system: "eu", size: "42.5" }],
        offers: [{ deliveryType: "standard", lowestAsk: 200, asks: 5 }],
      },
      {
        stockxVariantId: "v-42",
        sizeLabel: "8.5",
        sizeType: "us m",
        sizes: [{ system: "eu", size: "42" }],
        offers: [],
      },
    ],
  };
}

describe("normSize / variationEuSize", () => {
  it("normalizes dash and dot size notations to one key", () => {
    expect(normSize("42-5")).toBe("42.5");
    expect(normSize("42.5")).toBe("42.5");
    expect(normSize("44")).toBe("44");
  });
  it("derives EU size from the sku suffix, falling back to pa_taglia", () => {
    expect(variationEuSize("IQ7604-100", { id: 1, sku: "IQ7604-100-42.5" })).toBe("42.5");
    expect(variationEuSize("IQ7604-100", { id: 1, attributes: { attribute_pa_taglia: "42-5" } })).toBe("42.5");
  });
});

describe("resolveFromModel", () => {
  it("matches StockX variants to store variations by EU size", () => {
    const map = resolveFromModel(model, source());
    expect(map.get("v-425")).toEqual({
      stockxVariantId: "v-425",
      storeProductId: 334121,
      storeVariationId: 334133,
      currentPrice: 566.03,
    });
    expect(map.get("v-42")?.storeVariationId).toBe(334132);
  });

  it("returns empty when the parent SKU is not in the snapshot", () => {
    const other = { ...source(), sku: "ZZ0000-000" };
    expect(resolveFromModel(model, other).size).toBe(0);
  });
});

describe("applyPricesToModel", () => {
  it("patches only changed variations, keeps changed products, preserves other fields", () => {
    const { output, productsChanged, variationsChanged } = applyPricesToModel(
      model,
      new Map([[334133, 248.99]]),
    );
    expect(variationsChanged).toBe(1);
    expect(productsChanged).toBe(1);
    expect(output.products).toHaveLength(1);

    const prod = output.products[0];
    expect(prod.meta_title).toBe("Nike Travis Scott Shy Pink | Sneaker Originali 2026"); // SEO preserved
    const changed = prod.variations.find((v) => v.id === 334133)!;
    expect(changed.regular_price).toBe("248.99");
    expect(changed.stock_quantity).toBe(25); // untouched
  });

  it("does not mutate the input snapshot", () => {
    applyPricesToModel(model, new Map([[334133, 1]]));
    expect(model.products[0].variations[0].regular_price).toBe("566.03");
  });
});

describe("parseStoreModel", () => {
  it("validates and preserves unknown fields for faithful round-trip", () => {
    const parsed = parseStoreModel(JSON.stringify(model));
    expect(parsed.products[0].meta_title).toBe("Nike Travis Scott Shy Pink | Sneaker Originali 2026");
  });
  it("throws on non-JSON and on a missing products array", () => {
    expect(() => parseStoreModel("nope")).toThrow();
    expect(() => parseStoreModel(JSON.stringify({ foo: 1 }))).toThrow();
  });
});
