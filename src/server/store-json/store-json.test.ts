import { describe, it, expect } from "vitest";
import type { SourceProduct } from "@core/core-spine";
import { parseStoreModel, type StoreModel } from "./model";
import { resolveFromModel, normSize, variationEuSize } from "./match";
import { applyModelPatch, buildReimport } from "./patch";

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

describe("buildReimport — reprice + sanitize in one file", () => {
  const mixed = (): StoreModel => ({
    format: "rp_cm_roundtrip",
    product_count: 2,
    products: [
      {
        id: 1,
        sku: "AA-1",
        name: "P1",
        variations: [
          { id: 11, sku: "AA-1-42", regular_price: "100.00", stock_quantity: 3, attributes: { attribute_pa_taglia: "42" } },
          { id: 12, sku: "AA-1-43", regular_price: "100.00", stock_quantity: 0, attributes: { attribute_pa_taglia: "43" } }, // ghost
        ],
      },
      {
        id: 2,
        sku: "BB-2",
        name: "P2",
        variations: [
          { id: 21, sku: "BB-2-40", regular_price: "50.00", stock_quantity: 0, attributes: { attribute_pa_taglia: "40" } }, // ghost only
        ],
      },
    ],
  });

  it("reprices selected variations AND cleans the whole store", () => {
    const out = buildReimport(mixed(), new Map([[11, { price: 120 }]]), { sanitize: true });
    expect(out.variationsChanged).toBe(1);
    expect(out.ghostsRemoved).toBe(2); // variation 12 and product 2's only variation
    expect(out.productsChanged).toBe(2); // P1 repriced+cleaned, P2 cleaned-only

    const p1 = out.output.products.find((p) => p.id === 1)!;
    expect(p1.variations.map((v) => v.id)).toEqual([11]); // ghost 12 gone
    expect(p1.variations[0].regular_price).toBe("120.00"); // repriced survivor
    expect(out.output.product_count).toBe(2);
  });

  it("sanitize:false is a pure reprice — ghosts are left in place", () => {
    const out = buildReimport(mixed(), new Map([[11, { price: 120 }]]), { sanitize: false });
    expect(out.ghostsRemoved).toBe(0);
    expect(out.productsChanged).toBe(1); // only the repriced product
    const p1 = out.output.products.find((p) => p.id === 1)!;
    expect(p1.variations.map((v) => v.id)).toEqual([11, 12]); // ghost still present
  });

  it("no selections + sanitize is a clean-only export", () => {
    const out = buildReimport(mixed(), new Map(), { sanitize: true });
    expect(out.variationsChanged).toBe(0);
    expect(out.ghostsRemoved).toBe(2);
    expect(out.productsChanged).toBe(2);
  });

  it("does not mutate the input", () => {
    const input = mixed();
    buildReimport(input, new Map([[11, { price: 999 }]]), { sanitize: true });
    expect(input.products[0].variations).toHaveLength(2);
    expect(input.products[0].variations[0].regular_price).toBe("100.00");
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
