"use server";

import { z } from "zod";
import { getActiveConfig } from "@/server/config/repo";
import { listCatalogEntries } from "@/server/catalog/repo";
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
