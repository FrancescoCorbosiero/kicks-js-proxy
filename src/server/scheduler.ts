import { and, desc, eq, isNotNull, lt, max, ne } from "drizzle-orm";
import { env } from "@/lib/env";
import {
  DEFAULT_TIMEZONE,
  feedSchedule,
  intervalTimes,
  nextSlot,
  parseTimes,
  previousSlot,
  retryAt,
  slotMissed,
  type AutoSync,
} from "@/lib/schedule";
import { runKicksdbRefresh } from "@/server/actions/feeds";
import { kicksdbConfigured } from "@/server/adapters/kicksdb";
import { db } from "@/server/db/client";
import { schedulerRuns, type SchedulerRunRow } from "@/server/db/schema";

/**
 * In-app scheduler: the app syncs itself, no external cron needed.
 * Started once per server boot from src/instrumentation.ts.
 *
 * Every day at SCHEDULER_TIMES (default 04:30) in SCHEDULER_TIMEZONE
 * (default Europe/Rome) it runs, in order:
 *   1. the store pull — the Hub's copy of every product on WooCommerce;
 *   2. the GoldenSneakers complete sync;
 *   3. a KicksDB re-pricing pass, so whatever the sync registered is priced;
 *   4. with AUTO_SYNC=on, the store sync of the whole store: every price and
 *      stock change the sources now call for, written to it (see syncStore);
 *   5. self-repair (AUTO_REPAIR=on only), metadata backfill, recategorize.
 * A step that fails does not stop the others, and is retried an hour later
 * (twice at most). Every run is recorded in scheduler_runs, so a restarting
 * server knows whether the last slot ran: one missed while the server was
 * down, or whose run failed, runs a minute after boot — while a deploy after
 * a good run starts nothing. A fully successful run calls
 * SCHEDULER_HEARTBEAT_URL, for a monitor that alerts when the calls stop.
 *
 * The feed cycle, every SCHEDULER_FEEDS_MINUTES on the clock (15 → :00, :15,
 * :30, :45; 15 by default when the GoldenSneakers API is set), is the short
 * version for a supplier whose stock moves during the day: the GoldenSneakers
 * sync, then the store sync of the feed's products only — unless
 * AUTO_SYNC=off (see feedSchedule). KicksDB-priced products wait for the
 * daily run: planning them asks KicksDB about every one, every time. A cycle
 * never overlaps another run: it skips its turn while one is going, and the
 * daily run waits for a cycle to finish rather than lose its slot. A fully
 * successful cycle calls SCHEDULER_FEEDS_HEARTBEAT_URL.
 *
 * Alongside, the recent orders are pulled every SCHEDULER_ORDERS_MINUTES
 * (default 15), so new orders reach the Orders tab without a click.
 *
 * On by default in production, off in dev; SCHEDULER=on|off overrides.
 * Needs a long-running server (`next start`, Docker) — a serverless
 * platform that freezes the process between requests won't tick.
 * The /api/cron/* endpoints stay available for external schedulers.
 */

/** Products healed per tick — a big store recovers over days, not in one burst. */
const MAX_REPAIRS_PER_TICK = 200;

/** Rounds per refresh pass (100 SKUs each) — same backstop as the cron route. */
const MAX_ROUNDS = 50;
/** A missed slot runs this long after boot, once the server has settled. */
const CATCH_UP_DELAY_MS = 60 * 1000;
const RETRY_DELAY_MS = 60 * 60 * 1000;
const MAX_RETRIES = 2;
/** A store pull the Sync tab moved forward this recently is still being driven. */
const ACTIVE_PULL_MS = 2 * 60 * 1000;
const DEFAULT_TIMES = "04:30";
const DEFAULT_ORDERS_MINUTES = 15;
/** Variations an automatic store sync may change in one run (AUTO_SYNC_MAX_CHANGES). */
const DEFAULT_MAX_CHANGES = 500;
/** How long the daily run waits for a feed cycle still going before it gives up. */
const WAIT_FOR_IDLE_MS = 60 * 60 * 1000;
/** Feed cycles kept in scheduler_runs. */
const FEED_HISTORY_DAYS = 7;

