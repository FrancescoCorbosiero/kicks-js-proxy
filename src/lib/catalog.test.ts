import { describe, it, expect } from "vitest";
import { filterCatalog, type CatalogItem } from "./catalog";

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
