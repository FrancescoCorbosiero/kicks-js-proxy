"use server";

import { z } from "zod";
import type { AppConfig, ScopedPricingRule } from "@core/config";
import { resolveEffectiveRule, scopeTargetsSizes, winningMarkupRuleId } from "@core/config";
import type { SourceProduct, SourceVariant } from "@core/core-spine";
import { computePrice } from "@core/core-spine";
import { listProductScopeAxes } from "@/server/catalog/repo";
import { clearConfig, getActiveConfig, saveActiveConfig } from "@/server/config/repo";
import { pricingSummary, type PricingSummary } from "@/server/config/summary";

/**
 * Restore the DEFAULT margin from defaults.ts — the dynamic banded catch-all
 * and the GoldenSneakers passthrough — and keep every scoped rule the operator
 * wrote. Reset lives on a bar that edits the general rule, so it must mean
 * "put the default back", not "delete the Yeezy Foam rule I built last week".
 */
export async function resetPricingToDefaults(): Promise<PricingSummary> {
  const current = await getActiveConfig().catch(() => null);
  const kept = (current?.pricingRules ?? []).filter(
    (r) => Object.keys(r.scope).length > 0 && r.scope.source !== "goldensneakers",
  );

  await clearConfig();
  const fresh = await getActiveConfig();
  if (kept.length > 0) {
    fresh.pricingRules = [...fresh.pricingRules, ...kept];
    await saveActiveConfig(fresh);
  }
  return pricingSummary(fresh);
}

const PricingInputSchema = z.object({
  markupPercent: z.number().min(0).max(1000),
  vatRatePercent: z.number().min(0).max(100),
  roundingMode: z.enum(["none", "integer", "charm", "nearest"]),
  increment: z.number().min(0).optional(),
  minAsks: z.number().int().min(0),
  minDeltaPercent: z.number().min(0).max(100),
});
export type PricingInput = z.infer<typeof PricingInputSchema>;

/** Update the general pricing rule (markup / VAT / rounding / minAsks / min delta) and save. */
export async function updatePricing(
  input: PricingInput,
): Promise<{ ok: boolean; error?: string; summary?: PricingSummary }> {
  const parsed = PricingInputSchema.safeParse(input);
  if (!parsed.success) {
    return { ok: false, error: parsed.error.issues.map((i) => i.message).join("; ") };
  }
  const d = parsed.data;

  const cfg = await getActiveConfig();
  const rule = cfg.pricingRules[0] ?? {
    id: "general",
    scope: {},
    enabled: true,
    sourceDeliveryType: "standard" as const,
  };
  rule.markupPercent = d.markupPercent;
  // Saving an explicit flat markup switches banded pricing off — the operator
  // chose a single percent. "Reset" restores the banded defaults.
  delete rule.markupBands;
  rule.minAsks = d.minAsks;
  // 0 = off (reprice on any change) — stored as absence, like maxDeltaPercent.
  if (d.minDeltaPercent > 0) rule.minDeltaPercent = d.minDeltaPercent;
  else delete rule.minDeltaPercent;
  rule.rounding = {
    mode: d.roundingMode,
    ...(d.increment != null ? { increment: d.increment } : {}),
  };
  // VAT is added on top ONLY when the operator sets a rate here; 0 means the
  // markup is the total uplift (VAT inside the price) — the banded default.
  rule.tax = { priceIncludesVat: d.vatRatePercent > 0, vatRatePercent: d.vatRatePercent };
  if (cfg.pricingRules.length === 0) cfg.pricingRules.push(rule);

  try {
    await saveActiveConfig(cfg);
    return { ok: true, summary: pricingSummary(cfg) };
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : String(e) };
  }
}

/* ------------------------------------------------------------------ */
/* Margin rules admin (/pricing): full CRUD over the scoped rule list  */
/* ------------------------------------------------------------------ */

const ScopeSchema = z.object({
  source: z.string().max(64).optional(),
  brand: z.string().max(128).optional(),
  // The catalog's navigation axes — a rule scoped to a product FAMILY.
  category: z.string().max(128).optional(),
  secondaryCategory: z.string().max(128).optional(),
  model: z.string().max(128).optional(),
  sku: z.string().max(64).optional(),
  sizeType: z.string().max(32).optional(),
  sizeMin: z.number().min(0).max(100).optional(),
  sizeMax: z.number().min(0).max(100).optional(),
});

