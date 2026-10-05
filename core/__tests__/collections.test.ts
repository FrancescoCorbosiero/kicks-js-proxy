import { describe, it, expect } from "vitest";
import {
  attributeKey,
  collectionMatches,
  decideProduct,
  holdReason,
  orderCollections,
  parseNumber,
  planCollections,
  previewCollection,
  readsItself,
  ruleProblems,
  withAncestors,
  type CollectionCondition,
  type EvalContext,
  type IndexedProduct,
  type SmartCollection,
} from "../collections";

const NOW = Date.parse("2026-10-05T12:00:00Z");
const DAY = 86_400_000;

// Categories: 10 Saldi (child 11 Saldi Nike), 20 Novità, 30 Sneakers, 40 In evidenza.
// Brands: 100 Nike (child 101 Nike Off-White), 200 Adidas.
const CTX: EvalContext = {
  now: NOW,
  categoryParents: new Map([
    [10, 0],
    [11, 10],
    [20, 0],
    [30, 0],
    [40, 0],
  ]),
  brandParents: new Map([
    [100, 0],
    [101, 100],
    [200, 0],
  ]),
};

const term = (id: number, slug = `t${id}`) => ({ id, slug, name: slug });

let nextId = 1;
function product(over: Partial<IndexedProduct> = {}): IndexedProduct {
  return {
    id: nextId++,
    sku: "SKU",
    name: "Nike Dunk Low Panda",
    status: "publish",
    categories: [term(30, "sneakers")],
    tags: [],
    brands: [term(100, "nike")],
    attributes: [],
    price: 129.99,
    onSale: false,
    stockStatus: "instock",
    dateCreated: new Date(NOW - 100 * DAY).toISOString(),
    ...over,
  };
}

function collection(over: Partial<SmartCollection> & { conditions: CollectionCondition[] }): SmartCollection {
  return { id: `c${over.termId ?? 10}`, termId: 10, name: "Saldi", match: "all", enabled: true, ...over };
}

const view = (p: IndexedProduct) => ({ product: p, categoryIds: new Set(p.categories.map((c) => c.id)) });
const matches = (conditions: CollectionCondition[], p: IndexedProduct, match: "all" | "any" = "all") =>
  collectionMatches({ match, conditions }, view(p), CTX);

