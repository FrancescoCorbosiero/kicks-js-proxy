import "server-only";
import { and, desc, eq, inArray, isNotNull, sql } from "drizzle-orm";
import { db } from "@/server/db/client";
import { countOf } from "@/server/db/rows";
import { priceLedger, storeSnapshot, type PriceLedgerRow } from "@/server/db/schema";
import { SNAPSHOT_ID } from "@/server/store-json/repo";
import { skuKey } from "@/lib/skus";
import type { LedgerEntry, LedgerSettle, StoreEditNote } from "./store-edit-plan";

/**
 * The price ledger (table price_ledger): what the Hub last wrote to each store
 * variation's price.
 *
 * It is how a price someone changed in WordPress is told apart from the
 * store's own history. The snapshot cannot say it: it is the store as last
 * read, edits included. The ledger is only ever the Hub's own word, so a store
 * price that differs from it was put there by someone else — and the plan
 * keeps it instead of writing over it (see storeEditOf in core-spine).
 *
 * Written after every price write that went through: the sync (by hand, the
 * scheduler's, the Vetrina's), the Publisher and the rebuild. The resolutions
 * of the "changed on WordPress" list write it too: keeping a price makes it the
 * Hub's own, and so does handing it back to the rules.
 */

export type { LedgerEntry, LedgerSettle, StoreEditNote } from "./store-edit-plan";

/** Rows per statement: a whole-store apply records tens of thousands. */
const CHUNK = 500;

function chunks<T>(items: T[]): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < items.length; i += CHUNK) out.push(items.slice(i, i + CHUNK));
  return out;
}

/** One variation's price, as the Hub just wrote it. */
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

/**
 * Record prices the Hub just wrote. A write settles the variation: whatever
 * the store held before, it now holds the Hub's price.
 */
export async function recordPriceWrites(writes: LedgerWrite[]): Promise<void> {
  // One row per variation: the last write of a batch is the one that stands.
  const byId = new Map<number, LedgerWrite>();
  for (const w of writes) if (w.variationId > 0 && Number.isFinite(w.price)) byId.set(w.variationId, w);
  for (const part of chunks([...byId.values()])) {
    await db
      .insert(priceLedger)
      .values(
        part.map((w) => ({
          variationId: w.variationId,
          productId: w.productId,
          sku: skuKey(w.sku),
          euSize: w.euSize ?? "",
          price: w.price,
          title: w.title ?? "",
          sizeLabel: w.sizeLabel ?? "",
        })),
      )
      .onConflictDoUpdate({
        target: priceLedger.variationId,
        set: {
          productId: sql`excluded.product_id`,
          sku: sql`excluded.sku`,
          // A write that does not know the size or the name (the sync knows the
          // EU size only when the source does) keeps what an earlier one said.
          euSize: sql`coalesce(nullif(excluded.eu_size, ''), ${priceLedger.euSize})`,
          title: sql`coalesce(nullif(excluded.title, ''), ${priceLedger.title})`,
          sizeLabel: sql`coalesce(nullif(excluded.size_label, ''), ${priceLedger.sizeLabel})`,
          price: sql`excluded.price`,
          writtenAt: sql`now()`,
          storePrice: sql`null`,
          seenAt: sql`null`,
        },
      });
  }
}

/**
 * The ledger for these store products, by variation id. The plan reads it to
 * know the Hub's last word on each variation it is about to price.
 */
export async function ledgerForProducts(productIds: number[]): Promise<Map<number, LedgerEntry>> {
  const out = new Map<number, LedgerEntry>();
  const ids = [...new Set(productIds.filter((id) => id > 0))];
  for (const part of chunks(ids)) {
    const rows = await db
      .select({ variationId: priceLedger.variationId, price: priceLedger.price, storePrice: priceLedger.storePrice })
      .from(priceLedger)
      .where(inArray(priceLedger.productId, part));
    for (const r of rows) out.set(r.variationId, { price: r.price, storePrice: r.storePrice });
  }
  return out;
}

/**
 * Note store prices the Hub is keeping. "Seen" is when the store was first
 * found holding THAT price: noting the same price again keeps the date, a new
 * edit restarts it.
 */
export async function noteStoreEdits(notes: StoreEditNote[]): Promise<void> {
  const byId = new Map<number, StoreEditNote>();
  for (const n of notes) if (n.variationId > 0) byId.set(n.variationId, n);
  for (const part of chunks([...byId.values()])) {
    await db
      .insert(priceLedger)
      .values(
        part.map((n) => ({
          variationId: n.variationId,
          productId: n.productId,
          sku: skuKey(n.sku),
          euSize: n.euSize ?? "",
          price: n.hubPrice,
          storePrice: n.storePrice,
          seenAt: new Date(),
          title: n.title ?? "",
          sizeLabel: n.sizeLabel ?? "",
        })),
      )
      .onConflictDoUpdate({
        target: priceLedger.variationId,
        set: {
          seenAt: sql`case when ${priceLedger.storePrice} = excluded.store_price
                           then coalesce(${priceLedger.seenAt}, excluded.seen_at)
                           else excluded.seen_at end`,
          storePrice: sql`excluded.store_price`,
          euSize: sql`coalesce(nullif(excluded.eu_size, ''), ${priceLedger.euSize})`,
          title: sql`coalesce(nullif(excluded.title, ''), ${priceLedger.title})`,
          sizeLabel: sql`coalesce(nullif(excluded.size_label, ''), ${priceLedger.sizeLabel})`,
        },
      });
  }
}

