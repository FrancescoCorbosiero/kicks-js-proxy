import { describe, it, expect } from "vitest";
import type { StoreModel } from "./model";
import { sanitizeModel } from "./sanitize";

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
    expect(v43.attributes?.attribute_pa_taglia).toBe("43");
    const v44 = prod.variations.find((v) => v.id === 333302)!;
    expect(v44.attributes?.attribute_pa_taglia).toBe("44"); // untouched, already correct
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