describe("conditions", () => {
  it("reads a tag by its id", () => {
    const tagged = product({ tags: [term(7, "saldi")] });
    expect(matches([{ field: "tag", op: "is", value: "7" }], tagged)).toBe(true);
    expect(matches([{ field: "tag", op: "is", value: "8" }], tagged)).toBe(false);
    expect(matches([{ field: "tag", op: "isNot", value: "7" }], tagged)).toBe(false);
    expect(matches([{ field: "tag", op: "isNot", value: "7" }], product())).toBe(true);
  });

  it("counts a sub-brand under its brand, not the other way round", () => {
    const offWhite = product({ brands: [term(101, "nike-off-white")] });
    expect(matches([{ field: "brand", op: "is", value: "100" }], offWhite)).toBe(true);
    expect(matches([{ field: "brand", op: "is", value: "101" }], product())).toBe(false);
  });

  it("counts a sub-category under its category", () => {
    const inSaldiNike = product({ categories: [term(11)] });
    expect(matches([{ field: "category", op: "is", value: "10" }], inSaldiNike)).toBe(true);
    expect(matches([{ field: "category", op: "isNot", value: "10" }], inSaldiNike)).toBe(false);
    expect(matches([{ field: "category", op: "is", value: "11" }], product({ categories: [term(10)] }))).toBe(false);
  });

  it("reads an attribute by its key, the option in any case", () => {
    const p = product({ attributes: [{ key: attributeKey(3, "Gender"), name: "Gender", options: ["Uomo"] }] });
    expect(matches([{ field: "attribute", op: "is", attribute: "id:3", value: "uomo" }], p)).toBe(true);
    expect(matches([{ field: "attribute", op: "is", attribute: "id:3", value: "Donna" }], p)).toBe(false);
    expect(matches([{ field: "attribute", op: "is", attribute: "id:4", value: "Uomo" }], p)).toBe(false);
    expect(matches([{ field: "attribute", op: "isNot", attribute: "id:3", value: "Donna" }], p)).toBe(true);
  });

  it("keys a global attribute by id and a product's own by name", () => {
    expect(attributeKey(3, "Gender")).toBe("id:3");
    expect(attributeKey(0, " Colore ")).toBe("name:colore");
    expect(attributeKey(null, "Colore")).toBe("name:colore");
  });

  it("finds text in the name, in any case", () => {
    expect(matches([{ field: "title", op: "contains", value: "PANDA" }], product())).toBe(true);
    expect(matches([{ field: "title", op: "notContains", value: "panda" }], product())).toBe(false);
    // An empty needle would match everything: it matches nothing instead.
    expect(matches([{ field: "title", op: "contains", value: "  " }], product())).toBe(false);
  });

  it("compares the price, reading a comma as the decimal point", () => {
    expect(matches([{ field: "price", op: "lt", value: "129,999" }], product())).toBe(true);
    expect(matches([{ field: "price", op: "gt", value: "130" }], product())).toBe(false);
    // No price: neither cheaper nor dearer than anything.
    expect(matches([{ field: "price", op: "lt", value: "1000" }], product({ price: null }))).toBe(false);
    expect(matches([{ field: "price", op: "gt", value: "abc" }], product())).toBe(false);
  });

  it("reads on sale and in stock, back-orderable counting as available", () => {
    expect(matches([{ field: "onSale", op: "is", value: "" }], product({ onSale: true }))).toBe(true);
    expect(matches([{ field: "onSale", op: "isNot", value: "" }], product({ onSale: true }))).toBe(false);
    expect(matches([{ field: "inStock", op: "is", value: "" }], product({ stockStatus: "onbackorder" }))).toBe(true);
    expect(matches([{ field: "inStock", op: "is", value: "" }], product({ stockStatus: "outofstock" }))).toBe(false);
    expect(matches([{ field: "inStock", op: "isNot", value: "" }], product({ stockStatus: "outofstock" }))).toBe(true);
  });

  it("tells new from old by the creation date", () => {
    const fresh = product({ dateCreated: new Date(NOW - 3 * DAY).toISOString() });
    expect(matches([{ field: "created", op: "withinDays", value: "30" }], fresh)).toBe(true);
    expect(matches([{ field: "created", op: "withinDays", value: "30" }], product())).toBe(false);
    expect(matches([{ field: "created", op: "olderThanDays", value: "30" }], product())).toBe(true);
    expect(matches([{ field: "created", op: "withinDays", value: "30" }], product({ dateCreated: null }))).toBe(false);
  });

  it("needs every condition, or any one, as asked — and none matches nothing", () => {
    const conditions: CollectionCondition[] = [
      { field: "onSale", op: "is", value: "" },
      { field: "brand", op: "is", value: "100" },
    ];
    expect(matches(conditions, product())).toBe(false);
    expect(matches(conditions, product(), "any")).toBe(true);
    expect(matches([], product())).toBe(false);
    expect(matches([], product(), "any")).toBe(false);
  });

  it("parses numbers the way an Italian keyboard types them", () => {
    expect(parseNumber("99,90")).toBe(99.9);
    expect(parseNumber(" 12 ")).toBe(12);
    expect(parseNumber("")).toBeNaN();
  });
});

describe("decideProduct", () => {
  const saldi = collection({ conditions: [{ field: "tag", op: "is", value: "7" }] });

  it("adds the category to a product that starts matching, keeping its others in place", () => {
    const p = product({ categories: [term(30), term(40)], tags: [term(7)] });
    const d = decideProduct(p, [saldi], CTX);
    expect(d.after).toEqual([30, 40, 10]);
    expect(d.joined).toEqual([saldi.id]);
  });

  it("takes out a product that stops matching — whoever put it there", () => {
    const p = product({ categories: [term(10), term(30)] });
    const d = decideProduct(p, [saldi], CTX);
    expect(d.after).toEqual([30]);
    expect(d.left).toEqual([saldi.id]);
  });

  it("leaves a paused or frozen collection's members alone", () => {
    const p = product({ categories: [term(10)] });
    expect(decideProduct(p, [{ ...saldi, enabled: false }], CTX).after).toEqual([10]);
    expect(decideProduct(p, [saldi], CTX, new Set([saldi.id])).after).toEqual([10]);
  });

  it("never touches a category no collection manages", () => {
    const p = product({ categories: [term(30), term(20)], tags: [term(7)] });
    const d = decideProduct(p, [saldi], CTX);
    expect(d.after).toContain(20);
    expect(d.after).toContain(30);
  });
});

