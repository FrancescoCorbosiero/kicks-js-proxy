"use server";

import { z } from "zod";
import { getActiveConfig } from "@/server/config/repo";
import { getSource } from "@/server/adapters/kicksdb";
import { listCatalogEntries, upsertCatalog } from "@/server/catalog/repo";
import { skuKey } from "@/lib/skus";
import type { CatalogItem } from "@/lib/catalog";

export interface CatalogListResult {
  ok: boolean;
  error?: string;
  market: string;
  total: number;
  items: CatalogItem[];
}

const InputSchema = z.object({ market: z.string().min(1).optional() });
export type CatalogListInput = z.infer<typeof InputSchema>;

/**
 * List the whole persistent KicksDB catalog for a market — the SKUs verified
 * fetchable on KicksDB, which grows on every preview. Used by the discovery panel
 * to browse and copy the known-good SKU set.
 */
export async function listCatalog(input: CatalogListInput = {}): Promise<CatalogListResult> {
  const parsed = InputSchema.safeParse(input);
  if (!parsed.success) return { ok: false, error: "invalid input", market: "", total: 0, items: [] };

  try {
    const config = await getActiveConfig();
    const market = parsed.data.market ?? config.source.market;
    const items = await listCatalogEntries(market);
    return { ok: true, market, total: items.length, items };
  } catch (e) {
    return {
      ok: false,
      error: e instanceof Error ? e.message : String(e),
      market: "",
      total: 0,
      items: [],
    };
  }
}

const RefreshSchema = z.object({ market: z.string().min(1), sku: z.string().min(1) });

/**
 * Re-sync one catalog product from KicksDB right now (the drawer's refresh
 * button): re-fetch by exact SKU, upsert, bump fetchedAt. The catalog invariant
 * holds — a SKU that stopped resolving is reported as an error, never removed.
 */
export async function refreshCatalogProduct(
  input: z.infer<typeof RefreshSchema>,
): Promise<{ ok: boolean; error?: string }> {
  const parsed = RefreshSchema.safeParse(input);
  if (!parsed.success) return { ok: false, error: "invalid input" };

  try {
    const config = await getActiveConfig();
    const source = getSource(config);
    const { market, sku } = parsed.data;
    const list = await source.getProduct(sku, market);
    const product = list.find((p) => skuKey(p.sku) === skuKey(sku));
    if (!product) return { ok: false, error: `No exact KicksDB match for ${sku}` };
    await upsertCatalog(market, [product]);
    return { ok: true };
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : String(e) };
  }
}
