import { env } from "@/lib/env";
import { runKicksdbRefresh } from "@/server/actions/feeds";

/**
 * In-app scheduler: the app re-prices itself, no external cron needed.
 * Started once per server boot from src/instrumentation.ts. Every tick
 * (6 h, first one a minute after boot) runs a KicksDB re-pricing pass;
 * roughly once a day the GoldenSneakers complete sync runs first, so the
 * refresh immediately prices whatever it registered.
 *
 * On by default in production, off in dev; SCHEDULER=on|off overrides.
 * Needs a long-running server (`next start`, Docker) — a serverless
 * platform that freezes the process between requests won't tick.
 * The /api/cron/* endpoints stay available for external schedulers.
 */

/** Rounds per refresh pass (100 SKUs each) — same backstop as the cron route. */
const MAX_ROUNDS = 50;
const FIRST_TICK_MS = 60 * 1000;
const TICK_MS = 6 * 60 * 60 * 1000;
// One-hour slack under 24 h so daily runs don't skip a tick when timers drift.
const GS_EVERY_MS = 23 * 60 * 60 * 1000;

let running = false;
let lastGsSyncAt = 0;

async function refreshCatalog(): Promise<void> {
  let runId: string | undefined;
  let refreshed = 0;
  for (let round = 0; round < MAX_ROUNDS; round++) {
    const res = await runKicksdbRefresh({ limit: 100, runId });
    if (!res.ok) {
      console.error(`[scheduler] KicksDB refresh failed after ${refreshed} re-priced: ${res.error}`);
      return;
    }
    runId = res.runId ?? runId;
    refreshed += res.refreshed ?? 0;
    if ((res.requested ?? 0) === 0 || (res.remainingStale ?? 0) === 0) break;
  }
  console.log(`[scheduler] KicksDB refresh done: ${refreshed} re-priced`);
}

async function tick(): Promise<void> {
  if (running) return; // previous pass still going — the next tick retries
  running = true;
  try {
    const { gsConfigured, syncGoldenSneakersFromApi } = await import("@/server/feeds/goldensneakers");
    if (gsConfigured() && Date.now() - lastGsSyncAt >= GS_EVERY_MS) {
      try {
        const report = await syncGoldenSneakersFromApi();
        lastGsSyncAt = Date.now(); // only on success — a failed sync retries next tick
        console.log(
          `[scheduler] GS sync done: ${report.skus} SKUs (${report.added} added, ${report.updated} updated, ${report.deactivated} deactivated)`,
        );
      } catch (e) {
        console.error(`[scheduler] GS sync failed: ${e instanceof Error ? e.message : String(e)}`);
      }
    }
    await refreshCatalog();
  } finally {
    running = false;
  }
}

export function startScheduler(): void {
  const enabled =
    env.SCHEDULER === "on" || (env.SCHEDULER === undefined && process.env.NODE_ENV === "production");
  if (!enabled) return;

  // Dev hot-reload can re-run instrumentation; never double the timers.
  const g = globalThis as { __storeHubScheduler?: boolean };
  if (g.__storeHubScheduler) return;
  g.__storeHubScheduler = true;

  console.log("[scheduler] on — GS complete sync ~daily, KicksDB re-pricing every 6 h");
  setTimeout(tick, FIRST_TICK_MS).unref();
  setInterval(tick, TICK_MS).unref();
}