describe("orderCollections", () => {
  const novita = collection({ id: "novita", termId: 20, name: "Novità", conditions: [{ field: "created", op: "withinDays", value: "30" }] });
  // "In evidenza" = new AND not in Saldi: reads two other collections' categories.
  const evidenza = collection({
    id: "evidenza",
    termId: 40,
    name: "In evidenza",
    conditions: [
      { field: "category", op: "is", value: "20" },
      { field: "category", op: "isNot", value: "10" },
    ],
  });
  const saldi = collection({ id: "saldi", termId: 10, conditions: [{ field: "onSale", op: "is", value: "" }] });

  it("decides a collection after the ones whose category it reads", () => {
    const { ordered, cyclic } = orderCollections([evidenza, novita, saldi], CTX.categoryParents);
    expect(cyclic).toEqual([]);
    const at = (id: string) => ordered.findIndex((c) => c.id === id);
    expect(at("evidenza")).toBeGreaterThan(at("novita"));
    expect(at("evidenza")).toBeGreaterThan(at("saldi"));
  });

  it("so one pass sees the categories as they will be", () => {
    // New, not on sale, sitting in Saldi by hand: leaves Saldi, joins Novità,
    // and therefore joins In evidenza — all in the same run.
    const p = product({ categories: [term(10)], dateCreated: new Date(NOW - DAY).toISOString() });
    const { ordered } = orderCollections([evidenza, novita, saldi], CTX.categoryParents);
    const d = decideProduct(p, ordered, CTX);
    expect(new Set(d.after)).toEqual(new Set([20, 40]));
  });

  it("sets a loop aside, and still decides whoever reads it", () => {
    const a = collection({ id: "a", termId: 20, name: "A", conditions: [{ field: "category", op: "is", value: "40" }] });
    const b = collection({ id: "b", termId: 40, name: "B", conditions: [{ field: "category", op: "is", value: "20" }] });
    const c = collection({ id: "c", termId: 30, name: "C", conditions: [{ field: "category", op: "is", value: "20" }] });
    const { ordered, cyclic } = orderCollections([a, b, c], CTX.categoryParents);
    expect(cyclic.map((x) => x.id).sort()).toEqual(["a", "b"]);
    expect(ordered.map((x) => x.id)).toEqual(["c"]);
  });

  it("refuses a rule that reads its own category, or a parent of it", () => {
    expect(readsItself(collection({ termId: 10, conditions: [{ field: "category", op: "is", value: "10" }] }), CTX.categoryParents)).toBe(true);
    expect(readsItself(collection({ termId: 11, conditions: [{ field: "category", op: "isNot", value: "10" }] }), CTX.categoryParents)).toBe(true);
    // A sub-category is input, not itself.
    expect(readsItself(collection({ termId: 10, conditions: [{ field: "category", op: "is", value: "11" }] }), CTX.categoryParents)).toBe(false);
  });
});