/** Close the edits of variations whose store price is the Hub's again (adopting `price` when given). */
export async function settleStoreEdits(settles: LedgerSettle[]): Promise<void> {
  const adopt = settles.filter((s) => s.price != null && Number.isFinite(s.price));
  const close = settles.filter((s) => s.price == null).map((s) => s.variationId);
  for (const part of chunks(adopt)) {
    const values = JSON.stringify(part.map((s) => ({ variation_id: s.variationId, price: s.price })));
    await db.execute(sql`
      update ${priceLedger} l
      set price = v.price, store_price = null, seen_at = null
      from jsonb_to_recordset(${values}::jsonb) as v(variation_id int, price numeric)
      where l.variation_id = v.variation_id
    `);
  }
  for (const part of chunks(close)) {
    await db
      .update(priceLedger)
      .set({ storePrice: null, seenAt: null })
      .where(and(inArray(priceLedger.variationId, part), isNotNull(priceLedger.storePrice)));
  }
}

/**
 * A price decided in the Hub for these sizes — a lock set or cleared, a kept
 * price, a price handed back to the rules — supersedes an edit the store holds
 * there: it is the newer word. The store's price becomes the baseline that
 * decision is written over, so the next sync writes it instead of keeping the
 * edit. Sizes with no open edit are left as they are.
 */
export async function supersedeStoreEdits(sku: string, euSizes: string[]): Promise<void> {
  const sizes = [...new Set(euSizes.filter((s) => s.trim() !== ""))];
  if (sizes.length === 0) return;
  await db
    .update(priceLedger)
    .set({ price: sql`${priceLedger.storePrice}`, storePrice: null, seenAt: null })
    .where(
      and(eq(priceLedger.sku, skuKey(sku)), inArray(priceLedger.euSize, sizes), isNotNull(priceLedger.storePrice)),
    );
}

/** The same, by variation — the list's rows. */
export async function supersedeStoreEditsById(variationIds: number[]): Promise<void> {
  for (const part of chunks([...new Set(variationIds)])) {
    await db
      .update(priceLedger)
      .set({ price: sql`${priceLedger.storePrice}`, storePrice: null, seenAt: null })
      .where(and(inArray(priceLedger.variationId, part), isNotNull(priceLedger.storePrice)));
  }
}

/**
 * Forget variations the store no longer has: the Hub deleted them (a rebuild,
 * a reimport, the size cleanup) or the live check found them gone. Woo never
 * reuses an id, so their rows could only ever linger on the list.
 */
export async function forgetVariations(variationIds: number[]): Promise<void> {
  for (const part of chunks([...new Set(variationIds.filter((id) => id > 0))])) {
    await db.delete(priceLedger).where(inArray(priceLedger.variationId, part));
  }
}

/**
 * After a full pull: forget the variations a pulled product no longer has —
 * sizes deleted in WordPress. A product the pull did not bring at all (a draft,
 * a private product) is left alone: its sizes may well still be there.
 */
export async function pruneLedgerToSnapshot(): Promise<number> {
  const res = await db.execute(sql`
    with pulled as (
      select (p->>'id')::bigint as product_id, p->'variations' as variations
      from ${storeSnapshot} s, jsonb_array_elements(s.data->'products') as p
      where s.id = ${SNAPSHOT_ID} and jsonb_typeof(p->'variations') = 'array'
    ),
    present as (
      select (v->>'id')::bigint as variation_id from pulled, jsonb_array_elements(pulled.variations) as v
    )
    delete from ${priceLedger} l
    where l.product_id in (select product_id from pulled)
      and l.variation_id not in (select variation_id from present where variation_id is not null)
  `);
  return (res as { rowCount?: number | null }).rowCount ?? 0;
}

/** The store prices the Hub is keeping — the "changed on WordPress" list, newest first. */
export async function listStoreEdits(limit = 200): Promise<{ rows: PriceLedgerRow[]; total: number }> {
  const [rows, total] = await Promise.all([
    db
      .select()
      .from(priceLedger)
      .where(isNotNull(priceLedger.storePrice))
      .orderBy(desc(priceLedger.seenAt), priceLedger.sku, priceLedger.euSize)
      .limit(limit),
    countStoreEdits(),
  ]);
  return { rows, total };
}

/** How many store prices the Hub is keeping (the dock's badge). */
export async function countStoreEdits(): Promise<number> {
  const res = await db.execute(sql`select count(*)::int as n from ${priceLedger} where store_price is not null`);
  return countOf(res);
}

/** One product's open edits, by EU size — the drawer's and the Vetrina's view. */
export async function openStoreEditsForSku(
  sku: string,
): Promise<Map<string, { variationId: number; storePrice: number; hubPrice: number }>> {
  const rows = await db
    .select()
    .from(priceLedger)
    .where(and(eq(priceLedger.sku, skuKey(sku)), isNotNull(priceLedger.storePrice)));
  const out = new Map<string, { variationId: number; storePrice: number; hubPrice: number }>();
  for (const r of rows) {
    if (r.euSize && r.storePrice != null) {
      out.set(r.euSize, { variationId: r.variationId, storePrice: r.storePrice, hubPrice: r.price });
    }
  }
  return out;
}

/** The open edits among these variations ("all" = every one). */
export async function openStoreEdits(variationIds: number[] | "all"): Promise<PriceLedgerRow[]> {
  if (variationIds === "all") {
    return db.select().from(priceLedger).where(isNotNull(priceLedger.storePrice));
  }
  const out: PriceLedgerRow[] = [];
  for (const part of chunks([...new Set(variationIds)])) {
    out.push(
      ...(await db
        .select()
        .from(priceLedger)
        .where(and(inArray(priceLedger.variationId, part), isNotNull(priceLedger.storePrice)))),
    );
  }
  return out;
}
