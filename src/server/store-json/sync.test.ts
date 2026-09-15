import { describe, it, expect } from "vitest";
import type { AppConfig } from "@core/config";
import type { SourceProduct } from "@core/core-spine";
import type { StoreModel } from "./model";
import { applyRoundtripSync } from "./sync";
import { partitionSearchable } from "./searchable";

/** Minimal config: a single general rule, 0% markup, no VAT, no rounding, so the
 *  proposed price equals the lowest ask — easy to assert against. */
function config(): AppConfig {
  return {
    source: {
      market: "IT",
      defaultDeliveryType: "standard",
      batchChunkSize: 50,
      cacheTtlSeconds: 3600,
      query: { sort: "release_date", limit: 10, display: { traits: true, variants: true, identifiers: true, prices: true } },
    },
    pricingRules: [
      {
        id: "general",
        scope: {},
        enabled: true,
        markupPercent: 0,
        rounding: { mode: "none" },
        tax: { priceIncludesVat: false, vatRatePercent: 0 },
      },
    ],
    matching: { strategyOrder: ["upc", "skuPattern", "manual"], skuTemplate: "{sku}-{size}" },
    apply: {
      includeActions: ["update", "create"],
      dryRunByDefault: true,
      requireApprovalAboveDeltaPercent: 100,
      concurrency: 2,
      wooBatchSize: 50,
      retry: { attempts: 3, backoffMs: 200 },
    },
    connection: { kicksDbApiKey: "", woo: { baseUrl: "", consumerKey: "", consumerSecret: "" }, marketToCurrency: { IT: "EUR" } },
  };
}

function model(): StoreModel {
  return {
    format: "rp_cm_roundtrip",
    product_count: 2,
    products: [
      {
        id: 100,
        sku: "AAA-111",
        name: "Searchable Shoe",
        variations: [
          { id: 1001, sku: "AAA-111-42", regular_price: "100.00", attributes: { attribute_pa_taglia: "42" } },
          { id: 1002, sku: "AAA-111-43", regular_price: "100.00", attributes: { attribute_pa_taglia: "43" } },
        ],
      },
      {
        id: 200,
        sku: "ZZZ-999", // never on KicksDB
        name: "Own-brand item",
        variations: [{ id: 2001, sku: "ZZZ-999-40", regular_price: "50.00", attributes: { attribute_pa_taglia: "40" } }],
      },
    ],
  };
}

/** StockX source for AAA-111: size 42 priced 200, size 44 (new) priced 300. No 43. */
function source(): SourceProduct {
  return {
    stockxId: "p1",
    sku: "AAA-111",
    title: "Searchable Shoe",
    brand: "Nike",
    image: "",
    market: "IT",
    currency: "EUR",
    variants: [
      { stockxVariantId: "v42", sizeLabel: "8", sizeType: "us m", sizes: [{ system: "eu", size: "EU 42" }], offers: [{ deliveryType: "standard", lowestAsk: 200, asks: 5 }] },
      { stockxVariantId: "v44", sizeLabel: "10", sizeType: "us m", sizes: [{ system: "eu", size: "EU 44" }], upc: "GTIN-44", offers: [{ deliveryType: "standard", lowestAsk: 300, asks: 5 }] },
    ],
  };
}

describe("partitionSearchable", () => {
  it("keeps only products whose SKU resolves on KicksDB", () => {
    const { searchable, searchableSkus, strippedSkus } = partitionSearchable(
      model(),
      new Set(["AAA-111"]),
    );
    expect(searchableSkus).toEqual(["AAA-111"]);
    expect(strippedSkus).toEqual(["ZZZ-999"]);
    expect(searchable.products).toHaveLength(1);
    expect(searchable.product_count).toBe(1);
  });
});

describe("applyRoundtripSync — update_only", () => {
  it("reprices matched variations only; never creates or removes", () => {
    const out = applyRoundtripSync(model(), [source()], config(), { mode: "update_only" });
    expect(out.variationsUpdated).toBe(1); // size 42 only (43 has no source, 44 not matched)
    expect(out.variationsCreated).toBe(0);
    expect(out.variationsRemoved).toBe(0);
    expect(out.changed.products).toHaveLength(1);

    const prod = out.changed.products[0];
    expect(prod.variations.find((v) => v.id === 1001)?.regular_price).toBe("200.00");
    // untouched size 43 still present, original price
    expect(prod.variations.find((v) => v.id === 1002)?.regular_price).toBe("100.00");
  });

  it("does not mutate the input model", () => {
    const m = model();
    applyRoundtripSync(m, [source()], config(), { mode: "update_only" });
    expect(m.products[0].variations[0].regular_price).toBe("100.00");
  });
});

describe("applyRoundtripSync — create_only", () => {
  it("adds the new StockX size, stamping GTIN, without repricing existing rows", () => {
    const out = applyRoundtripSync(model(), [source()], config(), { mode: "create_only" });
    expect(out.variationsCreated).toBe(1); // size 44
    expect(out.variationsUpdated).toBe(0);
    expect(out.gtinsWritten).toBe(1);

    const prod = out.changed.products[0];
    const created = prod.variations.find((v) => v.sku === "AAA-111-44");
    expect(created).toBeTruthy();
    expect(created?.id).toBe(0); // create-on-import
    expect(created?.regular_price).toBe("300.00");
    expect(created?.global_unique_id).toBe("GTIN-44");
    // existing 42 untouched
    expect(prod.variations.find((v) => v.id === 1001)?.regular_price).toBe("100.00");
  });

  it("creates a whole new parent product when the SKU is absent from the file", () => {
    const m: StoreModel = { format: "rp_cm_roundtrip", product_count: 0, products: [] };
    const out = applyRoundtripSync(m, [source()], config(), { mode: "create_only" });
    expect(out.productsCreated).toBe(1);
    expect(out.variationsCreated).toBe(2);
    expect(out.changed.products[0].id).toBe(0);
    expect(out.changed.products[0].sku).toBe("AAA-111");
  });
});

describe("applyRoundtripSync — upsert & replace", () => {
  it("upsert updates matched and creates missing in one pass", () => {
    const out = applyRoundtripSync(model(), [source()], config(), { mode: "upsert" });
    expect(out.variationsUpdated).toBe(1); // 42
    expect(out.variationsCreated).toBe(1); // 44
    expect(out.variationsRemoved).toBe(0);
  });

  it("replace also removes store sizes StockX no longer lists", () => {
    const out = applyRoundtripSync(model(), [source()], config(), { mode: "replace" });
    expect(out.variationsUpdated).toBe(1); // 42
    expect(out.variationsCreated).toBe(1); // 44
    expect(out.variationsRemoved).toBe(1); // 43 gone from StockX

    const prod = out.changed.products.find((p) => p.sku === "AAA-111")!;
    expect(prod.variations.find((v) => v.id === 1002)).toBeUndefined(); // 43 removed
    expect(prod.variations.find((v) => v.id === 1001)).toBeTruthy(); // 42 kept
  });

  it("never touches a product that has no StockX source (non-searchable)", () => {
    const out = applyRoundtripSync(model(), [source()], config(), { mode: "replace" });
    expect(out.changed.products.find((p) => p.sku === "ZZZ-999")).toBeUndefined();
  });
});
