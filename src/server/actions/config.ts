"use server";

import { z } from "zod";
import type { ScopedPricingRule } from "@core/config";
import { clearConfig, getActiveConfig, saveActiveConfig } from "@/server/config/repo";
import { pricingSummary, type PricingSummary } from "@/server/config/summary";

/** Wipe the stored config and re-seed from defaults.ts; return the new summary. */
export async function resetPricingToDefaults(): Promise<PricingSummary> {
  await clearConfig();
  return pricingSummary(await getActiveConfig());
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