const DAILY_STEPS = ["pull", "gs", "kicksdb", "storeSync", "repair", "backfill", "recategorize"] as const;
const FEED_STEPS = ["gs", "feedSync"] as const;
type StepName = (typeof DAILY_STEPS)[number] | (typeof FEED_STEPS)[number];
type StepOutcome = { ok: boolean; count?: number; note?: string };

const LABEL: Record<StepName, string> = {
  pull: "store pull",
  gs: "GS sync",
  kicksdb: "KicksDB refresh",
  storeSync: "store sync",
  feedSync: "store sync",
  repair: "repair",
  backfill: "metadata backfill",
  recategorize: "recategorize",
};

/** The status counters the daily run's steps report into. */
const COUNTER = {
  pull: "lastPulled",
  gs: "lastGsSkus",
  kicksdb: "lastRefreshed",
  storeSync: "lastWritten",
  repair: "lastRepaired",
} as const satisfies Partial<Record<StepName, keyof SchedulerStatus>>;

interface Job {
  kind: "daily" | "feeds";
  /** The scheduled time this run is for (a catch-up or a retry keeps its slot's). */
  slot: Date;
  trigger: SchedulerRunRow["trigger"];
  steps: readonly StepName[];
  attempt: number;
}

/** Live scheduler state, surfaced on /feeds via getFeedsState(). */
export interface SchedulerStatus {
  enabled: boolean;
  running: boolean;
  times: string[]; // the daily sync's times of day…
  timeZone: string; // …in this zone
  nextRunAt: number | null; // epoch ms
  lastRunAt: number | null;
  lastPulled: number | null; // products in the last store pull (null = not run)
  lastGsSkus: number | null; // SKUs in the last GS sync (null = not run)
  lastRefreshed: number | null; // entries re-priced in the last pass
  lastRepaired: number | null; // products healed in the last pass (null = off)
  lastWritten: number | null; // variations the last store sync wrote (null = not run)
  lastError: string | null;
  autoSync: AutoSync; // what the runs write to the store unattended
  autoSyncMax: number; // …at most this many variations per run
  feedsEveryMinutes: number; // 0 = no feed cycle
  feedsNextAt: number | null;
  feedsLastAt: number | null;
  feedsLastWritten: number | null; // variations the last cycle wrote
  feedsError: string | null;
  ordersEveryMinutes: number; // 0 = orders are pulled by hand only
  ordersLastAt: number | null;
  ordersError: string | null;
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
    times: [],
    timeZone: DEFAULT_TIMEZONE,
    nextRunAt: null,
    lastRunAt: null,
    lastPulled: null,
    lastGsSkus: null,
    lastRefreshed: null,
    lastRepaired: null,
    lastWritten: null,
    lastError: null,
    autoSync: "off",
    autoSyncMax: DEFAULT_MAX_CHANGES,
    feedsEveryMinutes: 0,
    feedsNextAt: null,
    feedsLastAt: null,
    feedsLastWritten: null,
    feedsError: null,
    ordersEveryMinutes: 0,
    ordersLastAt: null,
    ordersError: null,
  });
}

export function getSchedulerStatus(): SchedulerStatus {
  const { started: _started, ...status } = store();
  return status;
}

const messageOf = (e: unknown) => (e instanceof Error ? e.message : String(e));
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/** "2026-10-01 04:30" in the schedule's zone, for the log. */
const when = (date: Date) =>
  new Intl.DateTimeFormat("sv-SE", { timeZone: store().timeZone, dateStyle: "short", timeStyle: "short" }).format(date);

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

/**
 * The store sync, unattended: the same preview the Sync tab runs, then its
 * apply — what an operator does by pressing "apply all" — over the whole
 * store (the daily run) or the products the feed has ever listed (the feed
 * cycle; dropped ones included, so their sizes go to 0).
 *
 * Narrower than the tab, on purpose: prices and stock only — no size cleanup
 * (it deletes variations) and no identifiers. A run that would change more
 * than AUTO_SYNC_MAX_CHANGES variations writes nothing: a change that large is
 * a pricing edit or a broken feed, and either is reviewed in the Sync tab
 * first. Every write lands in the Sync tab's history like a manual apply.
 * The run's plans are dropped afterwards (see deleteRunPlans).
 */