describe("planCollections", () => {
  const saldi = collection({ id: "saldi", termId: 10, conditions: [{ field: "tag", op: "is", value: "7" }] });

  it("lists who joins, who leaves, and only the products that change", () => {
    const joins = product({ tags: [term(7)] });
    const leaves = product({ categories: [term(10)] });
    const stays = product({ categories: [term(10)], tags: [term(7)] });
    const outside = product();
    const plan = planCollections([joins, leaves, stays, outside], [saldi], CTX);
    const diff = plan.diffs.get("saldi")!;
    expect(diff.joining).toEqual([joins.id]);
    expect(diff.leaving).toEqual([leaves.id]);
    expect(diff.before).toBe(2);
    expect(diff.after).toBe(2);
    expect(plan.changed.map((d) => d.productId).sort()).toEqual([joins.id, leaves.id].sort());
  });

  it("never lets an automatic run empty a category", () => {
    // The tag was deleted in WP admin: the rule now matches nobody.
    const members = [product({ categories: [term(10)] }), product({ categories: [term(10)] })];
    const plan = planCollections(members, [saldi], CTX, { limits: { maxChanges: 100 } });
    expect(plan.held.get("saldi")?.reason).toBe("empties");
    expect(plan.changed).toEqual([]);
  });

  it("holds a change bigger than the limit, unless it was confirmed", () => {
    const tagged = Array.from({ length: 5 }, () => product({ tags: [term(7)] }));
    const held = planCollections(tagged, [saldi], CTX, { limits: { maxChanges: 3 } });
    expect(held.held.get("saldi")?.reason).toBe("tooManyChanges");
    expect(held.held.get("saldi")?.diff.joining).toHaveLength(5);
    expect(held.changed).toEqual([]);
    const confirmed = planCollections(tagged, [saldi], CTX, { limits: { maxChanges: 3 }, confirmed: new Set(["saldi"]) });
    expect(confirmed.held.size).toBe(0);
    expect(confirmed.changed).toHaveLength(5);
  });

  it("re-decides whoever reads a held category", () => {
    // Saldi would empty (held), so "Outlet = in Saldi" must see Saldi as it
    // stands — its members stay in Outlet instead of following a change that
    // did not happen.
    const outlet = collection({ id: "outlet", termId: 40, name: "Outlet", conditions: [{ field: "category", op: "is", value: "10" }] });
    const members = [product({ categories: [term(10), term(40)] }), product({ categories: [term(10), term(40)] })];
    const plan = planCollections(members, [saldi, outlet], CTX, { limits: { maxChanges: 100 } });
    expect(plan.held.get("saldi")?.reason).toBe("empties");
    expect(plan.held.has("outlet")).toBe(false);
    expect(plan.changed).toEqual([]);
  });

  it("still holds a reader whose own change is too big once its input is held", () => {
    // Outlet = in Saldi OR on sale. Saldi empties (held); Outlet's own on-sale
    // arrivals are still more than the limit, judged in the next round.
    const outlet = collection({
      id: "outlet",
      termId: 40,
      name: "Outlet",
      match: "any",
      conditions: [
        { field: "category", op: "is", value: "10" },
        { field: "onSale", op: "is", value: "" },
      ],
    });
    const members = [product({ categories: [term(10), term(40)] })];
    const onSale = Array.from({ length: 4 }, () => product({ onSale: true }));
    const plan = planCollections([...members, ...onSale], [saldi, outlet], CTX, { limits: { maxChanges: 3 } });
    expect(plan.held.get("saldi")?.reason).toBe("empties");
    expect(plan.held.get("outlet")?.reason).toBe("tooManyChanges");
    expect(plan.changed).toEqual([]);
  });

  it("decides as asked without limits (a change made by hand)", () => {
    const members = [product({ categories: [term(10)] })];
    const plan = planCollections(members, [saldi], CTX);
    expect(plan.held.size).toBe(0);
    expect(plan.diffs.get("saldi")!.after).toBe(0);
  });
});

describe("holdReason", () => {
  const diff = { collectionId: "x", termId: 1, before: 3, after: 3, joining: [1], leaving: [2] };
  it("passes an ordinary change", () => {
    expect(holdReason(diff, { maxChanges: 10 })).toBeNull();
  });
  it("holds emptying before size", () => {
    expect(holdReason({ ...diff, after: 0, leaving: [1, 2, 3] }, { maxChanges: 1 })).toBe("empties");
  });
  it("lets an empty category stay empty", () => {
    expect(holdReason({ ...diff, before: 0, after: 0, joining: [], leaving: [] }, { maxChanges: 1 })).toBeNull();
  });
});

