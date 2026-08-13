import { describe, it, expect } from "vitest";
import type { SourceProduct } from "@core/core-spine";
import type { AppConfig } from "@core/config";
import { buildDefaultConfig } from "@/server/config/defaults";
import { planPublish, planReimportParent } from "./publish-plan";

const config: AppConfig = buildDefaultConfig({
  kicksDbApiKey: "",
  woo: { baseUrl: "", consumerKey: "", consumerSecret: "" },
  marketToCurrency: { IT: "EUR" },
});

function product(over: Partial<SourceProduct> = {}): SourceProduct {
  return {
    stockxId: "x1",
    sku: "IE4931",
    title: "adidas Yeezy Foam RNNR Sulfur",
    brand: "adidas",
    image: "https://cdn.example.com/foam.jpg",
    market: "IT",
    currency: "EUR",
    category: "Yeezy",
    secondaryCategory: "Foam RNNR",
    variants: [
      {
        stockxVariantId: "v1",
        sizeLabel: "42",
        sizeType: "eu",
        sizes: [{ system: "eu", size: "42" }],
        offers: [{ deliveryType: "standard", lowestAsk: 100, asks: 4 }],
      },
      {
        stockxVariantId: "v2",
        sizeLabel: "43",
        sizeType: "eu",
        sizes: [{ system: "eu", size: "43" }],
        offers: [{ deliveryType: "standard", lowestAsk: 120, asks: 2 }],
      },
    ],
    ...over,
  };
}

describe("planPublish — the parent WooCommerce create body", () => {
  it("builds a published variable product keyed by the canonical SKU", () => {
    const plan = planPublish({ catalog: product(), config });
    expect(plan.parentBody.type).toBe("variable");
    expect(plan.parentBody.status).toBe("publish");
    expect(plan.parentBody.sku).toBe("IE4931");
    expect(plan.parentBody.name).toBe("adidas Yeezy Foam RNNR Sulfur");
  });

  it("declares pa_taglia as a variation attribute carrying every size", () => {
    // The parent's option list must exist before variations can bind to it —
    // a variation referencing an unlisted option is silently unbuyable.
    const plan = planPublish({ catalog: product(), config });
    const attrs = plan.parentBody.attributes as Record<string, unknown>[];
    expect(attrs).toHaveLength(1);
    expect(attrs[0].name).toBe("pa_taglia");
    expect(attrs[0].variation).toBe(true);
    expect(attrs[0].visible).toBe(true);
    expect(attrs[0].options).toEqual(["42", "43"]);
  });

  it("binds pa_taglia by global attribute id when one is known", () => {
    const plan = planPublish({ catalog: product(), config, tagliaAttributeId: 7 });
    const attrs = plan.parentBody.attributes as Record<string, unknown>[];
    expect(attrs[0].id).toBe(7);
    expect(plan.variations[0].payload.attributes).toEqual([{ id: 7, option: "42" }]);
  });

  it("falls back to the SKU when the source carries no title", () => {
    const plan = planPublish({ catalog: product({ title: "" }), config });
    expect(plan.parentBody.name).toBe("IE4931");
    expect(plan.title).toBe("IE4931");
  });

  it("prices every size through the margin rules", () => {
    // The default banded rule, +35% under 150 with charm rounding:
    // 100 → 135.99, 120 → 162.99.
    const plan = planPublish({ catalog: product(), config });
    expect(plan.variations.map((v) => v.payload.regular_price)).toEqual(["135.99", "162.99"]);
    expect(plan.unpricedSizes).toEqual([]);
  });

  it("an operator's manual lock beats the computed price", () => {
    const plan = planPublish({ catalog: product(), config, manualPrices: { "42": 99.5 } });
    expect(plan.variations[0].payload.regular_price).toBe("99.50");
    expect(plan.variations[0].priceSource).toBe("manual");
  });

  it("writes real managed stock for a feed-owned product", () => {
    const plan = planPublish({
      catalog: product({ source: "goldensneakers" }),
      config,
      stockBySize: { "42": 3, "43": 0 },
    });
    expect(plan.variations[0].payload.manage_stock).toBe(true);
    expect(plan.variations[0].payload.stock_quantity).toBe(3);
    expect(plan.variations[0].payload.stock_status).toBe("instock");
    // A zero-quantity size is created but NOT purchasable — finite supply.
    expect(plan.variations[1].payload.stock_quantity).toBe(0);
    expect(plan.variations[1].payload.stock_status).toBe("outofstock");
  });

  it("leaves KicksDB products sell-on-demand rather than inventing a count", () => {
    const plan = planPublish({ catalog: product(), config });
    expect(plan.variations[0].payload.manage_stock).toBe(false);
    expect(plan.variations[0].payload.stock_status).toBe("instock");
    expect(plan.variations[0].payload.stock_quantity).toBeUndefined();
  });
});