async function syncStore(scope: "store" | "feed"): Promise<StepOutcome | null> {
  const writes = store().autoSync;
  if (writes === "off" || (scope === "store" && writes !== "all")) return null;
  const { wooConfigured } = await import("@/server/woo/client");
  if (!wooConfigured()) return null;

  let skus: string[] | undefined;
  if (scope === "feed") {
    const { GS_FEED, knownFeedSkus } = await import("@/server/feeds/repo");
    const { listStoreSkuSpellings } = await import("@/server/store-json/repo");
    const { skuKey } = await import("@/lib/skus");
    const known = await knownFeedSkus(GS_FEED);
    skus = (await listStoreSkuSpellings()).filter((sku) => known.has(skuKey(sku)));
    if (skus.length === 0) return { ok: true, count: 0, note: "no feed products on the store" };
  }

  const preview = await import("@/server/actions/preview");
  const { deleteRunPlans } = await import("@/server/plans/repo");
  const started = await preview.startStoreSync(undefined, skus);
  if (!started.ok || !started.progress) throw new Error(started.error ?? "the store sync could not start");
  const runId = started.progress.runId;
  try {
    let progress = started.progress;
    // A step plans 250 SKUs and always moves the cursor or ends the run;
    // the bound only guards against a run that stops doing either.
    const maxSteps = Math.ceil(progress.total / 100) + 10;
    for (let step = 0; !progress.done; step++) {
      if (progress.status !== "running") throw new Error(progress.error ?? `the store sync was ${progress.status}`);
      if (step > maxSteps) throw new Error("the store sync did not finish");
      const next = await preview.advanceStoreSync(runId);
      if (!next.ok || !next.progress) throw new Error(next.error ?? "a store sync step failed");
      progress = next.progress;
    }

    const planned = progress.result?.totals?.update ?? 0;
    if (planned === 0) return { ok: true, count: 0 };
    const limit = store().autoSyncMax;
    if (planned > limit) {
      throw new Error(
        `${planned} changes planned, more than the ${limit} an automatic run may write (AUTO_SYNC_MAX_CHANGES): ` +
          "nothing written. Review and apply them in the Sync tab.",
      );
    }

    const { applySync } = await import("@/server/woo/apply");
    const outcome = await applySync({ runId, priceScope: "all", dryRun: false, sanitize: false, backfillGtins: false });
    if (outcome.failedTotal > 0) {
      throw new Error(
        `${outcome.updated} of ${outcome.variations} changes written, ${outcome.failedTotal} failed: ` +
          (outcome.failed[0]?.error ?? "no reason given"),
      );
    }
    console.log(
      `[scheduler] store sync: ${outcome.updated} change(s) written (${scope === "feed" ? "feed products" : "whole store"})`,
    );
    return { ok: true, count: outcome.updated };
  } finally {
    await deleteRunPlans(runId).catch((e) => console.warn(`[scheduler] plans of run ${runId} kept: ${messageOf(e)}`));
  }
}

/**
 * The scheduled runs' steps. Each answers what it did, null when it does not
 * apply to this shop (its source is not configured, or AUTO_SYNC is off), or
 * throws.
 */
