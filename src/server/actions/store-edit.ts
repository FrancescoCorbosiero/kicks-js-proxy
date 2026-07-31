"use server";

import { z } from "zod";
import { getWooClient } from "@/server/woo/client";
import { getActiveSnapshot, getSnapshotInfo, saveSnapshot } from "@/server/store-json/repo";

/**
 * Direct store editing for STORE-ONLY products (source "woo" — no feed
 * linked, so there is no sync flow to go through). Writes one variation's
 * price and/or stock straight to WooCommerce, then patches the active
 * snapshot so the drawer reflects reality without a re-pull.
 */

const Schema = z
  .object({
    storeProductId: z.number().int().positive(),
    variationId: z.number().int().positive(),
    price: z.number().positive().optional(),
    stock: z.number().int().min(0).optional(),
  })
  .refine((v) => v.price != null || v.stock != null, { message: "nothing to update" });

export interface StoreEditResult {
  ok: boolean;
  error?: string;
}

export async function updateStoreVariation(
  input: z.infer<typeof Schema>,
): Promise<StoreEditResult> {
  const parsed = Schema.safeParse(input);
  if (!parsed.success) return { ok: false, error: "invalid input" };
  const { storeProductId, variationId, price, stock } = parsed.data;

  try {
    const client = getWooClient();
    const update: Record<string, unknown> = { id: variationId };
    if (price != null) update.regular_price = price.toFixed(2);
    if (stock != null) {
      update.manage_stock = true;
      update.stock_quantity = stock;
    }
    const res = await client.batchVariations(storeProductId, { update: [update] });
    const row = res.update[0];
    if (row?.error) {
      return { ok: false, error: row.error.message ?? row.error.code ?? "update failed" };
    }

    // Mirror the write into the snapshot (same pattern as the sync apply).
    const snapshot = await getActiveSnapshot();
    const vrt = snapshot?.products
      .find((p) => p.id === storeProductId)
      ?.variations.find((v) => v.id === variationId);
    if (snapshot && vrt) {
      if (price != null) vrt.regular_price = price.toFixed(2);
      if (stock != null) {
        vrt.manage_stock = true;
        vrt.stock_quantity = stock;
        vrt.stock_status = stock > 0 ? "instock" : "outofstock";
      }
      const info = await getSnapshotInfo();
      await saveSnapshot(snapshot, info?.source ?? "rest");
    }

    return { ok: true };
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : String(e) };
  }
}
