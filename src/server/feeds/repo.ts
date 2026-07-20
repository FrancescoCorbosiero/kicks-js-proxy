import "server-only";
import { and, eq, inArray, sql } from "drizzle-orm";
import { db } from "@/server/db/client";
import { feedItems, type FeedItemRow } from "@/server/db/schema";
import { skuKey } from "@/lib/skus";
import type { GsOffer } from "./goldensneakers-model";

export const GS_FEED = "goldensneakers";

/** The (sku, euNorm) keys already known to a feed — for added-row accounting. */
export async function existingFeedKeys(feed: string): Promise<Set<string>> {
  try {
    const rows = await db
      .select({ sku: feedItems.sku, euNorm: feedItems.euNorm })
      .from(feedItems)
      .where(eq(feedItems.feed, feed));
    return new Set(rows.map((r) => `${r.sku}::${r.euNorm}`));
  } catch {
    return new Set();
  }
}

/** Upsert a sync's offers (insert-or-refresh, active=true). */
export async function upsertFeedItems(
  feed: string,
  offers: GsOffer[],
  syncedAt: Date,
): Promise<void> {
  if (offers.length === 0) return;
  const now = syncedAt;
  // Chunked: a full feed can be thousands of rows.
  for (let i = 0; i < offers.length; i += 500) {
    const part = offers.slice(i, i + 500);
    await db
      .insert(feedItems)
      .values(
        part.map((o) => ({
          feed,
          sku: o.sku,
          euNorm: o.euNorm,
          sizeLabel: o.sizeLabel,
          sizeUs: o.sizeUs,
          barcode: o.barcode,
          offerPrice: o.offerPrice,
          presentedPrice: o.presentedPrice,
          quantity: o.quantity,
          productName: o.productName,
          brandName: o.brandName,
          image: o.image,
          active: true,
          raw: o.raw,
          syncedAt: now,
        })),
      )
      .onConflictDoUpdate({
        target: [feedItems.feed, feedItems.sku, feedItems.euNorm],
        set: {
          sizeLabel: sql`excluded.size_label`,
          sizeUs: sql`excluded.size_us`,
          barcode: sql`excluded.barcode`,
          offerPrice: sql`excluded.offer_price`,
          presentedPrice: sql`excluded.presented_price`,
          quantity: sql`excluded.quantity`,
          productName: sql`excluded.product_name`,
          brandName: sql`excluded.brand_name`,
          image: sql`excluded.image`,
          active: sql`true`,
          raw: sql`excluded.raw`,
          syncedAt: sql`excluded.synced_at`,
          // first_seen_at intentionally kept: it records feed entry time.
        },
      });
  }
}

/**
 * Deactivate rows that were NOT part of this sync (scs-b2b's
 * deactivate-never-delete). Returns how many were switched off.
 */
export async function deactivateMissing(feed: string, syncedAt: Date): Promise<number> {
  const rows = await db
    .update(feedItems)
    .set({ active: false })
    .where(
      and(eq(feedItems.feed, feed), eq(feedItems.active, true), sql`${feedItems.syncedAt} < ${syncedAt}`),
    )
    .returning({ sku: feedItems.sku });
  return rows.length;
}

/** The set of SKUs the feed currently covers (active rows) — the ownership set. */
export async function activeFeedSkus(feed: string): Promise<Set<string>> {
  try {
    const rows = await db
      .selectDistinct({ sku: feedItems.sku })
      .from(feedItems)
      .where(and(eq(feedItems.feed, feed), eq(feedItems.active, true)));
    return new Set(rows.map((r) => r.sku));
  } catch {
    return new Set();
  }
}

/** Active offers for a set of SKUs, grouped by canonical SKU. */
export async function activeOffersBySku(
  feed: string,
  skus: string[],
): Promise<Map<string, FeedItemRow[]>> {
  const out = new Map<string, FeedItemRow[]>();
  if (skus.length === 0) return out;
  try {
    const rows = await db
      .select()
      .from(feedItems)
      .where(
        and(
          eq(feedItems.feed, feed),
          eq(feedItems.active, true),
          inArray(feedItems.sku, skus.map(skuKey)),
        ),
      )
      .orderBy(feedItems.euNorm);
    for (const r of rows) {
      const list = out.get(r.sku) ?? [];
      list.push(r);
      out.set(r.sku, list);
    }
  } catch {
    /* best-effort: no feed data degrades to kicksdb ownership */
  }
  return out;
}

export interface FeedStats {
  activeSkus: number;
  activeRows: number;
  totalRows: number;
}

export async function feedStats(feed: string): Promise<FeedStats> {
  try {
    const [active] = await db
      .select({
        skus: sql<number>`count(distinct ${feedItems.sku})::int`,
        rows: sql<number>`count(*)::int`,
      })
      .from(feedItems)
      .where(and(eq(feedItems.feed, feed), eq(feedItems.active, true)));
    const [total] = await db
      .select({ rows: sql<number>`count(*)::int` })
      .from(feedItems)
      .where(eq(feedItems.feed, feed));
    return {
      activeSkus: active?.skus ?? 0,
      activeRows: active?.rows ?? 0,
      totalRows: total?.rows ?? 0,
    };
  } catch {
    return { activeSkus: 0, activeRows: 0, totalRows: 0 };
  }
}

