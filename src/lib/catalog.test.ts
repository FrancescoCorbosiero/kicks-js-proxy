import { describe, it, expect } from "vitest";
import {
  buildCategoryTree,
  filterCatalog,
  CATEGORY_LIMIT,
  SUBCATEGORY_LIMIT,
  type CatalogItem,
  type CategoryCountRow,
} from "./catalog";

const items: CatalogItem[] = [
  { sku: "FV5029-010", title: "Jordan 4 Retro Black Cat", brand: "Jordan" },
  { sku: "DZ5485-612", title: "Jordan 1 Chicago", brand: "Jordan" },
  { sku: "IE5484-100", title: "Samba OG", brand: "adidas" },
];

describe("filterCatalog", () => {
  it("returns everything for a blank query", () => {
    expect(filterCatalog(items, "  ")).toHaveLength(3);
  });

  it("matches on SKU, case-insensitively", () => {
    expect(filterCatalog(items, "fv5029").map((i) => i.sku)).toEqual(["FV5029-010"]);
  });

  it("matches on title", () => {
    expect(filterCatalog(items, "chicago").map((i) => i.sku)).toEqual(["DZ5485-612"]);
  });

  it("matches on brand", () => {
    expect(filterCatalog(items, "adidas").map((i) => i.sku)).toEqual(["IE5484-100"]);
  });

  it("returns empty when nothing matches", () => {
    expect(filterCatalog(items, "yeezy")).toEqual([]);
  });
});

describe("buildCategoryTree — the sidebar is bounded, the catalog is not", () => {
  /** A feed with no real taxonomy: one category per product, as seen in prod. */
  const perModel: CategoryCountRow[] = Array.from({ length: 4000 }, (_, i) => ({
    category: `Family ${i}`,
    secondaryCategory: `Sub ${i}`,
    count: 1,
  }));

  it("renders a bounded tree from an unbounded catalog", () => {
    const { nodes, hidden } = buildCategoryTree(perModel);
    expect(nodes.length).toBe(CATEGORY_LIMIT);
    expect(hidden).toBe(4000 - CATEGORY_LIMIT);
  });

  it("keeps the biggest categories, drops the long thin tail", () => {
    const rows: CategoryCountRow[] = [
      { category: "Rare", secondaryCategory: "", count: 1 },
      ...Array.from({ length: CATEGORY_LIMIT }, (_, i) => ({
        category: `Big ${i}`,
        secondaryCategory: "",
        count: 100 + i,
      })),
    ];
    const { nodes } = buildCategoryTree(rows);
    expect(nodes.some((n) => n.category === "Rare")).toBe(false);
    expect(nodes.length).toBe(CATEGORY_LIMIT);
  });

  it("always keeps the category the URL is filtering by", () => {
    const { nodes } = buildCategoryTree(perModel, "Family 3999");
    expect(nodes.some((n) => n.category === "Family 3999")).toBe(true);
  });

  it("bounds the sub-categories under one category too", () => {
    const rows: CategoryCountRow[] = Array.from({ length: 500 }, (_, i) => ({
      category: "Sneakers",
      secondaryCategory: `Sub ${i}`,
      count: i + 1,
    }));
    const { nodes } = buildCategoryTree(rows, "Sneakers");
    expect(nodes[0].children.length).toBe(SUBCATEGORY_LIMIT);
    // Counts still cover everything, not just the rendered children.
    expect(nodes[0].count).toBe(500 * 501 / 2);
  });

  it("keeps Uncategorized last, and never counts it as hidden", () => {
    const rows: CategoryCountRow[] = [
      { category: "", secondaryCategory: "", count: 7 },
      { category: "Sneakers", secondaryCategory: "", count: 3 },
    ];
    const { nodes, hidden } = buildCategoryTree(rows);
    expect(nodes.at(-1)?.category).toBe("");
    expect(hidden).toBe(0);
  });
});
