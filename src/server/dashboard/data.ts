import "server-only";
import { getActiveConfig } from "@/server/config/repo";
import { countByOwner, countStale, type CatalogOwnerCounts } from "@/server/catalog/repo";
import { getOverrides } from "@/server/overrides/repo";
import { skusPinnedTo } from "@/server/overrides/model";
import { listIngestionRuns, type IngestionHistoryEntry } from "@/server/ingestion/repo";
import { listApplyHistory, type ApplyHistoryEntry } from "@/server/woo/apply";
import { getLatestPullRun } from "@/server/woo/pull";
import { wooConfigured } from "@/server/woo/client";
import { getSnapshotInfo, type SnapshotInfo } from "@/server/store-json/repo";
import { feedStats, GS_FEED } from "@/server/feeds/repo";
import { gsConfigured } from "@/server/feeds/goldensneakers";
import { assertSchemaCurrent } from "@/server/db/probe";

/** One line in the dashboard's recent-activity feed, newest first. */
export type ActivityItem =
  | { kind: "ingestion"; at: string; run: IngestionHistoryEntry }
  | { kind: "apply"; at: string; run: ApplyHistoryEntry };

export interface DashboardData {
  market: string;
  wooConfigured: boolean;
  gsConfigured: boolean;
  catalog: CatalogOwnerCounts;
  staleCount: number;
  ttlSeconds: number;
  snapshot: SnapshotInfo | null;
  /** Progress of a pull that is mid-flight right now, else null. */
  runningPull: { productsFetched: number; totalProducts: number | null } | null;
  /** The last LIVE apply that wrote something (dry runs and failures excluded). */
  lastApply: ApplyHistoryEntry | null;
  feed: { activeSkus: number; activeRows: number };
  activity: ActivityItem[];
}

/**
 * Everything the operator dashboard shows, in one place. Follows the page
 * guard pattern: assertSchemaCurrent throws first (the caller renders the
 * remedy page); the individual tiles are best-effort — helpers that don't
 * swallow DB errors themselves are `.catch()`-guarded so one broken tile
 * degrades to empty instead of taking the homepage down.
 */
export async function loadDashboardData(): Promise<DashboardData> {
  await assertSchemaCurrent();
  const config = await getActiveConfig();
  const market = config.source.market;
  const ttlSeconds = config.source.cacheTtlSeconds;

  const overrides = await getOverrides().catch(() => null);
  const pinnedToKicksdb = overrides ? skusPinnedTo(overrides, "kicksdb") : [];

  const [catalog, staleCount, snapshot, latestPull, applyHistory, ingestionRuns, feed] =
    await Promise.all([
      countByOwner(market, pinnedToKicksdb),
      countStale(market, ttlSeconds),
      getSnapshotInfo().catch(() => null),
      getLatestPullRun().catch(() => null),
      listApplyHistory(6).catch(() => [] as ApplyHistoryEntry[]),
      listIngestionRuns(10),
      feedStats(GS_FEED),
    ]);

  // Both run shapes carry ISO startedAt strings, so a string sort is a time sort.
  const activity: ActivityItem[] = [
    ...ingestionRuns.map((run) => ({ kind: "ingestion" as const, at: run.startedAt, run })),
    ...applyHistory.map((run) => ({ kind: "apply" as const, at: run.startedAt, run })),
  ]
    .sort((a, b) => b.at.localeCompare(a.at))
    .slice(0, 8);

  return {
    market,
    wooConfigured: wooConfigured(),
    gsConfigured: gsConfigured(),
    catalog,
    staleCount,
    ttlSeconds,
    snapshot,
    // A pull abandoned mid-flight (closed tab) keeps status "running" forever;
    // only advertise it while it's actually advancing.
    runningPull:
      latestPull?.status === "running" &&
      Date.now() - latestPull.updatedAt.getTime() < 10 * 60_000
        ? { productsFetched: latestPull.productsFetched, totalProducts: latestPull.totalProducts }
        : null,
    lastApply:
      applyHistory.find(
        (r) => !r.dryRun && (r.status === "applied" || r.status === "partial"),
      ) ?? null,
    feed: { activeSkus: feed.activeSkus, activeRows: feed.activeRows },
    activity,
  };
}