const RUN_STEP: Record<StepName, () => Promise<StepOutcome | null>> = {
  async pull() {
    const { wooConfigured } = await import("@/server/woo/client");
    if (!wooConfigured()) return null;
    const { getLatestPullRun, runFullPull } = await import("@/server/woo/pull");
    const latest = await getLatestPullRun();
    if (latest?.status === "running" && Date.now() - latest.updatedAt.getTime() < ACTIVE_PULL_MS) {
      // Two drivers on one pull would race for its cursor: let the Sync tab
      // finish, and pull again on the retry.
      throw new Error("a pull is running from the Sync tab right now");
    }
    const progress = await runFullPull();
    if (progress.status !== "done") {
      throw new Error(progress.error ?? `stopped after ${progress.productsFetched} products (${progress.status})`);
    }
    console.log(`[scheduler] store pull done: ${progress.productsFetched} products`);
    return { ok: true, count: progress.productsFetched };
  },

  async gs() {
    const { gsConfigured, syncGoldenSneakersFromApi } = await import("@/server/feeds/goldensneakers");
    if (!gsConfigured()) return null;
    const report = await syncGoldenSneakersFromApi();
    const note = `${report.added} added, ${report.updated} updated, ${report.deactivated} deactivated`;
    console.log(`[scheduler] GS sync done: ${report.skus} SKUs (${note})`);
    return { ok: true, count: report.skus, note };
  },

  // The re-pricing pass exists only where KicksDB does; a supplier-feed-only
  // instance gets its prices from the feed sync above and nothing else.
  async kicksdb() {
    if (!kicksdbConfigured()) return null;
    const { refreshed, error } = await refreshCatalog();
    if (error) throw new Error(`${error} (after ${refreshed} re-priced)`);
    return { ok: true, count: refreshed };
  },

  storeSync: () => syncStore("store"),
  feedSync: () => syncStore("feed"),

  // Self-repair: products already online that lost a field to a source's
  // change of shape. Additive and idempotent, but it writes to the LIVE
  // store, so it runs only when explicitly armed.
  async repair() {
    if (env.AUTO_REPAIR !== "on") return null;
    const { scanRepairCandidates, repairProducts } = await import("@/server/woo/repair");
    const { incomplete } = await scanRepairCandidates();
    // Bounded: a big store heals over successive days rather than
    // hammering the REST API in one tick.
    const batch = incomplete.slice(0, MAX_REPAIRS_PER_TICK);
    if (batch.length === 0) return { ok: true, count: 0 };
    const outcome = await repairProducts(batch, { dryRun: false });
    console.log(
      `[scheduler] repair done: ${outcome.repaired} healed, ${outcome.alreadyWhole} already whole, ${outcome.failed} failed`,
    );
    return { ok: true, count: outcome.repaired };
  },

  // Drain a slice of the metadata-backfill queue (rows imported before the
  // catalog stored category/gender/gallery). Bounded so one tick never
  // hammers the products endpoint; the queue empties over successive days.
  async backfill() {
    const { backfillCatalogMetadata } = await import("@/server/catalog/enrich");
    const enrich = await backfillCatalogMetadata(250);
    if (enrich.scanned > 0) {
      console.log(
        `[scheduler] metadata backfill: ${enrich.enriched} enriched, ${enrich.missed} rotated (of ${enrich.scanned})`,
      );
    }
    return { ok: true, count: enrich.enriched };
  },

  // Classify whatever is still uncategorized from the stored titles (feed
  // and store-only rows have no API metadata at all — see classify.ts), and
  // fold case-variant duplicate categories into one bucket.
  async recategorize() {
    const { recategorizeCatalog } = await import("@/server/catalog/repo");
    const { getActiveConfig } = await import("@/server/config/repo");
    const market = (await getActiveConfig()).source.market;
    const recat = await recategorizeCatalog(market);
    if (recat.classified > 0 || recat.unified > 0 || recat.synced > 0) {
      console.log(
        `[scheduler] recategorize: ${recat.classified} classified from titles, ` +
          `${recat.unified} case-duplicates unified, ${recat.synced} synced into the stored product`,
      );
    }
    return { ok: true, count: recat.classified };
  },
};

/**
 * The run history (scheduler_runs). Never throws: a history that cannot be
 * written must not stop the sync itself.
 */
