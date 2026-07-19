import { describe, it, expect } from "vitest";
import type { SourceProduct } from "@core/core-spine";
import type { AppConfig } from "@core/config";
import { planRebuild, rebuildParentAttributes } from "./rebuild-plan";
import type { StoreVariation } from "./model";

/** Minimal config: flat 30% markup, no VAT, no rounding — easy assertions. */
function config(): AppConfig {
  return {
    source: {
      market: "IT",
      defaultDeliveryType: "standard",
      batchChunkSize: 50,
      cacheTtlSeconds: 900,
      query: { sort: "release_date", limit: 10, display: { traits: true, variants: true, identifiers: true, prices: true } },
    },
    pricingRules: [
      { id: "g", scope: {}, enabled: true, sourceDeliveryType: "standard", markupPercent: 30, rounding: { mode: "none" }, tax: { priceIncludesVat: false, vatRatePercent: 0 } },
    ],
    matching: { strategyOrder: ["upc"], skuTemplate: "{sku}-{size}" },
    apply: {
      includeActions: ["update"],
      dryRunByDefault: true,
      requireApprovalAboveDeltaPercent: 25,
      concurrency: 3,
      wooBatchSize: 100,
      retry: { attempts: 1, backoffMs: 1 },
      schedule: null,
    },
    connection: { kicksDbApiKey: "", woo: { baseUrl: "", consumerKey: "", consumerSecret: "" }, marketToCurrency: { IT: "EUR" } },
  };
}

/** Catalog truth: sizes 36 (ask 100), 42.5 (ask 200), 45.5 (no ask), 36 2/3 (ask 120). */
function catalog(): SourceProduct {
  return {
    stockxId: "x1",
    sku: "U906023D",
    title: "New Balance 9060 Navy Oxford Blue",
    brand: "New Balance",
    image: "",
    market: "IT",
    currency: "EUR",
    variants: [
      { stockxVariantId: "v36", sizeLabel: "4", sizeType: "us m", sizes: [{ system: "eu", size: "EU 36" }], upc: "UPC-36", offers: [{ deliveryType: "standard", lowestAsk: 100, asks: 3 }] },
      { stockxVariantId: "v425", sizeLabel: "9", sizeType: "us m", sizes: [{ system: "eu", size: "EU 42.5" }], offers: [{ deliveryType: "standard", lowestAsk: 200, asks: 5 }] },
      { stockxVariantId: "v455", sizeLabel: "11.5", sizeType: "us m", sizes: [{ system: "eu", size: "EU 45.5" }], offers: [] },
      { stockxVariantId: "v3623", sizeLabel: "4.5", sizeType: "us m", sizes: [{ system: "eu", size: "EU 36 2/3" }], offers: [{ deliveryType: "standard", lowestAsk: 120, asks: 2 }] },
    ],
  };
}

/** The broken store product: 36 (with meta), corrupt 45-5, and orphan 37. */
function oldVariations(): StoreVariation[] {
  return [
    {
      id: 501,
      sku: "U906023D-EU36",
      regular_price: "169.00",
      stock_quantity: 1,
      attributes: [{ id: 3, name: "pa_taglia", option: "36" }],
      meta_data: [{ key: "_swatch_color", value: "#001f3f" }],
      image: { id: 998, src: "https://shop/img-36.png" },
      description: "per-size note",
    },
    {
      id: 502,
      sku: "U906023D-EU45.5",
      regular_price: "169.00",
      stock_quantity: 0,
      attributes: [{ id: 3, name: "pa_taglia", option: "45-5" }], // corrupt label
      meta_data: [{ key: "_swatch_color", value: "#003f5c" }],
    },
    {
      id: 503,
      sku: "U906023D-EU37", // orphan: not on the catalog
      regular_price: "173.00",
      stock_quantity: 0,
      attributes: [{ id: 3, name: "pa_taglia", option: "37" }],
    },
  ];
}