describe("previewCollection", () => {
  it("counts the change, names a few, and warns about products left with no category", () => {
    const draft = collection({ id: "new", termId: 10, conditions: [{ field: "brand", op: "is", value: "200" }] });
    const adidas = product({ name: "adidas Samba", brands: [term(200)] });
    const alone = product({ name: "Nike Air Max", categories: [term(10)] });
    const notAlone = product({ name: "Nike Air Force", categories: [term(10), term(30)] });
    const preview = previewCollection([adidas, alone, notAlone], [], draft, CTX);
    expect(preview.before).toBe(2);
    expect(preview.after).toBe(1);
    expect(preview.joiningCount).toBe(1);
    expect(preview.leavingCount).toBe(2);
    expect(preview.leaving.map((p) => p.name)).toEqual(["Nike Air Force", "Nike Air Max"]);
    expect(preview.orphaned).toBe(1);
  });

  it("previews a paused draft as if it were on", () => {
    const draft = collection({ id: "x", enabled: false, conditions: [{ field: "tag", op: "is", value: "7" }] });
    expect(previewCollection([product({ tags: [term(7)] })], [], draft, CTX).joiningCount).toBe(1);
  });
});

describe("ruleProblems", () => {
  const base = collection({ id: "draft", termId: 10, conditions: [{ field: "tag", op: "is", value: "7" }] });

  it("accepts a sound rule", () => {
    expect(ruleProblems(base, [], CTX.categoryParents)).toEqual([]);
  });

  it("asks for at least one condition", () => {
    expect(ruleProblems({ ...base, conditions: [] }, [], CTX.categoryParents)).toContainEqual({ kind: "noConditions" });
  });

  it("points at a condition with no usable value", () => {
    const bad: CollectionCondition[] = [
      { field: "tag", op: "is", value: "" },
      { field: "title", op: "contains", value: " " },
      { field: "price", op: "gt", value: "tanti" },
      { field: "attribute", op: "is", value: "Uomo" },
      { field: "created", op: "withinDays", value: "-3" },
      { field: "onSale", op: "is", value: "" },
    ];
    const problems = ruleProblems({ ...base, conditions: bad }, [], CTX.categoryParents);
    expect(problems.filter((p) => p.kind === "badValue").map((p) => (p as { index: number }).index)).toEqual([0, 1, 2, 3, 4]);
  });

  it("refuses an operator the field does not take", () => {
    const problems = ruleProblems({ ...base, conditions: [{ field: "tag", op: "gt", value: "7" }] }, [], CTX.categoryParents);
    expect(problems).toContainEqual({ kind: "badOperator", index: 0 });
  });

  it("refuses a rule that reads its own category", () => {
    const problems = ruleProblems(
      { ...base, conditions: [{ field: "category", op: "isNot", value: "10" }] },
      [],
      CTX.categoryParents,
    );
    expect(problems).toContainEqual({ kind: "readsItself", index: 0 });
  });

  it("gives a category to one collection only", () => {
    const owner = collection({ id: "other", termId: 10, name: "Saldi", conditions: base.conditions });
    expect(ruleProblems(base, [owner], CTX.categoryParents)).toContainEqual({ kind: "categoryTaken", by: "Saldi" });
  });

  it("refuses a rule that closes a loop, naming the other side", () => {
    const novita = collection({ id: "novita", termId: 20, name: "Novità", conditions: [{ field: "category", op: "is", value: "10" }] });
    const draft = { ...base, conditions: [{ field: "category" as const, op: "is" as const, value: "20" }] };
    expect(ruleProblems(draft, [novita], CTX.categoryParents)).toContainEqual({ kind: "loop", with: ["Novità"] });
    // Paused, it closes nothing.
    expect(ruleProblems({ ...draft, enabled: false }, [novita], CTX.categoryParents)).toEqual([]);
  });
});

describe("withAncestors", () => {
  it("climbs to the top, and survives a loop in bad data", () => {
    expect(withAncestors([11], CTX.categoryParents)).toEqual(new Set([11, 10]));
    const loop = new Map([
      [1, 2],
      [2, 1],
    ]);
    expect(withAncestors([1], loop)).toEqual(new Set([1, 2]));
  });
});
