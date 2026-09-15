import { describe, it, expect } from "vitest";
import { categoryPathOf, resolveCategoryPath, type TaxonomyConfig } from "../config";

const BASE: TaxonomyConfig = {
  useSourceTree: ["kicksdb"],
  defaultCategory: "Sneakers",
  rules: [],
  write: { brandTaxonomy: true, brandAttribute: true, genderAttribute: true },
};

const feed = (over: Record<string, string> = {}) => ({
  sku: "IH6001",
  title: "adidas Samba Indoor Cloud White",
  brand: "Adidas",
  source: "goldensneakers",
  category: "Samba",
  secondaryCategory: "Indoor",
  model: "",
  ...over,
});

const kicks = (over: Record<string, string> = {}) => ({
  sku: "IE4931",
  title: "adidas Yeezy Foam RNNR Sulfur",
  brand: "adidas",
  source: "kicksdb",
  category: "Yeezy",
  secondaryCategory: "Foam RNNR",
  model: "Foam RNNR",
  ...over,
});

describe("resolveCategoryPath", () => {
  it("keeps the tree of a source trusted with its own", () => {
    expect(resolveCategoryPath(kicks(), BASE)).toEqual(["Yeezy", "Foam RNNR"]);
  });

  it("files everything else under the default, ignoring its inferred tree", () => {
    // The feed's "Samba › Indoor" is a guess made from the title: it is useful
    // inside the catalog and must not become store taxonomy.
    expect(resolveCategoryPath(feed(), BASE)).toEqual(["Sneakers"]);
  });

  it("lets a rule override the default", () => {
    const config: TaxonomyConfig = {
      ...BASE,
      rules: [
        { id: "r1", enabled: true, scope: { model: "hoodie" }, category: "Abbigliamento" },
      ],
    };
    expect(resolveCategoryPath(feed({ title: "Nike Tech Fleece Hoodie" }), config)).toEqual([
      "Abbigliamento",
    ]);
    expect(resolveCategoryPath(feed(), config)).toEqual(["Sneakers"]);
  });

  it("gives the most specific rule the last word, like a pricing rule does", () => {
    const config: TaxonomyConfig = {
      ...BASE,
      rules: [
        { id: "broad", enabled: true, scope: { source: "goldensneakers" }, category: "Sneakers" },
        { id: "narrow", enabled: true, scope: { brand: "Adidas" }, category: "Adidas Originals" },
        { id: "narrowest", enabled: true, scope: { sku: "IH6001" }, category: "Edizioni limitate" },
      ],
    };
    expect(resolveCategoryPath(feed(), config)).toEqual(["Edizioni limitate"]);
    expect(resolveCategoryPath(feed({ sku: "OTHER" }), config)).toEqual(["Adidas Originals"]);
  });

  it("nests a path written with >", () => {
    const config: TaxonomyConfig = {
      ...BASE,
      rules: [{ id: "r", enabled: true, scope: {}, category: "Abbigliamento > T-shirt" }],
    };
    expect(resolveCategoryPath(feed(), config)).toEqual(["Abbigliamento", "T-shirt"]);
  });

  it("skips a disabled rule and one with no category", () => {
    const config: TaxonomyConfig = {
      ...BASE,
      rules: [
        { id: "off", enabled: false, scope: { sku: "IH6001" }, category: "Mai" },
        { id: "blank", enabled: true, scope: { sku: "IH6001" }, category: "   " },
      ],
    };
    expect(resolveCategoryPath(feed(), config)).toEqual(["Sneakers"]);
  });

  it("writes no category at all when the operator clears the default", () => {
    // Truthful: nobody said where this goes, so the store decides — better
    // than a label this app invented.
    expect(resolveCategoryPath(feed(), { ...BASE, defaultCategory: "" })).toEqual([]);
  });

  it("switches a source from its own tree to the rules when untrusted", () => {
    expect(resolveCategoryPath(kicks(), { ...BASE, useSourceTree: [] })).toEqual(["Sneakers"]);
  });
});

describe("categoryPathOf", () => {
  it("trims, splits and drops the empty parts", () => {
    expect(categoryPathOf("  Abbigliamento >  T-shirt ")).toEqual(["Abbigliamento", "T-shirt"]);
    expect(categoryPathOf(">>")).toEqual([]);
    expect(categoryPathOf("")).toEqual([]);
  });
});
