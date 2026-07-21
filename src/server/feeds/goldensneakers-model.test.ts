import { describe, it, expect } from "vitest";
import { computePrice } from "@core/core-spine";
import { resolveEffectiveRule } from "@core/config";
import { buildDefaultConfig } from "@/server/config/defaults";
import { gsOffersToSource, parseGsPayload } from "./goldensneakers-model";

/** Rows straight from the real GS flat sample (trimmed to the fields we read). */
const SAMPLE = [
  {
    id: 11769,
    sku: "JS3801",
    product_name: "adidas Gazelle Indoor J 'Better Scarlet'",
    brand_name: "Adidas",
    barcode: "4067907638411",
    size_us: "3.5",
    size_eu: "35.5",
    offer_price: 47.0,
    presented_price: 72,
    available_quantity: 1,
    image_full_url: "https://www.goldensneakers.net/images/JS3801/main/",
  },
  {
    id: 11767,
    sku: "JS3801",
    product_name: "adidas Gazelle Indoor J 'Better Scarlet'",
    brand_name: "Adidas",
    barcode: "4067907638442",
    size_us: "4.5",
    size_eu: "36 2/3",
    offer_price: 47.0,
    presented_price: 72,
    available_quantity: 1,
    image_full_url: "https://www.goldensneakers.net/images/JS3801/main/",
  },
  {
    id: 8272,
    sku: "JI2756",
    product_name: "adidas Gazelle Indoor W 'Better Scarlet'",
    brand_name: "Adidas",
    barcode: "4067898487401",
    size_us: "6",
    size_eu: "37 1/3",
    offer_price: 49.0,
    presented_price: 75,
    available_quantity: 1,
    image_full_url: "https://www.goldensneakers.net/images/JI2756/main/",
  },
];

describe("parseGsPayload", () => {
  it("normalizes sizes through the shared pipeline (fractions included)", () => {
    const { offers, rejected } = parseGsPayload(SAMPLE);
    expect(rejected).toHaveLength(0);
    const js = offers.filter((o) => o.sku === "JS3801");
    expect(js.map((o) => [o.euNorm, o.sizeLabel])).toEqual([
      ["35.5", "35.5"],
      ["36.67", "36 2/3"],
    ]);
  });

  it("accepts DRF-paginated and wrapped payloads", () => {
    expect(parseGsPayload({ results: SAMPLE }).offers).toHaveLength(3);
    expect(parseGsPayload({ items: SAMPLE }).offers).toHaveLength(3);
  });

  it("collapses duplicate (sku, size) rows preferring the one with stock", () => {
    const dup = [
      { ...SAMPLE[0], id: 1, available_quantity: 0 },
      { ...SAMPLE[0], id: 2, available_quantity: 3 },
    ];
    const { offers } = parseGsPayload(dup);
    expect(offers).toHaveLength(1);
    expect(offers[0].quantity).toBe(3);
  });

  it("rejects rows with unparseable sizes instead of guessing", () => {
    const { offers, rejected } = parseGsPayload([{ ...SAMPLE[0], size_eu: "n/a" }]);
    expect(offers).toHaveLength(0);
    expect(rejected).toHaveLength(1);
  });
});

describe("GS pricing passthrough (source-scoped rule)", () => {
  it("presented_price flows through the plan engine COMPLETELY unchanged", () => {
    const { offers } = parseGsPayload(SAMPLE);
    const product = gsOffersToSource("JS3801", offers.filter((o) => o.sku === "JS3801"), "IT");
    const config = buildDefaultConfig({
      kicksDbApiKey: "",
      woo: { baseUrl: "", consumerKey: "", consumerSecret: "" },
      marketToCurrency: { IT: "EUR" },
    });

    for (const variant of product.variants) {
      const rule = resolveEffectiveRule(product, variant, config)!;
      expect(rule).not.toBeNull();
      // No bands (cleared by the GS rule), no markup, no VAT, no charm.
      expect(computePrice(variant, rule)).toBe(72); // presented_price verbatim
    }
  });

  it("keeps the standard identity: EU sizes, barcode as GTIN, gs source tag", () => {
    const { offers } = parseGsPayload(SAMPLE);
    const product = gsOffersToSource("JS3801", offers.filter((o) => o.sku === "JS3801"), "IT");
    expect(product.source).toBe("goldensneakers");
    expect(product.sku).toBe("JS3801");
    const v = product.variants.find((x) => x.sizeLabel === "36 2/3")!;
    expect(v.upc).toBe("4067907638442");
    expect(v.sizes).toEqual([{ system: "eu", size: "36 2/3" }]);
    expect(v.offers[0]).toEqual({ deliveryType: "standard", lowestAsk: 72, asks: 1 });
  });
});
