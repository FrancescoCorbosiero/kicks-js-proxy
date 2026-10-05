import { describe, it, expect } from "vitest";
import { decodeEntities, gmtToIso, parentsOf, toIndexRow } from "./index-rows";

describe("gmtToIso", () => {
  it("reads WooCommerce's zone-less GMT dates as UTC", () => {
    expect(gmtToIso("2026-10-05T12:00:00")).toBe("2026-10-05T12:00:00.000Z");
    expect(gmtToIso("2026-10-05T12:00:00+02:00")).toBe("2026-10-05T10:00:00.000Z");
    expect(gmtToIso("2026-10-05T12:00:00Z")).toBe("2026-10-05T12:00:00.000Z");
  });

  it("answers null for a date the store does not have", () => {
    expect(gmtToIso(null)).toBeNull();
    expect(gmtToIso("")).toBeNull();
    expect(gmtToIso("not a date")).toBeNull();
  });
});

describe("toIndexRow", () => {
  it("keeps the taxonomies and facts a rule reads", () => {
    const row = toIndexRow({
      id: 42,
      sku: "DD1391-100",
      name: "Nike Dunk Low Panda",
      type: "variable",
      status: "publish",
      permalink: "https://shop/p/dunk",
      categories: [{ id: 10, name: "Saldi", slug: "saldi" }],
      tags: [{ id: 7, name: "saldi", slug: "saldi" }],
      brands: [{ id: 100, name: "Nike", slug: "nike" }],
      attributes: [
        { id: 3, name: "Gender", options: ["Uomo"] },
        { id: 0, name: "Colore", options: ["Bianco", 1] },
      ],
      price: "129.99",
      on_sale: true,
      stock_status: "instock",
      date_created_gmt: "2026-09-01T08:00:00",
      date_modified_gmt: "2026-10-05T12:00:00",
    });
    expect(row).toMatchObject({
      id: 42,
      categories: [{ id: 10, slug: "saldi", name: "Saldi" }],
      tags: [{ id: 7, slug: "saldi", name: "saldi" }],
      brands: [{ id: 100, slug: "nike", name: "Nike" }],
      attributes: [
        { key: "id:3", name: "Gender", options: ["Uomo"] },
        { key: "name:colore", name: "Colore", options: ["Bianco", "1"] },
      ],
      price: 129.99,
      onSale: true,
      stockStatus: "instock",
      dateCreated: "2026-09-01T08:00:00.000Z",
      dateModified: "2026-10-05T12:00:00.000Z",
    });
  });

  it("fills what a store does not send — no brands taxonomy, no price", () => {
    const row = toIndexRow({ id: 1, price: "" });
    expect(row.brands).toEqual([]);
    expect(row.categories).toEqual([]);
    expect(row.price).toBeNull();
    expect(row.onSale).toBe(false);
    expect(row.dateCreated).toBeNull();
  });
});

describe("decodeEntities", () => {
  it("reads names as the shop's pages show them", () => {
    expect(decodeEntities("Saldi &amp; Outlet")).toBe("Saldi & Outlet");
    expect(decodeEntities("Air Force 1 &#8211; White")).toBe("Air Force 1 – White");
    expect(decodeEntities("Kid&#x27;s")).toBe("Kid's");
    expect(decodeEntities("&unknown; &#0; plain")).toBe("&unknown; &#0; plain");
  });
});

describe("parentsOf", () => {
  it("maps every term to its parent, top level as 0", () => {
    expect(parentsOf([{ id: 1 }, { id: 2, parent: 1 }])).toEqual(
      new Map([
        [1, 0],
        [2, 1],
      ]),
    );
  });
});
