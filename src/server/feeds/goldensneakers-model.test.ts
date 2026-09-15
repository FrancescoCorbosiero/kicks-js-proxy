import { describe, it, expect } from "vitest";
import { computePrice } from "@core/core-spine";
import { resolveEffectiveRule } from "@core/config";
import { buildDefaultConfig } from "@/server/config/defaults";
import {
  gsOffersToSource,
  parseGsPayload,
  resolveGsGallery,
  resolveGsImage,
} from "./goldensneakers-model";

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

describe("resolveGsImage", () => {
  const FULL =
    "https://media.goldensneakers.net/products/images/2913_KJ8969/raw/c67b5534062a.png";

  it("uses the new complete-URL format as-is — never doubles the filename", () => {
    // Aug 2026: image_full_url already ends with image_name; blind
    // concatenation would produce …/x.png/x.png → 404.
    expect(resolveGsImage(FULL, "c67b5534062a.png")).toBe(FULL);
  });

  it("still joins the legacy folder format with image_name", () => {
    expect(
      resolveGsImage("https://www.goldensneakers.net/images/JS3801/main/", "front.png"),
    ).toBe("https://www.goldensneakers.net/images/JS3801/main/front.png");
  });

  it("keeps a legacy folder URL as-is when no image_name is present", () => {
    const folder = "https://www.goldensneakers.net/images/JS3801/main/";
    expect(resolveGsImage(folder, null)).toBe(folder);
    expect(resolveGsImage(folder, "")).toBe(folder);
  });

  it("accepts the apex domain and any true subdomain", () => {
    expect(resolveGsImage("https://goldensneakers.net/i/a.png", "a.png")).toBe(
      "https://goldensneakers.net/i/a.png",
    );
    expect(resolveGsImage("https://cdn.eu.goldensneakers.net/i/a.png", "a.png")).toBe(
      "https://cdn.eu.goldensneakers.net/i/a.png",
    );
  });

  it("completes a site-relative folder path against the GS origin", () => {
    // The row from the screenshot: image_full_url is a bare path, image_name
    // the file. Before the fix new URL() threw → "" → product with no picture.
    expect(
      resolveGsImage("/images/IH6001/main/", "Screenshot_2026-08-24_at_12.25.46.png"),
    ).toBe(
      "https://www.goldensneakers.net/images/IH6001/main/Screenshot_2026-08-24_at_12.25.46.png",
    );
  });

  it("completes a site-relative path with no leading slash, and one that is already the file", () => {
    expect(resolveGsImage("images/IH6001/main/", "front.png")).toBe(
      "https://www.goldensneakers.net/images/IH6001/main/front.png",
    );
    // Relative AND complete: the filename must not be doubled here either.
    expect(resolveGsImage("/images/IH6001/main/front.png", "front.png")).toBe(
      "https://www.goldensneakers.net/images/IH6001/main/front.png",
    );
  });

  it("reads a protocol-relative URL as https", () => {
    expect(resolveGsImage("//media.goldensneakers.net/i/a.png", "a.png")).toBe(
      "https://media.goldensneakers.net/i/a.png",
    );
  });

  it("still applies the domain gate after completing a relative path", () => {
    // A base pointing off-domain must not launder third-party images through.
    expect(resolveGsImage("/i/a.png", "a.png", "https://evil.com")).toBe("");
    expect(resolveGsImage("//evil.com/i/a.png", "a.png")).toBe("");
  });

  it("rejects lookalike, third-party and non-https hosts", () => {
    expect(resolveGsImage("https://evilgoldensneakers.net/i/a.png", "a.png")).toBe("");
    expect(resolveGsImage("https://goldensneakers.net.evil.com/i/a.png", "a.png")).toBe("");
    expect(resolveGsImage("https://imgur.com/a.png", "a.png")).toBe("");
    expect(resolveGsImage("http://media.goldensneakers.net/i/a.png", "a.png")).toBe("");
    expect(resolveGsImage("not a url", "a.png")).toBe("");
    expect(resolveGsImage("data:image/png;base64,AAAA", "a.png")).toBe("");
    expect(resolveGsImage("javascript:alert(1)", "a.png")).toBe("");
    expect(resolveGsImage(null, "a.png")).toBe("");
  });
});

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

  it("accepts the new complete-URL format on any goldensneakers.net subdomain", () => {
    const url = "https://media.goldensneakers.net/products/images/2913_KJ8969/raw/c67b5534062a.png";
    const { offers, rejected } = parseGsPayload([{ ...SAMPLE[0], image_full_url: url }]);
    expect(rejected).toHaveLength(0);
    expect(offers[0].image).toBe(url);
    expect(gsOffersToSource("JS3801", offers, "IT").image).toBe(url);
  });

  it("derives the family axes from the title, so family-scoped margin rules match", () => {
    // The feed sends no taxonomy at all. Without this the catalog files a GS
    // product under "Yeezy › Foam RNNR" while a rule scoped to that same
    // family skips it — the product is in the family everywhere but pricing.
    const { offers } = parseGsPayload([
      { ...SAMPLE[0], product_name: "adidas Yeezy Foam RNNR Sulfur", brand_name: "adidas" },
    ]);
    const product = gsOffersToSource("JS3801", offers, "IT");
    expect(product.category).toBe("Yeezy");
    expect(product.secondaryCategory).toBe("Foam RNNR");
  });

  it("leaves the axes unset when the title classifies to nothing", () => {
    const { offers } = parseGsPayload([
      { ...SAMPLE[0], product_name: "Prodotto Sconosciuto", brand_name: "" },
    ]);
    const product = gsOffersToSource("JS3801", offers, "IT");
    expect(product.category).toBeUndefined();
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

describe("barcode quality reporting", () => {
  const row = (sku: string, size: string, barcode: string) => ({
    id: Math.random(),
    sku,
    size_eu: size,
    product_name: "adidas Samba",
    barcode,
  });

  it("counts what a channel would refuse, without dropping the row", () => {
    // The size still sells; only its identifier is unusable. Silence here is
    // what turns into a Merchant Center disapproval nobody can explain.
    const { offers, invalidBarcodes } = parseGsPayload([
      row("IH6001", "40", "4067907638411"),
      row("IH6001", "41", "4067907638410"), // broken check digit
      row("IH6001", "42", "not-a-barcode"),
    ]);
    expect(offers).toHaveLength(3);
    expect(invalidBarcodes).toBe(2);
  });

  it("counts a barcode the feed gives to more than one size", () => {
    const { duplicateBarcodes } = parseGsPayload([
      row("IH6001", "40", "4067907638411"),
      row("IH6001", "41", "4067907638411"),
      row("JI2626", "42", "4067898487401"),
    ]);
    expect(duplicateBarcodes).toBe(1);
  });

  it("reports nothing for a clean feed", () => {
    const { invalidBarcodes, duplicateBarcodes } = parseGsPayload([
      row("IH6001", "40", "4067907638411"),
      row("IH6001", "41", "4067898487401"),
    ]);
    expect([invalidBarcodes, duplicateBarcodes]).toEqual([0, 0]);
  });
});

describe("the fields the feed fills inconsistently", () => {
  /** The real row from the feed browser, verbatim. */
  const ROW = {
    id: 20647,
    sku: "DM0032-601",
    product_name: "Nike Air Max Plus TN Tough Red Black",
    brand_name: "Nike",
    barcode: "",
    size_us: "9",
    size_eu: "42.5",
    offer_price: 113,
    presented_price: 113,
    available_quantity: 1,
    image: "/images/DM0032-601/main/",
    image_full_url: "/images/DM0032-601/main/",
    image_name: "Screenshot_2026-09-15_at_14.13.16.png",
    additional_images: [] as unknown[],
  };

  const RESOLVED =
    "https://www.goldensneakers.net/images/DM0032-601/main/Screenshot_2026-09-15_at_14.13.16.png";

  it("resolves the relative path both fields carry", () => {
    expect(parseGsPayload([ROW]).offers[0].image).toBe(RESOLVED);
  });

  it("falls back to `image` when image_full_url is the empty one", () => {
    // Same picture, the other field: an empty image_full_url used to mean no
    // picture at all even with `image` holding the very same path.
    const { offers } = parseGsPayload([{ ...ROW, image_full_url: "" }]);
    expect(offers[0].image).toBe(RESOLVED);
  });

  it("picks up the extra shots the feed ships as paths", () => {
    const { offers } = parseGsPayload([
      { ...ROW, additional_images: ["/images/DM0032-601/alt/side.png", "  ", "javascript:x"] },
    ]);
    expect(offers[0].gallery).toEqual([
      "https://www.goldensneakers.net/images/DM0032-601/alt/side.png",
    ]);
  });

  it("reads the object form too, and never repeats the main image", () => {
    expect(
      resolveGsGallery(
        [
          { image_full_url: "/images/X/alt/", image_name: "a.png" },
          { image: "/images/X/alt/", image_name: "a.png" }, // the same shot again
          { nothing: true },
        ],
        "https://www.goldensneakers.net/images/X/main/b.png",
      ),
    ).toEqual(["https://www.goldensneakers.net/images/X/alt/a.png"]);
  });

  it("drops a shot that is just the main image under another name", () => {
    expect(resolveGsGallery(["/images/X/main/b.png"], "https://www.goldensneakers.net/images/X/main/b.png"))
      .toEqual([]);
  });

  it("carries the gallery onto the plan-ready product", () => {
    const { offers } = parseGsPayload([
      { ...ROW, additional_images: ["/images/DM0032-601/alt/side.png"] },
    ]);
    const source = gsOffersToSource("DM0032-601", offers, "IT");
    expect(source.gallery).toEqual(["https://www.goldensneakers.net/images/DM0032-601/alt/side.png"]);
  });
});
