import "server-only";
import { requestJson, DEFAULT_RETRY } from "@/server/adapters/http";
import { env } from "@/lib/env";
import {
  accumulateIngestionRun,
  createIngestionRun,
} from "@/server/ingestion/repo";
import { getActiveConfig } from "@/server/config/repo";
import {
  extractRows,
  gsOffersToSource,
  parseGsPayload,
  type GsOffer,
} from "./goldensneakers-model";
import { getCatalogSources, upsertCatalog } from "@/server/catalog/repo";
import { GS_FEED, deactivateMissing, existingFeedKeys, upsertFeedItems, feedStats } from "./repo";

/**
 * GoldenSneakers sync (the scs-b2b playbook): download and validate EVERYTHING
 * before touching the DB, abort on an empty feed (safety), upsert active rows,
 * deactivate what vanished — never delete. One ingestion_runs row per sync
 * (source "feed:goldensneakers").
 */

export const GS_INGESTION_SOURCE = "feed:goldensneakers";

/** DRF pagination backstop (scs-b2b capped at 200 pages too). */
const MAX_PAGES = 200;

export function gsConfigured(): boolean {
  return !!(env.GS_FEED_URL && env.GS_FEED_TOKEN);
}

/** Fetch the whole flat assortment from the GS API, following DRF pagination. */
export async function fetchGsPayload(): Promise<unknown[]> {
  if (!gsConfigured()) {
    throw new Error("GoldenSneakers API is not configured — set GS_FEED_URL and GS_FEED_TOKEN.");
  }
  const headers = { Authorization: `Bearer ${env.GS_FEED_TOKEN}`, Accept: "application/json" };
  const rows: unknown[] = [];
  let url: string | null = env.GS_FEED_URL!;

  for (let page = 0; page < MAX_PAGES && url; page++) {
    const payload: unknown = await requestJson(url, { method: "GET", headers }, DEFAULT_RETRY);
    rows.push(...extractRows(payload));
    const next: unknown =
      payload && typeof payload === "object" ? (payload as { next?: unknown }).next : null;
    url = typeof next === "string" && next.length > 0 ? next : null;
  }
  return rows;
}

export interface GsSyncReport {
  rows: number; // validated offers in this sync
  skus: number; // distinct SKUs covered
  added: number; // brand-new (sku, size) rows
  updated: number; // refreshed rows
  deactivated: number; // rows that vanished from the feed
  rejected: number; // invalid rows (bad size, bad shape)
  catalogRegistered: number; // GS entries upserted into the multi-source catalog
}

/**
 * Register GS products in the discovery catalog (source "goldensneakers") so
 * products KicksDB doesn't carry are first-class: card, drawer, filters.
 * A SKU already registered by KicksDB is left alone — KicksDB owns the row,
 * ownership at plan time is a separate (feed-driven) concern. Best-effort.
 */
async function registerGsCatalogEntries(offers: GsOffer[], market: string): Promise<number> {
  const bySku = new Map<string, GsOffer[]>();
  for (const o of offers) {
    const list = bySku.get(o.sku) ?? [];
    list.push(o);
    bySku.set(o.sku, list);
  }
  const sources = await getCatalogSources(market, [...bySku.keys()]);
  const products = [...bySku.entries()]
    .filter(([sku]) => sources.get(sku) !== "kicksdb")
    .map(([sku, skuOffers]) => gsOffersToSource(sku, skuOffers, market))
    .filter((p) => p.variants.length > 0);
  await upsertCatalog(market, products);
  return products.length;
}

/** Run a sync from an already-downloaded payload (API rows or an uploaded file). */
export async function syncGoldenSneakers(payload: unknown): Promise<GsSyncReport> {
  const { offers, rejected } = parseGsPayload(payload);
  if (offers.length === 0) {
    throw new Error(
      rejected.length > 0
        ? `Feed rejected: 0 valid rows (${rejected.length} invalid — first: ${rejected[0].reason})`
        : "Feed rejected: empty payload — refusing to deactivate the whole feed.",
    );
  }

  const config = await getActiveConfig();
  const market = config.source.market;

  let runId: string | undefined;
  try {
    runId = await createIngestionRun(GS_INGESTION_SOURCE, market);
  } catch {
    runId = undefined; // history is best-effort
  }

  try {
    const known = await existingFeedKeys(GS_FEED);
    const added = offers.filter((o) => !known.has(`${o.sku}::${o.euNorm}`)).length;

    const syncedAt = new Date();
    await upsertFeedItems(GS_FEED, offers, syncedAt);
    const deactivated = await deactivateMissing(GS_FEED, syncedAt);
    let catalogRegistered = 0;
    try {
      catalogRegistered = await registerGsCatalogEntries(offers, market);
    } catch (e) {
      console.warn("[gs] catalog registration skipped:", e instanceof Error ? e.message : String(e));
    }

    const report: GsSyncReport = {
      rows: offers.length,
      skus: new Set(offers.map((o) => o.sku)).size,
      added,
      updated: offers.length - added,
      deactivated,
      rejected: rejected.length,
      catalogRegistered,
    };
    if (runId) {
      await accumulateIngestionRun(runId, {
        requested: report.rows + report.rejected,
        added: report.added,
        known: report.updated,
        rejected: report.rejected,
      }).catch(() => {});
    }
    return report;
  } catch (e) {
    if (runId) {
      await accumulateIngestionRun(
        runId,
        { requested: 0, added: 0, known: 0, rejected: 0 },
        e instanceof Error ? e.message : String(e),
      ).catch(() => {});
    }
    throw e;
  }
}

/** Convenience: fetch from the API, then sync. */
export async function syncGoldenSneakersFromApi(): Promise<GsSyncReport> {
  return syncGoldenSneakers(await fetchGsPayload());
}

export type { GsOffer };
export { feedStats };