describe("planRebuild", () => {
  const plan = planRebuild({
    parentSku: "U906023D",
    storeProductId: 334617,
    catalog: catalog(),
    oldVariations: oldVariations(),
    config: config(),
    manualPrices: { "42.5": 999 },
    tagliaAttributeId: 3,
  });

  it("deletes every old variation and creates the canonical catalog set", () => {
    expect(plan.deleteVariationIds.sort()).toEqual([501, 502, 503]);
    expect(plan.create.map((c) => c.sizeLabel)).toEqual(["36", "36 2/3", "42.5", "45.5"]);
    expect(plan.parentSizeOptions).toEqual(["36", "36 2/3", "42.5", "45.5"]);
    expect(plan.droppedOldSizes).toEqual(["37"]); // orphan disappears
  });

  it("regenerates identity: sku template, attribute binding, UPC", () => {
    const s36 = plan.create.find((c) => c.sizeLabel === "36")!;
    expect(s36.sku).toBe("U906023D-EU36");
    expect(s36.payload.attributes).toEqual([{ id: 3, option: "36" }]);
    expect(s36.payload.global_unique_id).toBe("UPC-36");
    const s3623 = plan.create.find((c) => c.sizeLabel === "36 2/3")!;
    expect(s3623.sku).toBe("U906023D-EU36 2/3");
  });

  it("prices: manual lock > computed > carried old price > none", () => {
    const bySize = new Map(plan.create.map((c) => [c.sizeLabel, c]));
    expect(bySize.get("42.5")!.price).toBe(999); // manual lock wins
    expect(bySize.get("42.5")!.priceSource).toBe("manual");
    expect(bySize.get("36")!.price).toBe(130); // 100 * 1.30 computed
    expect(bySize.get("36")!.priceSource).toBe("computed");
    // 45.5 has no ask -> falls back to the old (corrupt twin's) shelf price.
    expect(bySize.get("45.5")!.price).toBe(169);
    expect(bySize.get("45.5")!.priceSource).toBe("carried");
    expect(plan.unpricedSizes).toEqual([]);
  });

  it("carries the old variation's extras key-agnostically, matching corrupt labels", () => {
    const s36 = plan.create.find((c) => c.sizeLabel === "36")!;
    expect(s36.carriedFrom).toBe(501);
    expect(s36.payload.meta_data).toEqual([{ key: "_swatch_color", value: "#001f3f" }]);
    expect(s36.payload.image).toEqual({ id: 998, src: "https://shop/img-36.png" });
    expect(s36.payload.description).toBe("per-size note");

    // "45-5" (corrupt) matched canonical 45.5 -> its meta rides along.
    const s455 = plan.create.find((c) => c.sizeLabel === "45.5")!;
    expect(s455.carriedFrom).toBe(502);
    expect(s455.payload.meta_data).toEqual([{ key: "_swatch_color", value: "#003f5c" }]);
  });

  it("never carries regenerated fields; forces sell-on-demand stock", () => {
    const s36 = plan.create.find((c) => c.sizeLabel === "36")!;
    expect(s36.payload.id).toBeUndefined();
    expect(s36.payload.stock_quantity).toBeUndefined();
    expect(s36.payload.stock_status).toBe("instock");
    expect(s36.payload.manage_stock).toBe(false);
    expect(s36.payload.regular_price).toBe("130.00");
  });
});

describe("rebuildParentAttributes", () => {
  it("replaces an existing pa_taglia entry, preserving the other attributes", () => {
    const attrs = rebuildParentAttributes(
      [
        { id: 1, name: "pa_brand", options: ["New Balance"], visible: true },
        { id: 3, name: "pa_taglia", options: ["stale"], variation: true },
      ],
      ["36", "42.5"],
      3,
    );
    expect(attrs).toEqual([
      { id: 1, name: "pa_brand", options: ["New Balance"], visible: true },
      { id: 3, name: "pa_taglia", options: ["36", "42.5"], variation: true, visible: true },
    ]);
  });

  it("appends the entry when the parent has no (or an unusable) attribute list", () => {
    const attrs = rebuildParentAttributes(null, ["36"], 3);
    expect(attrs).toEqual([
      { id: 3, name: "pa_taglia", variation: true, visible: true, options: ["36"] },
    ]);
  });
});
