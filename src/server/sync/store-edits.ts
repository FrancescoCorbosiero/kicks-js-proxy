import "server-only";
import { getOverridesForWrite, saveOverrides } from "@/server/overrides/repo";
import { withVariationPrice } from "@/server/overrides/model";
import { listStoreEdits, openStoreEdits, supersedeStoreEditsById } from "./ledger";
import { runPriceSync } from "./price-sync";

/**
 * Prices changed on WordPress: the list, and its two answers.
 *
 * The sync never writes over a price someone changed on the store after the
 * Hub last wrote it (see sync/ledger.ts). It keeps it, and it lists it here,
 * because only a person can say which price is right:
 *
 *  - KEEP: the store's price was meant. It is locked under its size — the same
 *    lock the drawer and the Vetrina set — so every sync from now on writes it
 *    and nothing else, until it is unlocked.
 *  - USE THE HUB'S PRICE: the edit was a mistake, or its time is over. The
 *    rules price the size again, and the product's prices are written now.
 */

export interface StoreEditView {
  variationId: number;
  productId: number;
  sku: string;
  euSize: string;
  title: string;
  sizeLabel: string;
  /** What the store shows — kept. */
  storePrice: number;
  /** What the Hub last wrote there. */
  hubPrice: number;
  /** When the store was first seen holding that price (ISO). */
  seenAt: string | null;
  /** Keeping needs the size a lock is stored under. */
  lockable: boolean;
}

export interface StoreEditsState {
  rows: StoreEditView[];
  /** All of them: `rows` is the first page. */
  total: number;
}

export async function loadStoreEdits(limit = 100): Promise<StoreEditsState> {
  const { rows, total } = await listStoreEdits(limit);
  return {
    total,
    rows: rows.map((r) => ({
      variationId: r.variationId,
      productId: r.productId,
      sku: r.sku,
      euSize: r.euSize,
      title: r.title,
      sizeLabel: r.sizeLabel || r.euSize,
      storePrice: r.storePrice ?? 0,
      hubPrice: r.price,
      seenAt: r.seenAt?.toISOString() ?? null,
      lockable: r.euSize !== "",
    })),
  };
}

/** Keep the store's prices: locked under their sizes, the Hub's own from now on. */
export async function keepStoreEdits(ids: number[] | "all"): Promise<{ kept: number; notLockable: number }> {
  const rows = await openStoreEdits(ids);
  const lockable = rows.filter((r) => r.euSize !== "" && r.storePrice != null);
  if (lockable.length > 0) {
    let overrides = await getOverridesForWrite();
    for (const r of lockable) overrides = withVariationPrice(overrides, r.sku, r.euSize, r.storePrice!);
    await saveOverrides(overrides);
    await supersedeStoreEditsById(lockable.map((r) => r.variationId));
  }
  return { kept: lockable.length, notLockable: rows.length - lockable.length };
}

/**
 * Hand the prices back to the rules, and write the products' prices now. The
 * edits are closed first: if the write fails (the store is down, the source
 * has no price today), the next sync writes them.
 */
export async function repriceStoreEdits(
  ids: number[] | "all",
): Promise<{ handed: number; updated: number; failed: number; error: string | null }> {
  const rows = await openStoreEdits(ids);
  if (rows.length === 0) return { handed: 0, updated: 0, failed: 0, error: null };
  await supersedeStoreEditsById(rows.map((r) => r.variationId));
  try {
    const { outcome } = await runPriceSync({ skus: [...new Set(rows.map((r) => r.sku))] });
    return { handed: rows.length, updated: outcome?.updated ?? 0, failed: outcome?.failedTotal ?? 0, error: null };
  } catch (e) {
    return { handed: rows.length, updated: 0, failed: 0, error: e instanceof Error ? e.message : String(e) };
  }
}
