"use client";

import * as React from "react";
import {
  getFeedsState,
  runGsSyncFromApi,
  runKicksdbRefresh,
  uploadGsFeed,
  type FeedsState,
  type GsSyncActionResult,
} from "@/server/actions/feeds";
import { useI18n } from "@/i18n/provider";
import { Button } from "@/components/ui/button";

/** Safety cap on refresh rounds per click (100 SKUs/round). */
const MAX_ROUNDS = 50;

export function FeedsWorkspace({ initialState }: { initialState: FeedsState }) {
  const { t } = useI18n();
  const [state, setState] = React.useState(initialState);
  const [running, setRunning] = React.useState(false);
  const [progress, setProgress] = React.useState<{ refreshed: number; remaining: number } | null>(
    null,
  );
  const [error, setError] = React.useState<string | null>(null);

  /** Run the built-in refresh to exhaustion (bounded), one 100-SKU round per call. */
  async function runNow() {
    if (running) return;
    setRunning(true);
    setError(null);
    setProgress({ refreshed: 0, remaining: state.staleCount });
    try {
      let runId: string | undefined;
      let refreshed = 0;
      for (let round = 0; round < MAX_ROUNDS; round++) {
        const res = await runKicksdbRefresh({ limit: 100, runId });
        if (!res.ok) {
          setError(res.error ?? t.feeds.failed);
          break;
        }
        runId = res.runId ?? runId;
        refreshed += res.refreshed ?? 0;
        const remaining = res.remainingStale ?? 0;
        setProgress({ refreshed, remaining });
        if ((res.requested ?? 0) === 0 || remaining === 0) break;
      }
      setState(await getFeedsState());
    } finally {
      setRunning(false);
    }
  }

  return (
    <div className="space-y-5">
      {/* Registry: the built-in feed */}
      <section className="rounded-xl border border-line bg-surface p-4 shadow-xs">
        <div className="flex flex-wrap items-center gap-3">
          <span className="grid h-9 w-9 shrink-0 place-items-center rounded-lg bg-accent/15 text-accent-text">
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" className="h-[18px] w-[18px]">
              <path d="M4 11a9 9 0 0 1 9 9M4 4a16 16 0 0 1 16 16" />
              <circle cx="5" cy="19" r="1.5" fill="currentColor" stroke="none" />
            </svg>
          </span>
          <div className="min-w-0">
            <div className="flex items-center gap-2 text-sm font-semibold">
              {t.feeds.kicksdb.name}
              <span className="rounded-full bg-surface-2 px-2 py-0.5 text-[10px] font-semibold uppercase tracking-wide text-faint">
                {t.feeds.builtIn}
              </span>
            </div>
            <div className="text-xs text-muted">{t.feeds.kicksdb.desc(state.ttlSeconds)}</div>
          </div>
          <div className="ml-auto flex items-center gap-3">
            <div className="text-right text-xs text-muted tnum">
              <div>{t.feeds.kicksdb.stale(state.staleCount, state.catalogTotal)}</div>
              <div className="text-faint">{state.market}</div>
            </div>
            <Button
              type="button"
              variant="accent"
              onClick={runNow}
              disabled={running || state.staleCount === 0}
            >
              {running ? (
                <>
                  <span className="spin h-4 w-4 rounded-full border-2 border-accent-fg/30 border-t-accent-fg" />
                  {t.feeds.running}
                </>
              ) : (
                t.feeds.runNow
              )}
            </Button>
          </div>
        </div>

        {progress && (
          <div className="mt-3 flex items-center gap-3 border-t border-line pt-3 text-xs text-muted tnum animate-fade-up">
            <span className="text-up">{t.feeds.progressRefreshed(progress.refreshed)}</span>
            <span>{t.feeds.progressRemaining(progress.remaining)}</span>
          </div>
        )}
        {error && <p className="mt-2 text-sm text-skip">{error}</p>}

        {state.lastRuns.length > 0 && (
          <ul className="mt-3 divide-y divide-line/60 border-t border-line pt-2 text-sm">
            {state.lastRuns.map((r) => (
              <li key={r.id} className="flex flex-wrap items-center gap-2 py-1.5">
                <span className="text-xs text-faint tnum">
                  {new Date(r.startedAt).toLocaleString()}
                </span>
                <span className="ml-auto text-xs text-muted tnum">
                  {t.feeds.runLine(r.known, r.rejected)}
                </span>
                {r.error && <span className="w-full text-xs text-skip">{r.error}</span>}
              </li>
            ))}
          </ul>
        )}
      </section>

      {/* GoldenSneakers — external supplier feed, product-level ownership */}
      <GsFeedCard
        state={state}
        onSynced={async () => setState(await getFeedsState())}
      />
    </div>
  );
}