const history = {
  async open(job: Job): Promise<string | null> {
    try {
      const [row] = await db
        .insert(schedulerRuns)
        .values({ slotAt: job.slot, trigger: job.trigger })
        .returning({ id: schedulerRuns.id });
      return row.id;
    } catch (e) {
      console.error(`[scheduler] could not record the run: ${messageOf(e)}`);
      return null;
    }
  },

  async close(id: string | null, summary: Record<string, StepOutcome>, error: string | null): Promise<void> {
    if (!id) return;
    try {
      await db
        .update(schedulerRuns)
        .set({ status: error ? "failed" : "ok", summary, error, finishedAt: new Date() })
        .where(eq(schedulerRuns.id, id));
    } catch (e) {
      console.error(`[scheduler] could not record the run's outcome: ${messageOf(e)}`);
    }
  },

  /** Feed cycles older than a week: dozens a day, read only for the last one. */
  async prune(): Promise<void> {
    try {
      await db
        .delete(schedulerRuns)
        .where(
          and(
            eq(schedulerRuns.trigger, "interval"),
            lt(schedulerRuns.startedAt, new Date(Date.now() - FEED_HISTORY_DAYS * 24 * 60 * 60 * 1000)),
          ),
        );
    } catch (e) {
      console.warn(`[scheduler] old feed cycles kept: ${messageOf(e)}`);
    }
  },
};

/**
 * At boot: close the runs a stopped server left open, show the last daily run
 * and the last feed cycle on /feeds again, and return the latest slot a daily
 * run completed successfully.
 */
async function loadHistory(s: SchedulerState): Promise<Date | null> {
  await db
    .update(schedulerRuns)
    .set({ status: "interrupted", finishedAt: new Date() })
    .where(eq(schedulerRuns.status, "running"));

  const [last] = await db
    .select()
    .from(schedulerRuns)
    .where(and(isNotNull(schedulerRuns.finishedAt), ne(schedulerRuns.trigger, "interval")))
    .orderBy(desc(schedulerRuns.startedAt))
    .limit(1);
  if (last) {
    s.lastRunAt = (last.finishedAt ?? last.startedAt).getTime();
    s.lastError = last.error;
    for (const [step, counter] of Object.entries(COUNTER)) {
      const outcome = last.summary?.[step];
      if (outcome?.ok) s[counter] = outcome.count ?? null;
    }
  }

  const [cycle] = await db
    .select()
    .from(schedulerRuns)
    .where(and(isNotNull(schedulerRuns.finishedAt), eq(schedulerRuns.trigger, "interval")))
    .orderBy(desc(schedulerRuns.startedAt))
    .limit(1);
  if (cycle) {
    s.feedsLastAt = (cycle.finishedAt ?? cycle.startedAt).getTime();
    s.feedsError = cycle.error;
    const written = cycle.summary?.feedSync;
    if (written?.ok) s.feedsLastWritten = written.count ?? null;
  }

  const [served] = await db
    .select({ slot: max(schedulerRuns.slotAt) })
    .from(schedulerRuns)
    .where(and(eq(schedulerRuns.status, "ok"), ne(schedulerRuns.trigger, "interval")));
  return served?.slot ? new Date(served.slot) : null;
}

/** Tell the monitor behind a heartbeat URL that a run went through. */
async function heartbeat(url: string | undefined): Promise<void> {
  if (!url) return;
  try {
    const res = await fetch(url, { signal: AbortSignal.timeout(10_000) });
    if (!res.ok) console.warn(`[scheduler] heartbeat answered ${res.status}`);
  } catch (e) {
    console.warn(`[scheduler] heartbeat failed: ${messageOf(e)}`);
  }
}

/**
 * Run a job's steps in order; answers the steps that failed, or null when a
 * feed cycle found another run going and skipped its turn.
 */
