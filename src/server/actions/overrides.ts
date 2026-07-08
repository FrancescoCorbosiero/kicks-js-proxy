"use server";

import { z } from "zod";
import { getOverrides, saveOverrides } from "@/server/overrides/repo";
import { withProductSaleRule, withVariationPrice } from "@/server/overrides/model";

export interface OverrideResult {
  ok: boolean;
  error?: string;
}

const SaleRuleSchema = z.object({
  sku: z.string().min(1),
  // null clears the override (back to the default: preserve sale prices)
  followSaleRule: z.boolean().nullable(),
});

/** Persist a product's sale-rule choice (or clear it). */
export async function setProductSaleRule(
  input: z.infer<typeof SaleRuleSchema>,
): Promise<OverrideResult> {
  const parsed = SaleRuleSchema.safeParse(input);
  if (!parsed.success) return { ok: false, error: "invalid input" };
  try {
    const current = await getOverrides();
    await saveOverrides(withProductSaleRule(current, parsed.data.sku, parsed.data.followSaleRule));
    return { ok: true };
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : String(e) };
  }
}

const ManualPriceSchema = z.object({
  parentSku: z.string().min(1),
  euSize: z.string().min(1),
  // null clears the lock; otherwise a positive price
  price: z.number().positive().nullable(),
});

/** Persist (or clear) a variation's manual locked price. */
export async function setVariationManualPrice(
  input: z.infer<typeof ManualPriceSchema>,
): Promise<OverrideResult> {
  const parsed = ManualPriceSchema.safeParse(input);
  if (!parsed.success) return { ok: false, error: "invalid input" };
  try {
    const current = await getOverrides();
    await saveOverrides(
      withVariationPrice(current, parsed.data.parentSku, parsed.data.euSize, parsed.data.price),
    );
    return { ok: true };
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : String(e) };
  }
}
