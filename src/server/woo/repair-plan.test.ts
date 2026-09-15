import { describe, it, expect } from "vitest";
import { planRepair, type LiveProduct, type RepairSource } from "./repair-plan";

const SOURCE: RepairSource = {
  images: ["https://www.goldensneakers.net/images/DM0032-601/main/a.png"],
  identity: {
    brandId: 7,
    categoryIds: [11],
    attributes: [
      { id: 2, option: "Nike", field: "brand" },
      { id: 3, option: "women", field: "gender" },
    ],
  },
  wantsGender: true,
};

/** A product published while the feed's image fields were unreadable. */
const BROKEN: LiveProduct = {
  id: 900,
  images: [],
  brands: [],
  // Woo files a product with no category under its default term.
  categories: [{ id: 15, slug: "senza-categoria", name: "Senza categoria" }],
  attributes: [{ id: 9, name: "pa_taglia", variation: true, options: ["42", "43"] }],
};

describe("planRepair", () => {
  it("fills every gap of a product that landed incomplete", () => {
    const patch = planRepair(BROKEN, SOURCE);
    expect(patch.fills.sort()).toEqual(["brand", "category", "gender", "image"]);
    expect(patch.body.images).toEqual([{ src: SOURCE.images[0] }]);
    expect(patch.body.brands).toEqual([{ id: 7 }]);
    expect(patch.body.categories).toEqual([{ id: 11 }]);
    expect(patch.unavailable).toEqual([]);
  });

  it("never drops an attribute the store already has", () => {
    // Woo replaces the whole attribute array on update: losing pa_taglia here
    // would orphan every variation of the product.
    const attributes = planRepair(BROKEN, SOURCE).body.attributes as Record<string, unknown>[];
    expect(attributes[0]).toEqual((BROKEN.attributes as unknown[])[0]);
    expect(attributes.map((a) => a.id)).toEqual([9, 2, 3]);
    expect(attributes.slice(1).every((a) => a.variation === false)).toBe(true);
  });

  it("leaves a whole product completely alone", () => {
    const whole: LiveProduct = {
      id: 901,
      images: [{ id: 1, src: "https://cdn.example.com/hand-uploaded.png" }],
      brands: [{ id: 7 }],
      categories: [{ id: 11, slug: "sneakers" }],
      attributes: [
        { id: 9, name: "pa_taglia", options: ["42"] },
        { id: 2, name: "pa_brand", options: ["Nike"] },
        { id: 3, name: "pa_gender", options: ["women"] },
      ],
    };
    const patch = planRepair(whole, SOURCE);
    expect(patch.fills).toEqual([]);
    expect(patch.body).toEqual({});
  });

  it("never replaces what the operator put there", () => {
    // A picture uploaded by hand outranks the feed's: the operator saw the
    // product, the feed did not.
    const curated: LiveProduct = {
      ...BROKEN,
      images: [{ id: 1, src: "https://cdn.example.com/better-photo.png" }],
      categories: [{ id: 42, slug: "offerte-del-mese" }],
    };
    const patch = planRepair(curated, SOURCE);
    expect(patch.body.images).toBeUndefined();
    expect(patch.body.categories).toBeUndefined();
    expect(patch.fills.sort()).toEqual(["brand", "gender"]);
  });

  it("is idempotent: applying its own result leaves nothing to do", () => {
    const patch = planRepair(BROKEN, SOURCE);
    const after: LiveProduct = {
      id: BROKEN.id,
      images: (patch.body.images as { src: string }[]).map((i, n) => ({ id: n, src: i.src })),
      brands: patch.body.brands,
      categories: patch.body.categories,
      attributes: patch.body.attributes,
    };
    expect(planRepair(after, SOURCE).fills).toEqual([]);
  });

  it("reports a gap the source cannot close instead of inventing one", () => {
    const patch = planRepair(BROKEN, { images: [], identity: undefined, wantsGender: true });
    expect(patch.body).toEqual({});
    expect(patch.fills).toEqual([]);
    expect(patch.unavailable.sort()).toEqual(["brand", "category", "gender", "image"]);
  });

  it("treats an empty-optioned attribute as absent", () => {
    const hollow: LiveProduct = {
      ...BROKEN,
      attributes: [{ id: 3, name: "pa_gender", options: [] }],
    };
    expect(planRepair(hollow, SOURCE).fills).toContain("gender");
  });
});
