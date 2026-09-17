import { describe, it, expect } from "vitest";
import type { TaxonomyConfig } from "@core/config";
import {
  buildTaxonomyPreview,
  OPTION_LIMIT,
  PREVIEW_LIMIT,
  type TaxonomyPreviewInput,
} from "./taxonomy-preview";

const RULES_ONLY: TaxonomyConfig = {
  useSourceTree: [],
  defaultCategory: "Sneakers",
  rules: [],
  write: { brandTaxonomy: true, brandAttribute: false, genderAttribute: false },
};
const TRUST_THE_FEED: TaxonomyConfig = { ...RULES_ONLY, useSourceTree: ["goldensneakers"] };

/** A supplier feed: its "tree" is inferred from titles, so it is per model. */
function feedCatalog(n: number): TaxonomyPreviewInput[] {
  return Array.from({ length: n }, (_, i) => ({
    sku: `SKU-${i}`,
    title: `Product ${i}`,
    brand: `Brand ${i % 7}`,
    source: "goldensneakers",
    category: `Family ${i}`,
    secondaryCategory: `Sub ${i}`,
  }));
}

describe("buildTaxonomyPreview — the answer is bounded even when it is bad", () => {
  it("bounds the table when a source's own tree is one category per product", () => {
    const state = buildTaxonomyPreview(feedCatalog(4000), TRUST_THE_FEED);
    // The finding is the NUMBER, not 4000 rows the browser has to render.
    expect(state.categoryCount).toBe(4000);
    expect(state.preview.length).toBe(PREVIEW_LIMIT);
    expect(state.total).toBe(4000);
  });

  it("bounds the scope pickers too — free text covers the rest", () => {
    const state = buildTaxonomyPreview(feedCatalog(4000), TRUST_THE_FEED);
    expect(state.categories.length).toBe(OPTION_LIMIT);
    expect(state.brands.length).toBe(7);
  });

  it("keeps the biggest groups: what is cut is the long thin tail", () => {
    const rows = [...feedCatalog(200)];
    for (let i = 0; i < 500; i++) {
      rows.push({ ...rows[0], sku: `BULK-${i}`, category: "Sneakers", secondaryCategory: "" });
    }
    const state = buildTaxonomyPreview(rows, TRUST_THE_FEED);
    expect(state.preview[0].category).toBe("Sneakers");
    expect(state.preview[0].products).toBe(500);
  });

  it("collapses to one row when the rules decide, which is the point of the tab", () => {
    const state = buildTaxonomyPreview(feedCatalog(4000), RULES_ONLY);
    expect(state.categoryCount).toBe(1);
    expect(state.preview).toEqual([
      expect.objectContaining({ category: "Sneakers", products: 4000 }),
    ]);
    // Samples stay small: three per row, whatever the group's size.
    expect(state.preview[0].samples.length).toBe(3);
  });

  it("counts every product even when the row list is truncated", () => {
    const state = buildTaxonomyPreview(feedCatalog(4000), TRUST_THE_FEED);
    expect(state.sources).toEqual([{ source: "goldensneakers", products: 4000 }]);
  });
});
