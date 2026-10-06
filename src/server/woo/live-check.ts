import { samePrice } from "@core/core-spine";
import { managedStock, parsePrice } from "@/server/store-json/match";
import type { StoreVariation } from "@/server/store-json/model";
import type { ApplyChange } from "./apply";

/**
 * The last look before an unattended write — pure, so it is tested.
 *
 * A plan is made against the snapshot: the store as the Hub last read it, up
 * to a day old between two daily pulls. The feed cycle writes every quarter of
 * an hour from it, and nobody is watching. So right before writing a product,
 * the scheduler reads its sizes again and asks, per change, whether the store
 * is still where the plan left it:
 *
 *  - the price is what the plan was made against → written as planned;
 *  - the price moved since (someone changed it in WordPress meanwhile) → KEPT:
 *    the change loses its price, keeps its stock — the same rule the plan
 *    applies to an edit it can already see;
 *  - the variation is gone → nothing is written to it;
 *  - an identifier appeared meanwhile → it is not overwritten.
 *
 * Stock is written whatever the store shows: orders move it, and the feed's
 * quantity is what the supplier can still deliver — the truth the sync writes.
 */

/** The fields of a live variation the check reads. */
export interface LiveVariation {
  id: number;
  regular_price?: string | null;
  global_unique_id?: string | null;
  manage_stock?: unknown;
  stock_quantity?: unknown;
}

export interface LiveWrites {
  /** The changes to write, a kept price taken out of its change. */
  write: ApplyChange[];
  /** Prices the store moved after the plan was made: kept, with what it shows. */
  kept: { change: ApplyChange; storePrice: number }[];
  /** Changes aimed at a variation the store no longer has. */
  gone: ApplyChange[];
}

export function decideLiveWrites(changes: ApplyChange[], live: LiveVariation[]): LiveWrites {
  const byId = new Map(live.map((v) => [v.id, v]));
  const out: LiveWrites = { write: [], kept: [], gone: [] };
  for (const c of changes) {
    const v = byId.get(c.storeVariationId);
    if (!v) {
      out.gone.push(c);
      continue;
    }
    let next = c;
    if (c.newPrice != null) {
      const storePrice = parsePrice(v.regular_price);
      const asPlanned =
        storePrice == null
          ? c.currentPrice == null
          : c.currentPrice != null && samePrice(storePrice, c.currentPrice);
      // Someone set exactly the price the Hub is about to write: nothing is lost.
      const asWanted = storePrice != null && samePrice(storePrice, c.newPrice);
      if (!asPlanned && !asWanted) {
        // A price taken off the store has nothing to keep, and nothing is
        // written over its absence either.
        if (storePrice != null) out.kept.push({ change: c, storePrice });
        next = { ...next, newPrice: null };
        // A feed row carries its quantity along with its price: alone, it is
        // worth a write only when the store's differs.
        if (next.newStock != null && managedStock(v as StoreVariation) === next.newStock) {
          next = { ...next, newStock: null };
        }
      }
    }
    if (next.newGtin != null && (v.global_unique_id ?? "").trim()) next = { ...next, newGtin: null };
    if (next.newPrice == null && next.newStock == null && next.newGtin == null) continue;
    out.write.push(next);
  }
  return out;
}
