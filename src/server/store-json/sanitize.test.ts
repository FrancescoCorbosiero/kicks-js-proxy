import { describe, it, expect } from "vitest";
import type { StoreModel, StoreProductModel } from "./model";
import { sanitizeModel, sanitizeProduct } from "./sanitize";
import { readTaglia } from "./match";

/** A model shaped like the real "FV5029-010" export: some zero-stock ghosts, a
 *  parent pa_taglia attribute, per-variation attribute_pa_taglia. */
function model(): StoreModel {
  return {
    format: "rp_cm_roundtrip",
    product_count: 2,
    products: [
      {
        id: 333000,
        sku: "FV5029-010",
        name: "Jordan 4 Retro Black Cat",
        meta_title: "SEO to preserve",
        attributes: [
          // stale: still lists the ghost size 42.5, which sanitize should drop
          { name: "pa_taglia", variation: true, options: ["42.5", "43", "44"] },
        ],
        variations: [
          {
            id: 333300,
            sku: "FV5029-010-EU42.5",
            regular_price: "452.61",
            stock_quantity: 0, // ghost
            attributes: { attribute_pa_taglia: "42.5" },
          },
          {
            id: 333301,
            sku: "FV5029-010-EU43",
            regular_price: "374.00",
            stock_quantity: 4,
            attributes: { attribute_pa_taglia: "wrong" }, // misaligned -> realign to 43
          },
          {
            id: 333302,
            sku: "FV5029-010-EU44",
            regular_price: "368.00",
            stock_quantity: 21,
            attributes: { attribute_pa_taglia: "44" }, // already correct
          },
        ],
      },
      {
        id: 999000,
        sku: "ZZ0000-000",
        name: "Untouched product",
        variations: [
          { id: 999001, sku: "ZZ0000-000-EU42", stock_quantity: 5, attributes: { attribute_pa_taglia: "42" } },
        ],
      },
    ],
  };
}

describe("sanitizeModel", () => {
  it("drops zero-stock ghost variations", () => {
    const { output, report } = sanitizeModel(model());
    expect(report.ghostsRemoved).toBe(1);
    const prod = output.products.find((p) => p.id === 333000)!;
    expect(prod.variations.map((v) => v.id)).toEqual([333301, 333302]);
  });

  it("realigns a misaligned variation pa_taglia to its true (SKU) size", () => {
    const { output, report } = sanitizeModel(model());
    expect(report.taglieRealigned).toBe(1); // only the "wrong" one changes
    const prod = output.products.find((p) => p.id === 333000)!;
    const v43 = prod.variations.find((v) => v.id === 333301)!;
    expect(readTaglia(v43)).toBe("43");
    const v44 = prod.variations.find((v) => v.id === 333302)!;
    expect(readTaglia(v44)).toBe("44"); // untouched, already correct
  });

  it("realigns the parent pa_taglia option list to the surviving sizes", () => {
    const { output, report } = sanitizeModel(model());
    expect(report.parentAttributesRealigned).toBe(1);
    const prod = output.products.find((p) => p.id === 333000)!;
    const attr = (prod.attributes as { name: string; options: string[] }[])[0];
    expect(attr.options).toEqual(["43", "44"]); // ghost 42.5 removed, sorted ascending
  });

  it("keeps only changed products and refreshes product_count", () => {
    const { output } = sanitizeModel(model());
    expect(output.products.map((p) => p.id)).toEqual([333000]); // ZZ0000-000 unchanged -> dropped
    expect(output.product_count).toBe(1);
  });

  it("preserves unrelated fields on changed products", () => {
    const { output } = sanitizeModel(model());
    expect(output.products[0].meta_title).toBe("SEO to preserve");
  });

  it("does not mutate the input", () => {
    const input = model();
    sanitizeModel(input);
    expect(input.products[0].variations).toHaveLength(3);
    expect(input.product_count).toBe(2);
  });

  it("treats string stock quantities as numbers", () => {
    const m = model();
    m.products[0].variations[1].stock_quantity = "0"; // string zero -> ghost
    const { report } = sanitizeModel(m);
    expect(report.ghostsRemoved).toBe(2);
  });

  it("keeps variations whose stock is unmanaged (no quantity)", () => {
    const m = model();
    m.products[0].variations[0].stock_quantity = undefined; // was the ghost, now unmanaged
    const { output } = sanitizeModel(m);
    const prod = output.products.find((p) => p.id === 333000)!;
    expect(prod.variations.map((v) => v.id)).toContain(333300); // kept now
  });
});

