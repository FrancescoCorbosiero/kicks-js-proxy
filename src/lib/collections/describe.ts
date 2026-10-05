import type { CollectionCondition } from "@core/collections";

/**
 * A rule in words — "Tag «saldi» e disponibile" — for the cards that show a
 * collection without opening it, in the Hub and in the Vetrina alike.
 */

export interface RuleWords {
  tag: { is: (v: string) => string; isNot: (v: string) => string };
  brand: { is: (v: string) => string; isNot: (v: string) => string };
  category: { is: (v: string) => string; isNot: (v: string) => string };
  attribute: { is: (name: string, v: string) => string; isNot: (name: string, v: string) => string };
  title: { contains: (v: string) => string; notContains: (v: string) => string };
  price: { gt: (v: string) => string; lt: (v: string) => string };
  onSale: { is: string; isNot: string };
  inStock: { is: string; isNot: string };
  created: { withinDays: (n: string) => string; olderThanDays: (n: string) => string };
  and: string;
  or: string;
  /** A term that has no name to show (deleted on the store, never labelled). */
  unknown: string;
}

export function describeCondition(c: CollectionCondition, w: RuleWords): string {
  const name = c.label?.trim() || (c.field === "attribute" ? c.attribute ?? "" : "") || w.unknown;
  const not = c.op === "isNot";
  switch (c.field) {
    case "tag":
      return not ? w.tag.isNot(name) : w.tag.is(name);
    case "brand":
      return not ? w.brand.isNot(name) : w.brand.is(name);
    case "category":
      return not ? w.category.isNot(name) : w.category.is(name);
    case "attribute":
      return not ? w.attribute.isNot(name, c.value) : w.attribute.is(name, c.value);
    case "title":
      return c.op === "notContains" ? w.title.notContains(c.value) : w.title.contains(c.value);
    case "price":
      return c.op === "lt" ? w.price.lt(c.value) : w.price.gt(c.value);
    case "onSale":
      return not ? w.onSale.isNot : w.onSale.is;
    case "inStock":
      return not ? w.inStock.isNot : w.inStock.is;
    case "created":
      return c.op === "olderThanDays" ? w.created.olderThanDays(c.value) : w.created.withinDays(c.value);
  }
}

export function describeRule(rule: { match: "all" | "any"; conditions: CollectionCondition[] }, w: RuleWords): string {
  const text = rule.conditions.map((c) => describeCondition(c, w)).join(rule.match === "all" ? w.and : w.or);
  return text.charAt(0).toUpperCase() + text.slice(1);
}
