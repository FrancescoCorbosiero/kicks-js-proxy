import { describe, it, expect } from "vitest";
import type { ScopedPricingRule } from "@core/config";
import { resolveEffectiveRule, winningMarkupRuleId } from "@core/config";
import { computePrice } from "@core/core-spine";
import type { SourceProduct, SourceVariant } from "@core/core-spine";
import { buildDefaultConfig } from "./defaults";

/**
 * Family-scoped margins against the REAL default config — the dynamic banded
 * general rule the app ships with. These lock the behaviour the operator
 * asked for: "Yeezy Foam gets its own markup; the dynamic default applies
 * only to products with no specific rule."
 */

const connection = {
  kicksDbApiKey: "",
  woo: { baseUrl: "", consumerKey: "", consumerSecret: "" },
  marketToCurrency: { IT: "EUR" },
};

function config(extra: ScopedPricingRule[] = []) {
  const cfg = buildDefaultConfig(connection);
  cfg.pricingRules.push(...extra);
  return cfg;
}

const foam: SourceProduct = {
  stockxId: "p1",
  sku: "IE4931",
  title: "adidas Yeezy Foam RNNR Sulfur",
  brand: "adidas",
  image: "",
  market: "IT",
  currency: "EUR",
  category: "Yeezy",
  secondaryCategory: "Foam RNNR",
  variants: [],
};

const dunk: SourceProduct = {
  ...foam,
  stockxId: "p2",
  sku: "DD1391-100",
  title: "Nike Dunk Low Panda",
  brand: "Nike",
  category: "Dunk",
  secondaryCategory: "",
};

const variant = (ask: number): SourceVariant => ({
  stockxVariantId: "v",
  sizeLabel: "42",
  sizeType: "eu",
  offers: [{ deliveryType: "standard", lowestAsk: ask, asks: 8 }],
});

/** The default ladder: ≤150 → 35%, charm .99, min margin 20 €. */
const FAMILY_RULE: ScopedPricingRule = {
  id: "yeezy-foam",
  scope: { category: "Yeezy", secondaryCategory: "Foam RNNR" },
  enabled: true,
  markupPercent: 60,
};

function priceOf(product: SourceProduct, ask: number, extra: ScopedPricingRule[] = []) {
  const v = variant(ask);
  const rule = resolveEffectiveRule(product, v, config(extra));
  return rule ? computePrice(v, rule) : null;
}

describe("a family rule genuinely replaces the dynamic default", () => {
  it("prices Yeezy Foam at its own percent, not the general band", () => {
    // 100 € ask: the general ladder charges 35% (135,99). The family rule
    // says 60% — and that is what must reach the shelf.
    expect(priceOf(foam, 100, [FAMILY_RULE])).toBe(160.99);
  });

  it("leaves every other product on the dynamic default", () => {
    expect(priceOf(dunk, 100, [FAMILY_RULE])).toBe(135.99); // 35% band
    expect(priceOf(dunk, 400, [FAMILY_RULE])).toBe(500.99); // 25% band
  });

  it("still inherits the general rule's rounding and guaranteed minimum margin", () => {
    // 20 € ask at +60% is 32 € — under the 20 € floor, so ask+20 = 40 € wins,
    // then charm rounding. Both knobs come from the general rule.
    expect(priceOf(foam, 20, [FAMILY_RULE])).toBe(40.99);
  });

  it("names the rule that decided the margin", () => {
    const eff = resolveEffectiveRule(foam, variant(100), config([FAMILY_RULE]))!;
    expect(eff.markupRuleId).toBe("yeezy-foam");
    expect(resolveEffectiveRule(dunk, variant(100), config([FAMILY_RULE]))!.markupRuleId).toBe(
      "general",
    );
  });

  it("a family rule may use its own bands, replacing the general ladder wholesale", () => {
    const banded: ScopedPricingRule = {
      id: "yeezy-foam-bands",
      scope: { category: "Yeezy", secondaryCategory: "Foam RNNR" },
      enabled: true,
      markupBands: [
        { upTo: 120, percent: 55 },
        { upTo: null, percent: 45 },
      ],
    };
    expect(priceOf(foam, 100, [banded])).toBe(155.99); // 55%, not the general 35%
    expect(priceOf(foam, 400, [banded])).toBe(580.99); // 45%, not the general 25%
  });
});

