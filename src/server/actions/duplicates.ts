"use server";

import { z } from "zod";
import { getWooClient } from "@/server/woo/client";
import { getActiveSnapshot, getSnapshotInfo, saveSnapshot } from "@/server/store-json/repo";
import { isSafeDuplicate } from "@/server/store-json/duplicates";

export interface TrashDuplicateResult {
  ok: boolean;
  error?: string;
}

const Schema = z.object({ productId: z.number().int().positive() });

/**
 * Move ONE redundant duplicate product to the WordPress trash (recoverable —
 * never a permanent delete). The client's list is not trusted: the id must
 * still be a SAFE duplicate (size-subset of its keeper, never the keeper) in
 * the CURRENT snapshot, recomputed here, or nothing happens.
 */
export async function trashDuplicateStoreProduct(
  input: z.infer<typeof Schema>,
): Promise<TrashDuplicateResult> {
  const parsed = Schema.safeParse(input);
  if (!parsed.success) return { ok: false, error: "invalid input" };
  const { productId } = parsed.data;

  try {
    const snapshot = await getActiveSnapshot();
    if (!snapshot) return { ok: false, error: "no store snapshot" };
    if (!isSafeDuplicate(snapshot, productId)) {
      return { ok: false, error: "not a safe duplicate (state changed?) — refresh the page" };
    }

    await getWooClient().deleteProduct(productId); // trash, NOT force-delete

    // Mirror the removal into the snapshot so the report updates immediately.
    snapshot.products = snapshot.products.filter((p) => p.id !== productId);
    if (typeof snapshot.product_count === "number") {
      snapshot.product_count = snapshot.products.length;
    }
    const info = await getSnapshotInfo();
    await saveSnapshot(snapshot, info?.source ?? "rest");

    return { ok: true };
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : String(e) };
  }
}