const BandSchema = z.object({
  upTo: z.number().positive().nullable(),
  percent: z.number().min(-100).max(1000),
});

const RuleSchema = z.object({
  id: z.string().min(1).max(64),
  enabled: z.boolean(),
  scope: ScopeSchema,
  sourceDeliveryType: z.enum(["standard", "express_standard", "express_expedited"]).optional(),
  markupPercent: z.number().min(-100).max(1000).optional(),
  markupFixed: z.number().min(-10000).max(10000).optional(),
  markupBands: z.array(BandSchema).max(20).optional(),
  floor: z.number().min(0).optional(),
  minAsks: z.number().int().min(0).optional(),
  rounding: z
    .object({
      mode: z.enum(["none", "integer", "charm", "nearest"]),
      increment: z.number().min(0).optional(),
    })
    .optional(),
  tax: z
    .object({ priceIncludesVat: z.boolean(), vatRatePercent: z.number().min(0).max(100) })
    .optional(),
  minDeltaPercent: z.number().min(0).max(100).optional(),
  maxDeltaPercent: z.number().min(0).max(1000).optional(),
  outlierFloorPercent: z.number().min(0).max(100).optional(),
  minMarginFixed: z.number().min(0).max(10000).optional(),
});

const RulesSchema = z.array(RuleSchema).min(1).max(100);

/** Strip empty-string scope fields so "" never over-constrains a rule. */
function cleanScope(scope: z.infer<typeof ScopeSchema>): ScopedPricingRule["scope"] {
  const out: ScopedPricingRule["scope"] = {};
  if (scope.source?.trim()) out.source = scope.source.trim();
  if (scope.brand?.trim()) out.brand = scope.brand.trim();
  if (scope.category?.trim()) out.category = scope.category.trim();
  if (scope.secondaryCategory?.trim()) out.secondaryCategory = scope.secondaryCategory.trim();
  if (scope.model?.trim()) out.model = scope.model.trim();
  if (scope.sku?.trim()) out.sku = scope.sku.trim().toUpperCase();
  if (scope.sizeType?.trim()) out.sizeType = scope.sizeType.trim();
  if (scope.sizeMin != null) out.sizeMin = scope.sizeMin;
  if (scope.sizeMax != null) out.sizeMax = scope.sizeMax;
  return out;
}

export interface SaveRulesResult {
  ok: boolean;
  error?: string;
  rules?: ScopedPricingRule[];
}

/** The current rule list, for the margins editor. */
export async function getPricingRules(): Promise<ScopedPricingRule[]> {
  return (await getActiveConfig()).pricingRules;
}

/** How many catalog products each rule actually sets the margin for. */
export interface RuleCoverage {
  ruleId: string;
  products: number;
  /** The rule only covers part of each product (it names sizes). */
  sizeScoped: boolean;
  /** What the engine really charges for a product this rule owns: ask → shelf price. */
  examples: { ask: number; price: number | null }[];
}

/** The asks a rule is previewed at — one per band of the default ladder. */
const SAMPLE_ASKS = [100, 300, 600];

/**
 * A product that matches THIS rule and nothing narrower: every axis the scope
 * constrains is filled from the scope, everything else left generic. Resolving
 * against it produces the same effective rule a real product of that family
 * gets — inherited rounding, VAT and safety nets included — so the preview is
 * the engine's own answer rather than a re-implementation of it.
 */
function sampleProductFor(rule: ScopedPricingRule): SourceProduct {
  const s = rule.scope;
  return {
    stockxId: "sample",
    sku: s.sku ?? "SAMPLE-000",
    title: s.model ?? "Sample Product",
    brand: s.brand ?? "Sample",
    image: "",
    market: "IT",
    currency: "EUR",
    ...(s.source ? { source: s.source } : {}),
    ...(s.category ? { category: s.category } : {}),
    ...(s.secondaryCategory ? { secondaryCategory: s.secondaryCategory } : {}),
    variants: [],
  };
}

function sampleVariantFor(rule: ScopedPricingRule, ask: number): SourceVariant {
  const s = rule.scope;
  const size = s.sizeMin ?? s.sizeMax ?? 42;
  return {
    stockxVariantId: "sample",
    sizeLabel: String(size),
    sizeType: s.sizeType ?? "eu",
    // Deep enough that a minAsks threshold never blanks the preview.
    offers: [{ deliveryType: "standard", lowestAsk: ask, asks: 999 }],
  };
}

