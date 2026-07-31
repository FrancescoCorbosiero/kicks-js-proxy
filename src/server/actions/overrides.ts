"use server";

import { z } from "zod";
import { getOverridesForWrite, saveOverrides } from "@/server/overrides/repo";
import {
  withGlobalSaleRule,
  withProductOwner,
  withProductSaleRule,
  withVariationPrice,
} from "@/server/overrides/model";

export interface OverrideResult {
  ok: boolean;
  error?: string;
}

const GlobalSaleRuleSchema = z.object({ followSaleRule: z.boolean().nullable() });

/** Persist the store-wide sale-rule default — the bulk "ignore discounts" switch. */
export async function setGlobalSaleRule(
  input: z.infer<typeof GlobalSaleRuleSchema>,
): Promise<OverrideResult> {
  const parsed = GlobalSaleRuleSchema.safeParse(input);
  if (!parsed.success) return { ok: false, error: "invalid input" };
  try {
    const current = await getOverridesForWrite();
    await saveOverrides(withGlobalSaleRule(current, parsed.data.followSaleRule));
    return { ok: true };
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : String(e) };
  }
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
    const current = await getOverridesForWrite();
    await saveOverrides(withProductSaleRule(current, parsed.data.sku, parsed.data.followSaleRule));
    return { ok: true };
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : String(e) };
  }
}

const OwnerPinSchema = z.object({
  sku: z.string().min(1),
  // "kicksdb" pins the product to StockX pricing even when the feed covers it;
  // null hands it back to the automation (feed coverage wins again).
  owner: z.enum(["kicksdb", "goldensneakers"]).nullable(),
});

/** Persist (or clear) a product's manual ownership pin — the drawer's price-source switch. */
export async function setProductOwnerPin(
  input: z.infer<typeof OwnerPinSchema>,
): Promise<OverrideResult> {
  const parsed = OwnerPinSchema.safeParse(input);
  if (!parsed.success) return { ok: false, error: "invalid input" };
  try {
    const current = await getOverridesForWrite();
    await saveOverrides(withProductOwner(current, parsed.data.sku, parsed.data.owner));
    return { ok: true };
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : String(e) };
  }
}

const BulkManualPricesSchema = z.object({
  parentSku: z.string().min(1),
  prices: z
    .array(
      z.object({
        euSize: z.string().min(1),
        // null clears that size's lock; otherwise a positive price
        price: z.number().positive().nullable(),
      }),
    )
    .min(1)
    .max(500),
});

/**
 * Persist many locked prices for one product in a single write — the drawer's
 * "lock all sizes" / "unlock all" buttons.
 */
export async function setProductManualPrices(
  input: z.infer<typeof BulkManualPricesSchema>,
): Promise<OverrideResult> {
  const parsed = BulkManualPricesSchema.safeParse(input);
  if (!parsed.success) return { ok: false, error: "invalid input" };
  try {
    let next = await getOverridesForWrite();
    for (const p of parsed.data.prices) {
      next = withVariationPrice(next, parsed.data.parentSku, p.euSize, p.price);
    }
    await saveOverrides(next);
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
    const current = await getOverridesForWrite();
    await saveOverrides(
      withVariationPrice(current, parsed.data.parentSku, parsed.data.euSize, parsed.data.price),
    );
    return { ok: true };
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : String(e) };
  }
}