async function run(job: Job): Promise<StepName[] | null> {
  const s = store();
  if (s.running) {
    if (job.kind === "feeds") {
      console.log("[scheduler] feed cycle skipped: another run is still going");
      return null;
    }
    // The daily run waits for a feed cycle rather than lose its slot.
    const deadline = Date.now() + WAIT_FOR_IDLE_MS;
    while (s.running && Date.now() < deadline) await sleep(5_000);
    if (s.running) {
      s.lastError = "another run has been going for an hour: this run did not start";
      console.error(`[scheduler] ${s.lastError}`);
      return [...job.steps];
    }
  }
  s.running = true;
  const id = await history.open(job);
  const summary: Record<string, StepOutcome> = {};
  const failed: StepName[] = [];
  try {
    for (const step of job.steps) {
      try {
        const outcome = await RUN_STEP[step]();
        if (outcome) summary[step] = outcome;
      } catch (e) {
        summary[step] = { ok: false, note: messageOf(e) };
        failed.push(step);
        console.error(`[scheduler] ${LABEL[step]} failed: ${messageOf(e)}`);
      }
    }
  } finally {
    s.running = false;
    const error = failed.length > 0 ? failed.map((step) => `${LABEL[step]}: ${summary[step].note}`).join(" · ") : null;
    if (job.kind === "feeds") {
      s.feedsLastAt = Date.now();
      s.feedsError = error;
      const written = summary.feedSync;
      s.feedsLastWritten = written?.ok ? (written.count ?? null) : null;
    } else {
      s.lastRunAt = Date.now();
      s.lastError = error;
      for (const step of job.steps) {
        if (step in COUNTER) {
          const outcome = summary[step];
          s[COUNTER[step as keyof typeof COUNTER]] = outcome?.ok ? (outcome.count ?? null) : null;
        }
      }
    }
    await history.close(id, summary, error);
  }
  // Every step has now succeeded (a retry runs only the failed ones).
  if (failed.length === 0) {
    await heartbeat(job.kind === "feeds" ? env.SCHEDULER_FEEDS_HEARTBEAT_URL : env.SCHEDULER_HEARTBEAT_URL);
  }
  if (job.kind === "daily") await history.prune();
  return failed;
}

function arm(at: number, job: Job): void {
  store().nextRunAt = at;
  setTimeout(() => void fire(job), Math.max(0, at - Date.now())).unref();
}

/** Run a daily job, then arm what comes next: a retry of its failed steps, or the next slot. */
async function fire(job: Job): Promise<void> {
  const s = store();
  let failed: readonly StepName[];
  try {
    failed = (await run(job)) ?? [];
  } catch (e) {
    console.error(`[scheduler] run crashed: ${messageOf(e)}`);
    failed = job.steps;
  }
  const next = nextSlot(new Date(Math.max(Date.now(), job.slot.getTime())), s.times, s.timeZone);
  const retry = retryAt({
    failed: failed.length,
    attempt: job.attempt,
    now: new Date(),
    next,
    delayMs: RETRY_DELAY_MS,
    maxRetries: MAX_RETRIES,
  });
  if (retry) {
    console.log(`[scheduler] retrying ${failed.map((step) => LABEL[step]).join(", ")} at ${when(retry)}`);
    arm(retry.getTime(), { kind: "daily", slot: job.slot, trigger: "retry", steps: failed, attempt: job.attempt + 1 });
  } else {
    arm(next.getTime(), { kind: "daily", slot: next, trigger: "schedule", steps: DAILY_STEPS, attempt: 0 });
  }
}

/** Decide the first run: the last slot if it never completed, else the next one. */
async function boot(s: SchedulerState): Promise<void> {
  let served: Date | null = null;
  try {
    served = await loadHistory(s);
  } catch (e) {
    console.error(`[scheduler] run history unavailable (${messageOf(e)}) — treating the last slot as missed`);
  }
  const now = new Date();
  if (slotMissed(served, now, s.times, s.timeZone)) {
    const slot = previousSlot(now, s.times, s.timeZone);
    console.log(`[scheduler] the ${when(slot)} sync never completed — running it in a minute`);
    arm(Date.now() + CATCH_UP_DELAY_MS, { kind: "daily", slot, trigger: "catch-up", steps: DAILY_STEPS, attempt: 0 });
  } else {
    const slot = nextSlot(now, s.times, s.timeZone);
    arm(slot.getTime(), { kind: "daily", slot, trigger: "schedule", steps: DAILY_STEPS, attempt: 0 });
  }
}

