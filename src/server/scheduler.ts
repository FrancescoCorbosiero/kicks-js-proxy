import { env } from "@/lib/env";
import { runKicksdbRefresh } from "@/server/actions/feeds";

/**
 * In-app scheduler: the app syncs itself, no external cron needed.
 * Started once per server boot from src/instrumentation.ts. Once a day
 * (first tick a minute after boot) it runs the GoldenSneakers complete
 * sync, then a KicksDB re-pricing pass so whatever the sync registered
 * gets priced immediately.
 *
 * On by default in production, off in dev; SCHEDULER=on|off overrides.
 * Needs a long-running server (`next start`, Docker) — a serverless
 * platform that freezes the process between requests won't tick.
 * The /api/cron/* endpoints stay available for external schedulers.
 */

/** Rounds per refresh pass (100 SKUs each) — same backstop as the cron route. */
const MAX_ROUNDS = 50;
const FIRST_TICK_MS = 60 * 1000;
const TICK_MS = 24 * 60 * 60 * 1000;

/** Live scheduler state, surfaced on /feeds via getFeedsState(). */
export interface SchedulerStatus {
  enabled: boolean;
  running: boolean;
  nextRunAt: number | null; // epoch ms
  lastRunAt: number | null;
  lastGsSkus: number | null; // SKUs in the last GS sync (null = not run)
  lastRefreshed: number | null; // entries re-priced in the last pass
  lastError: string | null;
}

// Instrumentation and the server-action bundle each get their own copy of
// this module; globalThis is the one store both see.
type SchedulerState = SchedulerStatus & { started: boolean };
const g = globalThis as { __storeHubScheduler?: SchedulerState };

function store(): SchedulerState {
  return (g.__storeHubScheduler ??= {
    started: false,
    enabled: false,
    running: false,
    nextRunAt: null,
    lastRunAt: null,
    lastGsSkus: null,
    lastRefreshed: null,
    lastError: null,
  });
}

export function getSchedulerStatus(): SchedulerStatus {
  const { started: _started, ...status } = store();
  return status;
}

async function refreshCatalog(): Promise<{ refreshed: number; error: string | null }> {
  let runId: string | undefined;
  let refreshed = 0;
  for (let round = 0; round < MAX_ROUNDS; round++) {
    const res = await runKicksdbRefresh({ limit: 100, runId });
    if (!res.ok) {
      console.error(`[scheduler] KicksDB refresh failed after ${refreshed} re-priced: ${res.error}`);
      return { refreshed, error: res.error ?? "refresh failed" };
    }
    runId = res.runId ?? runId;
    refreshed += res.refreshed ?? 0;
    if ((res.requested ?? 0) === 0 || (res.remainingStale ?? 0) === 0) break;
  }
  console.log(`[scheduler] KicksDB refresh done: ${refreshed} re-priced`);
  return { refreshed, error: null };
}

async function tick(): Promise<void> {
  const s = store();
  if (s.running) return; // previous pass still going — the next tick retries
  s.running = true;
  const errors: string[] = [];
  try {
    const { gsConfigured, syncGoldenSneakersFromApi } = await import("@/server/feeds/goldensneakers");
    if (gsConfigured()) {
      try {
        const report = await syncGoldenSneakersFromApi();
        s.lastGsSkus = report.skus;
        console.log(
          `[scheduler] GS sync done: ${report.skus} SKUs (${report.added} added, ${report.updated} updated, ${report.deactivated} deactivated)`,
        );
      } catch (e) {
        const message = e instanceof Error ? e.message : String(e);
        s.lastGsSkus = null;
        errors.push(`GS sync: ${message}`);
        console.error(`[scheduler] GS sync failed: ${message}`);
      }
    }
    const refresh = await refreshCatalog();
    s.lastRefreshed = refresh.refreshed;
    if (refresh.error) errors.push(`KicksDB refresh: ${refresh.error}`);
  } finally {
    s.running = false;
    s.lastRunAt = Date.now();
    s.lastError = errors.length > 0 ? errors.join(" · ") : null;
  }
}

function schedule(delayMs: number): void {
  store().nextRunAt = Date.now() + delayMs;
  setTimeout(async () => {
    await tick();
    schedule(TICK_MS);
  }, delayMs).unref();
}

export function startScheduler(): void {
  const enabled =
    env.SCHEDULER === "on" || (env.SCHEDULER === undefined && process.env.NODE_ENV === "production");
  if (!enabled) return;

  // Dev hot-reload can re-run instrumentation; never double the timers.
  const s = store();
  if (s.started) return;
  s.started = true;
  s.enabled = true;

  console.log("[scheduler] on — daily sync: GS complete sync, then KicksDB re-pricing");
  schedule(FIRST_TICK_MS);
}