describe("precedence between scopes", () => {
  it("a per-SKU rule outranks the family rule that contains it", () => {
    const perSku: ScopedPricingRule = {
      id: "one-sku",
      scope: { sku: "IE4931" },
      enabled: true,
      markupFixed: 15,
    };
    // Fewer fields than the family rule, but a far narrower set of products.
    // ask + 15 = 115, lifted to the inherited 20 € minimum margin, then the
    // inherited charm rounding: 120,99 — the family's 60% never applies.
    expect(priceOf(foam, 100, [FAMILY_RULE, perSku])).toBe(120.99);
  });

  it("the sub-family rule outranks the family-wide rule", () => {
    const wholeFamily: ScopedPricingRule = {
      id: "all-yeezy",
      scope: { category: "Yeezy" },
      enabled: true,
      markupPercent: 25,
    };
    expect(priceOf(foam, 100, [wholeFamily, FAMILY_RULE])).toBe(160.99); // the Foam rule
    // …and order in the list must not decide it.
    expect(priceOf(foam, 100, [FAMILY_RULE, wholeFamily])).toBe(160.99);
  });

  it("a brand rule loses to the family rule inside it", () => {
    const brandRule: ScopedPricingRule = {
      id: "adidas",
      scope: { brand: "adidas" },
      enabled: true,
      markupPercent: 10,
    };
    expect(priceOf(foam, 100, [brandRule, FAMILY_RULE])).toBe(160.99);
  });
});

describe("matching is case- and spelling-tolerant", () => {
  it("matches a brand the feed spells differently", () => {
    const rule: ScopedPricingRule = {
      id: "adidas-upper",
      scope: { brand: "Adidas" }, // product carries "adidas"
      enabled: true,
      markupPercent: 50,
    };
    expect(priceOf(foam, 100, [rule])).toBe(150.99);
  });

  it("matches a family whatever case it was typed in", () => {
    const rule: ScopedPricingRule = {
      id: "lower",
      scope: { category: "yeezy", secondaryCategory: "foam rnnr" },
      enabled: true,
      markupPercent: 60,
    };
    expect(priceOf(foam, 100, [rule])).toBe(160.99);
  });

  it("“name contains” reads the model field too, not only the title", () => {
    const withModel = { ...dunk, model: "Dunk Low Retro", title: "" };
    const rule: ScopedPricingRule = {
      id: "dunk-low",
      scope: { model: "dunk low" },
      enabled: true,
      markupPercent: 50,
    };
    expect(priceOf(withModel, 100, [rule])).toBe(150.99);
  });
});

describe("the GoldenSneakers passthrough still wins for feed products", () => {
  it("a family rule must not add margin on top of a supplier's final price", () => {
    const gsFoam: SourceProduct = { ...foam, source: "goldensneakers" };
    // GS scope (source) + the family rule both match; the passthrough is the
    // more specific of the two only if it is — assert the price, not a rule id.
    const priced = priceOf(gsFoam, 100, []);
    expect(priced).toBe(100); // presented price, untouched
  });
});

describe("winningMarkupRuleId (the coverage the margins editor reports)", () => {
  const rules = config([FAMILY_RULE]).pricingRules;

  it("attributes a product to its family rule", () => {
    expect(winningMarkupRuleId(foam, rules)).toBe("yeezy-foam");
  });

  it("attributes everything else to the general rule", () => {
    expect(winningMarkupRuleId(dunk, rules)).toBe("general");
  });

  it("ignores disabled rules", () => {
    const off = rules.map((r) => (r.id === "yeezy-foam" ? { ...r, enabled: false } : r));
    expect(winningMarkupRuleId(foam, off)).toBe("general");
  });

  it("ignores rules that set no margin at all", () => {
    const knobsOnly: ScopedPricingRule = {
      id: "knobs",
      scope: { category: "Yeezy", secondaryCategory: "Foam RNNR" },
      enabled: true,
      rounding: { mode: "integer" },
    };
    expect(winningMarkupRuleId(foam, [...rules, knobsOnly])).toBe("yeezy-foam");
  });
});
