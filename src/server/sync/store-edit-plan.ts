import { samePrice, type PlanItem } from "@core/core-spine";

/**
 * What a plan tells the price ledger about prices changed on the store — pure,
 * so it is tested without a database (src/server/sync/ledger.ts writes it).
 *
 * The plan already decided which rows to KEEP (buildPlan sets `storeEdit`);
 * this turns its rows into the ledger's bookkeeping:
 *
 *  - note: every kept row — the store holds a price the Hub is not writing
 *    over, and the "changed on WordPress" list shows it;
 *  - settle: a variation whose store price is the Hub's again. Either the
 *    store went back to the Hub's last price (an edit undone in WordPress), or
 *    the store and the rules now ask for the same price — then the store's
 *    price is adopted as the Hub's own, and the next change is the rules'.
 *  - adopt: a size the ledger has never seen, whose store price the plan is
 *    content with (nothing to write). Without it, a size that stays in step
 *    would never be written, never recorded — and an edit made to it in
 *    WordPress would be written over like the store's own history. From its
 *    first plan on, every size the Hub prices is watched.
 *
 * Anything else leaves the ledger as it is. A kept edit in particular stays on
 * the list while the Hub happens to have nothing to write there (no ask today,
 * a sale price, a change under the anti-churn threshold): it is still the
 * store's price, not the Hub's, and the next price the rules ask for would
 * find it kept again.
 */

/** The Hub's last word on one variation, as the ledger holds it. */
export interface LedgerEntry {
  price: number;
  /** The store price the Hub is keeping there; null = in step. */
  storePrice: number | null;
}

/** A store price the Hub is keeping instead of writing over it. */
export interface StoreEditNote {
  variationId: number;
  productId: number;
  sku: string;
  euSize?: string | null;
  /** What the store shows. */
  storePrice: number;
  /**
   * The Hub's last price there. Used only when the ledger has no row yet:
   * the live check before an unattended write can catch an edit on a variation
   * the Hub never wrote, and the price it planned against is then the baseline.
   * An existing row keeps its own.
   */
  hubPrice: number;
  title?: string | null;
  sizeLabel?: string | null;
}

/** A variation whose store price is the Hub's again: close the edit, adopt `price` when given. */
export interface LedgerSettle {
  variationId: number;
  price?: number;
}

/** One variation's price, as the Hub wrote it — or accepts it as its own. */
export interface LedgerWrite {
  variationId: number;
  productId: number;
  /** The parent's SKU, any spelling: stored canonical. */
  sku: string;
  /** Canonical EU size, when known — needed to keep a later edit as a lock. */
  euSize?: string | null;
  price: number;
  title?: string | null;
  sizeLabel?: string | null;
}

/** One planned variation, with what the list needs to name it. */
export interface PlannedRow {
  item: PlanItem;
  /** The product's SKU (the plan's). */
  sku: string;
  /** The product's name. */
  title: string;
  /** The size as the store labels it. */
  sizeLabel: string;
}

export function ledgerUpdatesFor(
  rows: PlannedRow[],
  ledger: ReadonlyMap<number, LedgerEntry>,
): { notes: StoreEditNote[]; settles: LedgerSettle[]; adopt: LedgerWrite[] } {
  const notes: StoreEditNote[] = [];
  const settles: LedgerSettle[] = [];
  const adopt: LedgerWrite[] = [];
  for (const { item, sku, title, sizeLabel } of rows) {
    const variationId = item.storeVariationId;
    if (variationId == null || variationId <= 0 || item.storeProductId == null) continue;

    if (item.storeEdit) {
      notes.push({
        variationId,
        productId: item.storeProductId,
        sku,
        euSize: item.euSize ?? null,
        storePrice: item.storeEdit.storePrice,
        hubPrice: item.storeEdit.hubPrice,
        title,
        sizeLabel,
      });
      continue;
    }

    const entry = ledger.get(variationId);
    const current = item.currentPrice;
    if (current == null) continue;
    if (!entry) {
      // In step: nothing to write (a no-op, within the anti-churn threshold
      // or at its lock), or only stock to write next to the same price.
      const inStep =
        item.action === "noop" || (item.proposedPrice != null && samePrice(item.proposedPrice, current));
      if (inStep) {
        adopt.push({
          variationId,
          productId: item.storeProductId,
          sku,
          euSize: item.euSize ?? null,
          price: current,
          title,
          sizeLabel,
        });
      }
      continue;
    }
    if (samePrice(current, entry.price)) {
      // In step. An edit kept earlier was undone on the store.
      if (entry.storePrice != null) settles.push({ variationId });
    } else if (item.proposedPrice != null && samePrice(item.proposedPrice, current)) {
      // The store shows a price the Hub did not write — the very one it asks
      // for now. Nothing to keep: it becomes the Hub's own.
      settles.push({ variationId, price: current });
    }
  }
  return { notes, settles, adopt };
}