/** Run the engine over a synthetic product of the rule's own family. */
function ruleExamples(
  rule: ScopedPricingRule,
  rules: ScopedPricingRule[],
  cfg: AppConfig,
): { ask: number; price: number | null }[] {
  const product = sampleProductFor(rule);
  const probeConfig: AppConfig = { ...cfg, pricingRules: rules };
  return SAMPLE_ASKS.map((ask) => {
    const variant = sampleVariantFor(rule, ask);
    const effective = resolveEffectiveRule(product, variant, probeConfig);
    return { ask, price: effective ? computePrice(variant, effective) : null };
  });
}

/**
 * Answer "is this rule doing anything?" against the real catalog. A rule that
 * covers 0 products is either shadowed by a more specific one or scoped to
 * something no product matches — and until now both looked exactly like a
 * working rule. Counted per product on identity alone; the size-scoped ones
 * are flagged rather than silently counted as whole-product coverage.
 */
export async function pricingRuleCoverage(
  rulesInput?: unknown,
): Promise<{ total: number; coverage: RuleCoverage[] }> {
  const cfg = await getActiveConfig();
  // The editor passes its UNSAVED list so the numbers track what you are
  // typing; anything unparseable falls back to what is actually stored.
  const parsed = rulesInput != null ? RulesSchema.safeParse(rulesInput) : null;
  const rules = (parsed?.success ? (parsed.data as ScopedPricingRule[]) : cfg.pricingRules) ?? [];

  const axes = await listProductScopeAxes(cfg.source.market);
  const counts = new Map<string, number>();
  for (const p of axes) {
    const id = winningMarkupRuleId(p, rules);
    if (id) counts.set(id, (counts.get(id) ?? 0) + 1);
  }
  return {
    total: axes.length,
    coverage: rules.map((r) => ({
      ruleId: r.id,
      products: counts.get(r.id) ?? 0,
      sizeScoped: scopeTargetsSizes(r.scope),
      examples: ruleExamples(r, rules, cfg),
    })),
  };
}

/**
 * Replace the whole pricing-rule list (the margins editor saves everything at
 * once — rules are one document, and partial saves would allow half-edited
 * precedence). Everything else in the config is left untouched.
 */
export async function savePricingRules(input: unknown): Promise<SaveRulesResult> {
  const parsed = RulesSchema.safeParse(input);
  if (!parsed.success) {
    const issue = parsed.error.issues[0];
    return { ok: false, error: `${issue?.path.join(".") ?? ""}: ${issue?.message ?? "invalid"}` };
  }

  const rules: ScopedPricingRule[] = parsed.data.map((r) => ({
    id: r.id,
    scope: cleanScope(r.scope),
    enabled: r.enabled,
    ...(r.sourceDeliveryType != null ? { sourceDeliveryType: r.sourceDeliveryType } : {}),
    // A rule is percent- OR fixed- OR bands-driven; the editor enforces one,
    // the server keeps whichever fields arrived non-null.
    ...(r.markupPercent != null ? { markupPercent: r.markupPercent } : {}),
    ...(r.markupFixed != null ? { markupFixed: r.markupFixed } : {}),
    ...(r.markupBands != null ? { markupBands: r.markupBands } : {}),
    ...(r.floor != null ? { floor: r.floor } : {}),
    ...(r.minAsks != null ? { minAsks: r.minAsks } : {}),
    ...(r.rounding != null ? { rounding: r.rounding } : {}),
    ...(r.tax != null ? { tax: r.tax } : {}),
    ...(r.minDeltaPercent != null ? { minDeltaPercent: r.minDeltaPercent } : {}),
    ...(r.maxDeltaPercent != null ? { maxDeltaPercent: r.maxDeltaPercent } : {}),
    ...(r.outlierFloorPercent != null ? { outlierFloorPercent: r.outlierFloorPercent } : {}),
    ...(r.minMarginFixed != null ? { minMarginFixed: r.minMarginFixed } : {}),
  }));

  try {
    const cfg = await getActiveConfig();
    cfg.pricingRules = rules;
    await saveActiveConfig(cfg);
    return { ok: true, rules };
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : String(e) };
  }
}
