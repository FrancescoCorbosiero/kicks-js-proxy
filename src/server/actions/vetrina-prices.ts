"use server";

import { z } from "zod";
import { getActiveConfig } from "@/server/config/repo";
import { loadDrawerData, type DrawerData } from "@/components/catalog/drawer-data";
import { runPriceSync } from "@/server/sync/price-sync";
import { getSnapshotInfo } from "@/server/store-json/repo";
import { skuKey } from "@/lib/skus";

/**
 * Prices from the Vetrina's product sheet. Reading reuses the catalog
 * drawer's data (asks, computed prices, locks, the rule behind them);
 * publishing runs the ordinary sync for ONE product, prices only — no size
 * cleanup, no identifiers, no creates — so a locked price reaches the site in
 * one tap and the next full Sync keeps it (locks live in the Hub).
 */

const Sku = z.string().trim().min(1).max(80);

export async function loadProductPrices(input: {
  sku: string;
}): Promise<{ ok: true; data: DrawerData | null } | { ok: false; error: string }> {
  const parsed = z.object({ sku: Sku }).safeParse(input);
  if (!parsed.success) return { ok: false, error: "invalid sku" };
  try {
    const config = await getActiveConfig();
    return { ok: true, data: await loadDrawerData(config.source.market, skuKey(parsed.data.sku), config) };
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : String(e) };
  }
}

/** Steps of a one-SKU sync before giving up — it normally finishes in one. */
const MAX_STEPS = 10;

export async function publishProductPrices(input: {
  sku: string;
}): Promise<
  | { ok: true; updated: number; failed: number; unpriced: boolean }
  | { ok: false; error: string; noSnapshot?: boolean }
> {
  const parsed = z.object({ sku: Sku }).safeParse(input);
  if (!parsed.success) return { ok: false, error: "invalid sku" };
  try {
    // The sync matches against the store snapshot; without one there is no
    // variation to write to. Said in the sheet's words, not the Sync tab's.
    if ((await getSnapshotInfo()) == null) return { ok: false, error: "no snapshot", noSnapshot: true };
    const { report, outcome } = await runPriceSync({ skus: [skuKey(parsed.data.sku)], maxSteps: MAX_STEPS });
    // The source had no price for it (unknown SKU, an outage): the lock is
    // saved but nothing could be planned — the sheet says so, not "0 updated".
    const stats = report.stats;
    const unpriced = (stats?.notFoundTotal ?? stats?.notFound.length ?? 0) > 0 || (stats?.unanswered ?? 0) > 0;
    return { ok: true, updated: outcome?.updated ?? 0, failed: outcome?.failedTotal ?? 0, unpriced };
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : String(e) };
  }
}