/**
 * The real corruption: the "IE7002" product carries TWO variations per physical
 * size — a clean web-app entry ("IE7002-EU36 2/3", pa_taglia "36 2/3") and a stale
 * snapshot row ("IE7002-3623", pa_taglia "36-2-3", inflated stock). Plus a
 * snapshot-only size (42 2/3) with no web-app twin.
 */
function ie7002(): StoreProductModel {
  return {
    id: 304782,
    sku: "IE7002",
    name: "adidas Gazelle Indoor Bliss Pink Purple",
    meta_title: "SEO to preserve",
    attributes: {
      pa_taglia: { options: ["stale"], visible: true, variation: true },
    },
    variations: [
      // Clean web-app entries (recent, real stock)
      { id: 333908, sku: "IE7002-EU36", stock_quantity: 1, attributes: { attribute_pa_taglia: "36" } },
      { id: 333909, sku: "IE7002-EU36 2/3", stock_quantity: 1, attributes: { attribute_pa_taglia: "36 2/3" } },
      // Stale snapshot twins (same sizes, corrupt encoding, fake stock 80)
      { id: 306619, sku: "IE7002-36", stock_quantity: 80, attributes: { attribute_pa_taglia: "36" } },
      { id: 306624, sku: "IE7002-3623", stock_quantity: 80, attributes: { attribute_pa_taglia: "36-2-3" } },
      // Snapshot-only size (no web-app twin) — must survive, pa_taglia realigned
      { id: 306668, sku: "IE7002-4223", stock_quantity: 80, attributes: { attribute_pa_taglia: "42-2-3" } },
    ],
  };
}

describe("sanitizeProduct — duplicate variant dedup (IE7002)", () => {
  it("keeps the KicksDB-backed web-app twin and drops the stale snapshot one", () => {
    const product = ie7002();
    // KicksDB matched the clean web-app twins for the two shared sizes.
    const r = sanitizeProduct(product, new Set([333908, 333909]));
    expect(r.duplicatesRemoved).toBe(2);
    expect(product.variations.map((v) => v.id).sort()).toEqual([306668, 333908, 333909]);
  });

  it("prefers the clean web-app row over the corrupt snapshot even without KicksDB", () => {
    const product = ie7002();
    const r = sanitizeProduct(product, new Set()); // no KicksDB signal
    expect(r.duplicatesRemoved).toBe(2);
    // Snapshot twins 306619 / 306624 dropped; clean web-app 333908 / 333909 kept.
    expect(product.variations.map((v) => v.id).sort()).toEqual([306668, 333908, 333909]);
  });

  it("syncs pa_taglia to clean human labels on survivors + parent", () => {
    const product = ie7002();
    sanitizeProduct(product, new Set([333908, 333909]));

    const taglie = product.variations.map((v) => readTaglia(v));
    expect(taglie).toEqual(["36", "36 2/3", "42 2/3"]); // 42-2-3 realigned to 42 2/3

    const parent = (product.attributes as { pa_taglia: { options: string[] } }).pa_taglia;
    expect(parent.options).toEqual(["36", "36 2/3", "42 2/3"]); // sorted, deduped, human
  });

  it("keeps a snapshot-only size (no twin) and preserves SEO", () => {
    const product = ie7002();
    sanitizeProduct(product, new Set([333908, 333909]));
    expect(product.variations.some((v) => v.id === 306668)).toBe(true); // 42 2/3 survives
    expect(product.meta_title).toBe("SEO to preserve");
  });

  it("counts duplicatesRemoved through sanitizeModel", () => {
    const m: StoreModel = { format: "rp_cm_roundtrip", product_count: 1, products: [ie7002()] };
    const { report } = sanitizeModel(m);
    expect(report.duplicatesRemoved).toBe(2);
  });
});

describe("sanitizeProduct — array-shaped variation attributes", () => {
  it("realigns pa_taglia in a Woo REST array in place, never corrupting it", () => {
    const product: StoreProductModel = {
      id: 1,
      sku: "AA-1",
      variations: [
        // corrupt SKU + array pa_taglia -> realigned in place to the human label
        { id: 11, sku: "AA-1-3623", stock_quantity: 2, attributes: [{ name: "pa_taglia", option: "36-2-3" }] },
        // empty PHP array -> gets the object form, size from the clean SKU suffix
        { id: 12, sku: "AA-1-EU38", stock_quantity: 2, attributes: [] },
      ],
    };
    const r = sanitizeProduct(product);
    expect(r.taglieRealigned).toBe(2);

    const v11 = product.variations.find((v) => v.id === 11)!;
    expect(Array.isArray(v11.attributes)).toBe(true); // shape preserved
    expect(readTaglia(v11)).toBe("36 2/3");

    const v12 = product.variations.find((v) => v.id === 12)!;
    expect(readTaglia(v12)).toBe("38");
  });
});