describe("planPublish — media", () => {
  it("sends the main image only by default", () => {
    const plan = planPublish({
      catalog: product({ gallery: ["https://cdn.example.com/alt1.jpg"] }),
      config,
    });
    expect(plan.images).toEqual(["https://cdn.example.com/foam.jpg"]);
    expect(plan.parentBody.images).toEqual([{ src: "https://cdn.example.com/foam.jpg" }]);
  });

  it("includes the gallery when asked, main shot first and deduped", () => {
    const plan = planPublish({
      catalog: product({
        gallery: ["https://cdn.example.com/foam.jpg", "https://cdn.example.com/alt1.jpg"],
      }),
      config,
      includeGallery: true,
    });
    expect(plan.images).toEqual([
      "https://cdn.example.com/foam.jpg",
      "https://cdn.example.com/alt1.jpg",
    ]);
  });

  it("caps how many images Woo is asked to sideload", () => {
    const gallery = Array.from({ length: 20 }, (_, i) => `https://cdn.example.com/g${i}.jpg`);
    const plan = planPublish({ catalog: product({ gallery }), config, includeGallery: true });
    expect(plan.images).toHaveLength(6);
  });

  it("drops unusable image URLs instead of making Woo reject the create", () => {
    const plan = planPublish({
      catalog: product({ image: "", gallery: ["not-a-url", "  ", "ftp://x/y.jpg"] }),
      config,
      includeGallery: true,
    });
    expect(plan.images).toEqual([]);
    expect(plan.parentBody.images).toBeUndefined();
  });
});

describe("planPublish — sizes that cannot be published", () => {
  it("skips variants with no resolvable EU size and reports the count", () => {
    const plan = planPublish({
      catalog: product({
        variants: [
          {
            stockxVariantId: "v1",
            sizeLabel: "9",
            sizeType: "us m", // no EU conversion available
            offers: [{ deliveryType: "standard", lowestAsk: 100, asks: 4 }],
          },
        ],
      }),
      config,
    });
    expect(plan.variations).toEqual([]);
    expect(plan.skippedNoEu).toBe(1);
  });

  it("still creates a size with no ask, and flags it as unpriced", () => {
    const plan = planPublish({
      catalog: product({
        variants: [
          {
            stockxVariantId: "v1",
            sizeLabel: "42",
            sizeType: "eu",
            sizes: [{ system: "eu", size: "42" }],
            offers: [],
          },
        ],
      }),
      config,
    });
    expect(plan.variations).toHaveLength(1);
    expect(plan.variations[0].payload.regular_price).toBeUndefined();
    expect(plan.unpricedSizes).toEqual(["42"]);
  });
});

describe("planReimportParent — what a force reimport is allowed to touch", () => {
  it("refreshes identity and the size list, never the store's own fields", () => {
    const plan = planPublish({ catalog: product(), config });
    const body = planReimportParent(plan, { replaceMedia: false });
    expect(Object.keys(body).sort()).toEqual(["attributes", "name"]);
    // Explicitly absent: anything the shop owns and the catalog must not win.
    expect(body.status).toBeUndefined();
    expect(body.sku).toBeUndefined();
    expect(body.description).toBeUndefined();
  });

  it("replaces media only when explicitly asked", () => {
    const plan = planPublish({ catalog: product(), config });
    expect(planReimportParent(plan, { replaceMedia: false }).images).toBeUndefined();
    expect(planReimportParent(plan, { replaceMedia: true }).images).toEqual([
      { src: "https://cdn.example.com/foam.jpg" },
    ]);
  });
});
