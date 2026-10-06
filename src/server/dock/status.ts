import "server-only";
import { getActiveConfig } from "@/server/config/repo";
import { countCatalog, countUnpublishedCandidates } from "@/server/catalog/repo";
import { countOpenOrders } from "@/server/orders/repo";
import { listApplyHistory } from "@/server/woo/apply";
import { getLatestPullRun, pullInFlight } from "@/server/woo/pull";
import { countStoreEdits } from "@/server/sync/ledger";
import { EMPTY_DOCK_STATUS, type DockStatus } from "@/lib/dock";

/**
 * The dock's live numbers. Polled from every operator page, so only counts
 * and single-row reads — each one guarded, so one broken table blanks one
 * station instead of the whole dock.
 */
export async function loadDockStatus(): Promise<DockStatus> {
  let market: string;
  try {
    market = (await getActiveConfig()).source.market;
  } catch {
    return EMPTY_DOCK_STATUS;
  }

  const [catalog, toPublish, openOrders, history, latestPull, storeEdits] = await Promise.all([
    countCatalog(market).catch(() => null),
    countUnpublishedCandidates(market).catch(() => null),
    countOpenOrders().catch(() => null),
    listApplyHistory(10).catch(() => []),
    getLatestPullRun().catch(() => null),
    countStoreEdits().catch(() => null),
  ]);

  const lastLive = history.find(
    (r) => !r.dryRun && (r.status === "applied" || r.status === "partial"),
  );

  return {
    catalog,
    toPublish,
    openOrders,
    lastSyncAt: lastLive?.finishedAt ?? lastLive?.startedAt ?? null,
    pulling: pullInFlight(latestPull),
    storeEdits,
  };
}