/**
 * The feed cycle's timer: the next mark on the clock after `after`. No
 * catch-up and no retries — the next cycle is never far off.
 */
function armFeeds(after: Date): void {
  const s = store();
  const slot = nextSlot(after, intervalTimes(s.feedsEveryMinutes), s.timeZone);
  s.feedsNextAt = slot.getTime();
  setTimeout(() => void fireFeeds(slot), Math.max(0, slot.getTime() - Date.now())).unref();
}

async function fireFeeds(slot: Date): Promise<void> {
  try {
    await run({ kind: "feeds", slot, trigger: "interval", steps: FEED_STEPS, attempt: 0 });
  } catch (e) {
    console.error(`[scheduler] feed cycle crashed: ${messageOf(e)}`);
  }
  armFeeds(new Date(Math.max(Date.now(), slot.getTime())));
}

/** Pull the recent orders, then again every SCHEDULER_ORDERS_MINUTES. */
async function pullOrders(): Promise<void> {
  const s = store();
  try {
    const { wooConfigured } = await import("@/server/woo/client");
    if (wooConfigured()) {
      const { pullRecentOrders } = await import("@/server/orders/pull");
      await pullRecentOrders();
      if (s.ordersError) console.log("[scheduler] orders pull is working again");
      s.ordersLastAt = Date.now();
      s.ordersError = null;
    }
  } catch (e) {
    const cause = (e as { cause?: { message?: string } })?.cause;
    s.ordersError = cause?.message ?? messageOf(e);
    console.error(`[scheduler] orders pull failed: ${s.ordersError}`);
  } finally {
    setTimeout(() => void pullOrders(), s.ordersEveryMinutes * 60 * 1000).unref();
  }
}

export function startScheduler(): void {
  // The schedule, shown on /feeds even while the scheduler is off.
  const s = store();
  s.times = parseTimes(env.SCHEDULER_TIMES ?? DEFAULT_TIMES);
  s.timeZone = env.SCHEDULER_TIMEZONE ?? DEFAULT_TIMEZONE;
  s.ordersEveryMinutes = env.SCHEDULER_ORDERS_MINUTES ?? DEFAULT_ORDERS_MINUTES;
  const feeds = feedSchedule({
    feedsMinutes: env.SCHEDULER_FEEDS_MINUTES,
    autoSync: env.AUTO_SYNC,
    // gsConfigured()'s test: its module loads only once a run needs it.
    gsConfigured: !!(env.GS_FEED_URL && env.GS_FEED_TOKEN),
  });
  s.feedsEveryMinutes = feeds.feedsEveryMinutes;
  s.autoSync = feeds.autoSync;
  s.autoSyncMax = env.AUTO_SYNC_MAX_CHANGES ?? DEFAULT_MAX_CHANGES;

  const enabled =
    env.SCHEDULER === "on" || (env.SCHEDULER === undefined && process.env.NODE_ENV === "production");
  if (!enabled) return;

  // Dev hot-reload can re-run instrumentation; never double the timers.
  if (s.started) return;
  s.started = true;
  s.enabled = true;

  const sync = s.autoSync === "all" ? `, store sync (up to ${s.autoSyncMax} changes)` : "";
  const feedSync = s.autoSync === "off" ? "" : ` + store sync of the feed's products (up to ${s.autoSyncMax} changes)`;
  console.log(
    `[scheduler] on — daily sync at ${s.times.join(", ")} (${s.timeZone}): store pull, GS sync, KicksDB re-pricing${sync}; ` +
      (s.feedsEveryMinutes > 0 ? `feeds every ${s.feedsEveryMinutes} min${feedSync}; ` : "") +
      (s.ordersEveryMinutes > 0 ? `orders every ${s.ordersEveryMinutes} min` : "orders by hand only"),
  );
  void boot(s);
  if (s.feedsEveryMinutes > 0) armFeeds(new Date());
  if (s.ordersEveryMinutes > 0) setTimeout(() => void pullOrders(), CATCH_UP_DELAY_MS).unref();
}
