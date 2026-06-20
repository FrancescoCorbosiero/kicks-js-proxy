import { describe, it, expect } from "vitest";
import type { SourceProduct } from "@core/core-spine";
import { parseStoreModel, type StoreModel } from "./model";
import { resolveFromModel, normSize, variationEuSize } from "./match";
import { applyModelPatch } from "./patch";

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
        // Real KicksDB shape: size strings are prefixed, e.g. "EU 42.5".
        stockxVariantId: "v-425",
        sizeLabel: "9",
        sizeType: "us m",
        sizes: [{ system: "us m", size: "US M 9" }, { system: "eu", size: "EU 42.5" }],
        offers: [{ deliveryType: "standard", lowestAsk: 200, asks: 5 }],
      },
      {
        stockxVariantId: "v-42",
        sizeLabel: "8.5",
        sizeType: "us m",
        sizes: [{ system: "eu", size: "EU 42" }],
        offers: [],
      },
    ],
  };
}

describe("normSize / variationEuSize", () => {
  it("normalizes dash, dot, and prefixed notations to one key", () => {
    expect(normSize("42-5")).toBe("42.5");
    expect(normSize("42.5")).toBe("42.5");
    expect(normSize("44")).toBe("44");
    expect(normSize("EU 42.5")).toBe("42.5"); // KicksDB prefix
    expect(normSize("US M 9")).toBe("9");
    expect(normSize("EU 36 2/3")).toBe("36.67"); // mixed fraction
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
      saleActive: false,
    });
    expect(map.get("v-42")?.storeVariationId).toBe(334132);
  });

  it("returns empty when the parent SKU is not in the snapshot", () => {
    const other = { ...source(), sku: "ZZ0000-000" };
    expect(resolveFromModel(model, other).size).toBe(0);
  });

  it("flags variations with an active sale_price as saleActive", () => {
    const m: StoreModel = structuredClone(model);
    m.products[0].variations[0].sale_price = "499.99"; // the EU 42.5 variation
    const map = resolveFromModel(m, source());
    expect(map.get("v-425")?.saleActive).toBe(true);
    expect(map.get("v-42")?.saleActive).toBe(false); // no sale
  });
});

describe("applyModelPatch", () => {
  it("patches price + GTIN, keeps changed products, preserves other fields", () => {
    const { output, productsChanged, variationsChanged, gtinsWritten } = applyModelPatch(
      model,
      new Map([[334133, { price: 248.99, gtin: "00194501234567" }]]),
    );
    expect(variationsChanged).toBe(1);
    expect(productsChanged).toBe(1);
    expect(gtinsWritten).toBe(1);
    expect(output.products).toHaveLength(1);

    const prod = output.products[0];
    expect(prod.meta_title).toBe("Nike Travis Scott Shy Pink | Sneaker Originali 2026"); // SEO preserved
    const changed = prod.variations.find((v) => v.id === 334133)!;
    expect(changed.regular_price).toBe("248.99");
    expect(changed.global_unique_id).toBe("00194501234567"); // GMC GTIN written
    expect(changed.stock_quantity).toBe(25); // untouched
  });

  it("does not mutate the input snapshot", () => {
    applyModelPatch(model, new Map([[334133, { price: 1 }]]));
    expect(model.products[0].variations[0].regular_price).toBe("566.03");
  });

  it("sets out-of-stock variations (size not on KicksDB) without changing price", () => {
    const { output, sizesRemoved, variationsChanged } = applyModelPatch(
      model,
      new Map([[334132, { outOfStock: true }]]),
    );
    expect(sizesRemoved).toBe(1);
    expect(variationsChanged).toBe(1);
    const v = output.products[0].variations.find((x) => x.id === 334132)!;
    expect(v.stock_status).toBe("outofstock");
    expect(v.stock_quantity).toBe(0);
    expect(v.regular_price).toBe("566.03"); // price untouched
  });
});

describe("resolveFromModel — GTIN-first matching", () => {
  it("prefers global_unique_id over EU size when both sides have a GTIN", () => {
    const m: StoreModel = structuredClone(model);
    // Give the 42 variation a GTIN and make the source variant carry it, but with
    // a mismatched EU size so only GTIN could link them.
    m.products[0].variations[1].global_unique_id = "GTIN-42";
    const src = source();
    src.variants[1].upc = "GTIN-42";
    src.variants[1].sizes = [{ system: "eu", size: "99" }]; // wrong size on purpose

    const map = resolveFromModel(m, src);
    expect(map.get("v-42")?.storeVariationId).toBe(334132); // matched by GTIN, not size
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