function GsFeedCard({ state, onSynced }: { state: FeedsState; onSynced: () => Promise<void> }) {
  const { t } = useI18n();
  const [running, setRunning] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);
  const [report, setReport] = React.useState<GsSyncActionResult["report"] | null>(null);

  async function handle(result: GsSyncActionResult) {
    if (!result.ok) setError(result.error ?? t.feeds.failed);
    else {
      setReport(result.report ?? null);
      await onSynced();
    }
  }

  async function runApi() {
    if (running) return;
    setError(null);
    setRunning(true);
    try {
      await handle(await runGsSyncFromApi());
    } finally {
      setRunning(false);
    }
  }

  async function onFile(file: File) {
    if (running) return;
    setError(null);
    setRunning(true);
    try {
      const text = await file.text();
      await handle(await uploadGsFeed({ text }));
    } catch {
      setError(t.importPage.fileReadError);
    } finally {
      setRunning(false);
    }
  }

  return (
    <section className="rounded-xl border border-line bg-surface p-4 shadow-xs">
      <div className="flex flex-wrap items-center gap-3">
        <span className="grid h-9 w-9 shrink-0 place-items-center rounded-lg bg-warn/15 text-warn">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" className="h-[18px] w-[18px]">
            <path d="M4 11a9 9 0 0 1 9 9M4 4a16 16 0 0 1 16 16" />
            <circle cx="5" cy="19" r="1.5" fill="currentColor" stroke="none" />
          </svg>
        </span>
        <div className="min-w-0">
          <div className="flex items-center gap-2 text-sm font-semibold">
            {t.feeds.gs.name}
            <span className="rounded-full bg-surface-2 px-2 py-0.5 text-[10px] font-semibold uppercase tracking-wide text-faint">
              {t.feeds.gs.tag}
            </span>
          </div>
          <div className="text-xs text-muted">{t.feeds.gs.desc}</div>
        </div>
        <div className="ml-auto flex items-center gap-3">
          <div className="text-right text-xs text-muted tnum">
            {t.feeds.gs.stats(state.gs.activeSkus, state.gs.activeRows)}
          </div>
          {state.gs.configured ? (
            <Button type="button" variant="accent" onClick={runApi} disabled={running}>
              {running ? (
                <>
                  <span className="spin h-4 w-4 rounded-full border-2 border-accent-fg/30 border-t-accent-fg" />
                  {t.feeds.running}
                </>
              ) : (
                t.feeds.gs.syncApi
              )}
            </Button>
          ) : (
            <label className="flex cursor-pointer items-center gap-2 rounded-lg border border-dashed border-line-strong bg-surface-2 px-3 py-2 text-sm font-medium text-muted transition-colors hover:text-ink">
              {running ? t.feeds.running : t.feeds.gs.upload}
              <input
                type="file"
                accept=".json"
                className="hidden"
                onChange={(e) => {
                  const f = e.target.files?.[0];
                  if (f) void onFile(f);
                  e.target.value = "";
                }}
              />
            </label>
          )}
        </div>
      </div>

      {!state.gs.configured && (
        <p className="mt-2 text-xs text-faint">{t.feeds.gs.notConfigured}</p>
      )}
      {error && <p className="mt-2 text-sm text-skip">{error}</p>}

      {report && (
        <div className="mt-3 flex flex-wrap gap-x-4 gap-y-1 border-t border-line pt-3 text-xs text-muted tnum animate-fade-up">
          <span className="font-semibold text-ink">{t.feeds.gs.reportRows(report.rows, report.skus)}</span>
          <span className="text-up">{t.importPage.added(report.added)}</span>
          <span>{t.feeds.gs.reportUpdated(report.updated)}</span>
          <span className={report.deactivated > 0 ? "text-warn" : undefined}>
            {t.feeds.gs.reportDeactivated(report.deactivated)}
          </span>
          <span className={report.rejected > 0 ? "text-skip" : undefined}>
            {t.importPage.rejected(report.rejected)}
          </span>
          {report.catalogRegistered > 0 && (
            <span className="text-accent-text">
              {t.feeds.gs.reportRegistered(report.catalogRegistered)}
            </span>
          )}
        </div>
      )}

      {state.gs.lastRuns.length > 0 && (
        <ul className="mt-3 divide-y divide-line/60 border-t border-line pt-2 text-sm">
          {state.gs.lastRuns.map((r) => (
            <li key={r.id} className="flex flex-wrap items-center gap-2 py-1.5">
              <span className="text-xs text-faint tnum">{new Date(r.startedAt).toLocaleString()}</span>
              <span className="ml-auto text-xs text-muted tnum">
                {t.feeds.gs.runLine(r.added, r.known, r.rejected)}
              </span>
              {r.error && <span className="w-full text-xs text-skip">{r.error}</span>}
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}
