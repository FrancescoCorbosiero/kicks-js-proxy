import { describe, expect, it } from "vitest";
import { findDuplicateGroups, isSafeDuplicate } from "./duplicates";
import type { StoreModel, StoreVariation } from "./model";

const vrt = (id: number, taglia: string, stock?: number, sku?: string): StoreVariation => ({
  id,
  sku: sku ?? null,
  regular_price: "100.00",
  attributes: { attribute_pa_taglia: taglia },
  ...(stock != null ? { manage_stock: true, stock_quantity: stock } : {}),
});

const model = (products: StoreModel["products"]): StoreModel => ({ products });

describe("findDuplicateGroups", () => {
  it("groups by canonical SKU and picks the richest product as keeper", () => {
    const groups = findDuplicateGroups(
      model([
        { id: 10, sku: "iq7604-100", name: "Old copy", variations: [vrt(1, "42")] },
        {
          id: 20,
          sku: "IQ7604-100 ",
          name: "Full copy",
          variations: [vrt(2, "42", 1), vrt(3, "43", 2)],
        },
        { id: 30, sku: "OTHER-1", name: "Unique", variations: [vrt(4, "40")] },
      ]),
    );
    expect(groups).toHaveLength(1);
    const g = groups[0];
    expect(g.sku).toBe("IQ7604-100");
    expect(g.keeper.id).toBe(20);
    expect(g.keeper.totalStock).toBe(3);
    expect(g.duplicates).toHaveLength(1);
    expect(g.duplicates[0]).toMatchObject({ id: 10, safe: true, missingSizes: [] });
  });

  it("marks a duplicate unsafe when it carries sizes the keeper lacks", () => {
    const groups = findDuplicateGroups(
      model([
        { id: 1, sku: "X", name: null, variations: [vrt(1, "42"), vrt(2, "43")] },
        { id: 2, sku: "X", name: null, variations: [vrt(3, "43"), vrt(4, "44")] },
      ]),
    );
    // Tie on size count → newer id (2) is keeper; id 1 carries 42 which 2 lacks.
    const g = groups[0];
    expect(g.keeper.id).toBe(2);
    expect(g.duplicates[0]).toMatchObject({ id: 1, safe: false, missingSizes: ["42"] });
  });

  it("prefers the clean SKU encoding over the newer id on ties", () => {
    const groups = findDuplicateGroups(
      model([
        // clean web-app encoding: variation SKU "X-EU42"
        { id: 1, sku: "X", name: null, variations: [vrt(1, "42", 0, "X-EU42")] },
        { id: 2, sku: "X", name: null, variations: [vrt(2, "42")] },
      ]),
    );
    expect(groups[0].keeper.id).toBe(1);
  });

  it("treats a variation-less duplicate as trivially safe and skips blank SKUs", () => {
    const groups = findDuplicateGroups(
      model([
        { id: 1, sku: "X", name: null, variations: [vrt(1, "42")] },
        { id: 2, sku: "X", name: null, variations: [] },
        { id: 3, sku: "", name: null, variations: [] },
        { id: 4, sku: " ", name: null, variations: [] },
      ]),
    );
    expect(groups).toHaveLength(1);
    expect(groups[0].duplicates[0]).toMatchObject({ id: 2, safe: true });
  });
});

describe("isSafeDuplicate", () => {
  const m = model([
    { id: 1, sku: "X", name: null, variations: [vrt(1, "42"), vrt(2, "43")] },
    { id: 2, sku: "X", name: null, variations: [vrt(3, "42")] },
    { id: 3, sku: "X", name: null, variations: [vrt(4, "44")] },
  ]);

  it("accepts only listed safe duplicates", () => {
    expect(isSafeDuplicate(m, 2)).toBe(true); // subset of keeper
  });
  it("rejects the keeper, unsafe duplicates, and unknown ids", () => {
    expect(isSafeDuplicate(m, 1)).toBe(false); // keeper
    expect(isSafeDuplicate(m, 3)).toBe(false); // carries size 44 the keeper lacks
    expect(isSafeDuplicate(m, 99)).toBe(false);
  });
});
