"use client";

import * as React from "react";
import { useRouter } from "next/navigation";
import { mutate } from "swr";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Badge } from "@/components/ui/badge";
import { Checkbox } from "@/components/ui/checkbox";
import { useI18n } from "@/i18n/provider";
import { listPublishSkus, type PublishActionResult } from "@/server/actions/publish";
import type { PublishOutcome, PublishProductReport, PublishTarget } from "@/server/woo/publish";
import { hasMixedSources, type PublishCounts, type PublishSourceLens } from "@/lib/publish-page";
import { mergeQuery, type QueryParams } from "@/lib/qs";
import { FIRST_BATCH, nextBatchSize, nextPace } from "@/lib/publish-batching";
import { CardImage } from "@/components/catalog/CardImage";
import { RepairPanel } from "./RepairPanel";
import { MediaQueuePanel } from "./MediaQueuePanel";
import type { MediaQueueState } from "@/server/woo/media";

/**
 * Bounds, all for the same reason: everything below is rendered by the browser,
 * and the catalog has no ceiling. A shop with 4000 unpublished products must
 * cost the same in DOM nodes as a shop with 40. The list's own bound lives on
 * the server (PAGE_LIMIT) — the browser is never sent more rows than that.
 *
 * The SELECTION is not bounded: "select all" takes every product the filters
 * match, and the run walks them a batch at a time — each sized from the
 * shop's measured pace to stay well inside Cloudflare's 100 seconds (see
 * lib/publish-batching) — so the store sees the same steady trickle of calls
 * for 40 products as for 400, only for longer. A long run can be stopped
 * between batches, and leaving the page asks first.
 */
/** Answers from the proxy in front, not the app: it stopped waiting. */
const PROXY_GAVE_UP = new Set([502, 503, 504, 520, 522, 524]);
/** Such answers in a row before a run stops: the server itself is in trouble. */
const MAX_PROXY_FAILURES = 3;
/** Report rows rendered. The counters above them always cover the whole run. */
const REPORT_LIMIT = 60;

/**
 * The Publisher's workspace: the catalog→store delta, selectable, with a dry
 * run to see what would be written before writing it.
 *
 * Creating a product is not reversible the way a price is — an accidental
 * parent has to be hunted down in wp-admin — so nothing is selected by
 * default and publishing without a dry run asks for a confirmation first.
 * The dry run is not what keeps duplicates out: the live run itself checks
 * every SKU against the store right before creating it. Force reimport is
 * different — it DELETES and recreates a live product's sizes — so that one
 * still requires a dry run of exactly the selection before it is armed.
 */

const eur = new Intl.NumberFormat("it-IT", { style: "currency", currency: "EUR" });

/** The server answered with something that is not the route's JSON. */
class UnexpectedResponse extends Error {
  constructor(readonly status: number) {
    super(`HTTP ${status}`);
  }
}

/**
 * One batch through /api/publish rather than the server action itself: an
 * action in flight holds every page change behind it (see the route), and a
 * run is batch after batch of them.
 */
async function publishBatch(input: {
  skus: string[];
  dryRun: boolean;
  includeGallery: boolean;
  force: boolean;
  replaceMedia: boolean;
}): Promise<PublishActionResult> {
  const res = await fetch("/api/publish", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(input),
  });
  // A sign-in that expired mid-run answers with the sign-in page, not JSON.
  if (!res.headers.get("content-type")?.includes("application/json")) {
    throw new UnexpectedResponse(res.status);
  }
  return (await res.json()) as PublishActionResult;
}

/** Keystrokes settle before the server is asked — same as discovery's. */
const DEBOUNCE_MS = 350;

export function PublishWorkspace({
  candidates,
  counts,
  matched,
  params,
  hasSnapshot,
  wooConfigured,
  siteUrl,
  media,
  mediaWorker,
}: {
  /** ONE PAGE of the delta. The filters below are answered by the server. */
  candidates: PublishTarget[];
  /** Totals over the whole pool, never over the page. */
  counts: PublishCounts;
  /** Rows matching the current filters, including those past the page. */
  matched: number;
  /** Current URL params — the base every filter update merges over. */
  params: QueryParams;
  hasSnapshot: boolean;
  wooConfigured: boolean;
  siteUrl: string;
  /** The photo queue: products created hidden, going on sale with their first photo. */
  media: MediaQueueState | null;
  mediaWorker: boolean;
}) {
  const { t } = useI18n();
  const router = useRouter();

  const [selected, setSelected] = React.useState<Set<string>>(new Set());
  const [includeGallery, setIncludeGallery] = React.useState(false);
  const [force, setForce] = React.useState(false);
  const [replaceMedia, setReplaceMedia] = React.useState(false);
  // Plain state, not a transition: React holds a navigation started while a
  // transition's async work is pending until that work is done, and a run is
  // minutes of it — following any link mid-run waited for the whole run.
  const [busy, setBusy] = React.useState(false);
  // The same, synchronously: two clicks in one frame must not start two runs.
  const running = React.useRef(false);
  const [, startFilter] = React.useTransition();
  const [outcome, setOutcome] = React.useState<PublishOutcome | null>(null);
  const [progress, setProgress] = React.useState<{
    done: number;
    total: number;
    /** Time left at the pace so far; null until the first batch has set one. */
    msLeft: number | null;
  } | null>(null);
  const [error, setError] = React.useState<string | null>(null);
  // Publishing without a dry run: one explicit "yes" first.
  const [confirming, setConfirming] = React.useState(false);
  const [selectingAll, setSelectingAll] = React.useState(false);
  // Stop between batches: the batch in flight finishes (its products are
  // independent of each other), nothing after it starts.
  const stopRef = React.useRef(false);
  const [stopping, setStopping] = React.useState(false);
  const [stopped, setStopped] = React.useState<{ done: number; total: number } | null>(null);
  const [liveRunning, setLiveRunning] = React.useState(false);
  // Products of batches the proxy gave up on: most likely finished by the
  // server anyway, but unconfirmed — they stay selected for a later run.
  const [unanswered, setUnanswered] = React.useState(0);

  // The URL is the source of truth for the three filters; `term` is a local
  // echo so typing stays responsive between debounced pushes.
  const source = (params.src as PublishSourceLens) ?? "all";
  const showOnStore = params.onStore === "1";
  const [term, setTerm] = React.useState(String(params.q ?? ""));
  const timer = React.useRef<ReturnType<typeof setTimeout> | null>(null);
  React.useEffect(() => () => {
    if (timer.current) clearTimeout(timer.current);
  }, []);

  function pushFilter(updates: QueryParams) {
    // Merge over the LIVE URL, not the render-time prop: a debounced push
    // fires after the keystroke, by which time another control may have
    // navigated, and a stale base would silently revert it.
    const current: QueryParams = Object.fromEntries(
      new URLSearchParams(window.location.search).entries(),
    );
    startFilter(() => {
      router.replace(`/publish${mergeQuery(current, updates)}`, { scroll: false });
    });
  }

  function pushFilterDebounced(updates: QueryParams) {
    if (timer.current) clearTimeout(timer.current);
    timer.current = setTimeout(() => pushFilter(updates), DEBOUNCE_MS);
  }

  // Both sources represented? Everything provider-specific in this tab hangs
  // off this: on a single-source shop the labels are noise, not information.
  const mixedSources = hasMixedSources(counts);
  const visible = candidates;

  function toggle(sku: string) {
    setOutcome(null);
    setConfirming(false);
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(sku)) next.delete(sku);
      else next.add(sku);
      return next;
    });
  }

  /**
   * Every product the filters match — not just the rows on screen, which stop
   * at the server's PAGE_LIMIT. Asked from the server at click time, so the
   * page never has to carry the whole delta just in case.
   */
  async function selectAll() {
    setOutcome(null);
    setConfirming(false);
    setError(null);
    setSelectingAll(true);
    try {
      // The LIVE URL's filters, like pushFilter: a debounced search may have
      // moved it since this render.
      const sp = new URLSearchParams(window.location.search);
      const src = sp.get("src");
      const res = await listPublishSkus({
        q: sp.get("q") ?? undefined,
        source: src === "goldensneakers" || src === "kicksdb" ? src : "all",
        showOnStore: sp.get("onStore") === "1",
      });
      if (res.ok) setSelected(new Set(res.skus));
      else setError(res.error);
    } finally {
      setSelectingAll(false);
    }
  }

  function clearSelection() {
    setOutcome(null);
    setConfirming(false);
    setSelected(new Set());
  }

  const runnable = React.useMemo(() => [...selected], [selected]);
  // Selected but not on screen: past the list's first rows, or filtered out
  // by a search typed after selecting. Said, so the count never surprises.
  const hiddenSelected = React.useMemo(() => {
    const shown = new Set(visible.map((c) => c.sku));
    return runnable.filter((sku) => !shown.has(sku)).length;
  }, [runnable, visible]);

  async function run(dryRun: boolean) {
    if (running.current) return;
    running.current = true;
    setError(null);
    setConfirming(false);
    setStopped(null);
    setStopping(false);
    setUnanswered(0);
    stopRef.current = false;
    const skus = runnable;
    const many = skus.length > FIRST_BATCH;
    setProgress(many ? { done: 0, total: skus.length, msLeft: null } : null);
    setBusy(true);
    if (!dryRun) setLiveRunning(true);
    let merged: PublishOutcome | null = null;
    let lost = 0;
    let proxyFailures = 0;
    let size = FIRST_BATCH;
    let pace: number | null = null; // ms per product, smoothed
    try {
      for (let i = 0; i < skus.length; ) {
        if (stopRef.current) {
          setStopped({ done: i, total: skus.length });
          break;
        }
        const batch = skus.slice(i, i + size);
        if (many) {
          setProgress({ done: i, total: skus.length, msLeft: pace == null ? null : (skus.length - i) * pace });
        }
        const started = performance.now();
        let res: PublishActionResult;
        try {
          res = await publishBatch({
            skus: batch,
            dryRun,
            includeGallery,
            force,
            replaceMedia,
          });
        } catch (e) {
          if (!(e instanceof UnexpectedResponse) || !PROXY_GAVE_UP.has(e.status)) throw e;
          // The proxy stopped waiting, not the server: this batch is most
          // likely being finished there right now. Its products stay selected
          // — publishing them again later is safe: the ones created by then
          // are skipped, and the server refuses any it is still creating — and
          // the run moves on to the next batch.
          lost += batch.length;
          setUnanswered(lost);
          if (++proxyFailures >= MAX_PROXY_FAILURES) {
            setError(t.publish.proxyGaveUp(e.status, MAX_PROXY_FAILURES));
            break;
          }
          // The time the proxy waited counts as this batch's pace: the next
          // one comes out smaller.
          pace = nextPace(pace, performance.now() - started, batch.length);
          size = nextBatchSize(size, pace);
          i += batch.length;
          continue;
        }
        proxyFailures = 0;
        pace = nextPace(pace, performance.now() - started, batch.length);
        size = nextBatchSize(size, pace);
        i += batch.length;
        if (!res.ok || !res.outcome) {
          setError(res.error ?? t.publish.failed);
          break;
        }
        merged = merged ? mergeOutcomes(merged, res.outcome) : res.outcome;
        setOutcome(merged);
      }
    } catch (e) {
      setError(
        e instanceof UnexpectedResponse
          ? t.publish.unexpectedResponse(e.status)
          : e instanceof Error
            ? e.message
            : t.publish.failed,
      );
    } finally {
      running.current = false;
      setProgress(null);
      setStopping(false);
      setLiveRunning(false);
      setBusy(false);
    }
    // A live run changed the store: re-read the delta so published products
    // leave the list instead of lingering as phantom candidates. Only what
    // actually ran is unticked — a run that was stopped leaves the rest
    // selected, and clearing it would silently drop work the operator asked for.
    if (!dryRun && merged && mounted.current) {
      const ran = new Set(merged.products.map((p) => p.sku));
      setSelected((prev) => new Set([...prev].filter((sku) => !ran.has(sku))));
      router.refresh();
      void mutate("/api/dock"); // the dock's "to publish" count, now
    }
  }

  const runningLabel = progress
    ? progress.msLeft == null
      ? t.publish.progress(progress.done, progress.total)
      : `${t.publish.progress(progress.done, progress.total)} · ${t.publish.timeLeft(Math.round(progress.msLeft / 60_000))}`
    : t.publish.running;

  // A dry run of exactly what will run: publishing then needs no confirmation
  // (it was just reviewed), and force reimport is armed only by it.
  const dryRunSeen =
    outcome?.dryRun === true &&
    outcome.products.length === runnable.length &&
    outcome.products.every((p) => selected.has(p.sku));

  function publish() {
    if (dryRunSeen) void run(false);
    else setConfirming(true);
  }

  // Leaving the page stops the run after the batch in flight (see below), so
  // a live run warns first: closing the tab…
  React.useEffect(() => {
    if (!liveRunning) return;
    const warn = (e: BeforeUnloadEvent) => {
      e.preventDefault();
      e.returnValue = "";
    };
    window.addEventListener("beforeunload", warn);
    return () => window.removeEventListener("beforeunload", warn);
  }, [liveRunning]);

  // …and following a link inside the Hub (the dock, a card). Captured on the
  // document, ahead of the router's own click handling, so "stay" can still
  // cancel the click. The loop is told to stop right away rather than when
  // the page unmounts: no batch may start once leaving has been decided.
  React.useEffect(() => {
    if (!busy) return;
    const onClick = (e: MouseEvent) => {
      if (e.button !== 0 || e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) return;
      const link = (e.target as Element | null)?.closest?.("a[href]");
      if (!(link instanceof HTMLAnchorElement) || link.target === "_blank") return;
      const url = new URL(link.href, window.location.href);
      if (url.origin !== window.location.origin || url.pathname === window.location.pathname) return;
      if (liveRunning && !window.confirm(t.publish.leaveWarning)) {
        e.preventDefault();
        e.stopPropagation();
        return;
      }
      // The batch in flight completes on the server; nothing after it starts.
      stopRef.current = true;
    };
    document.addEventListener("click", onClick, true);
    return () => document.removeEventListener("click", onClick, true);
  }, [busy, liveRunning, t]);

  // Gone from the page = no one watching the run: it stops after the batch in
  // flight rather than carry on unseen, where a second run started on coming
  // back could race it to the same SKUs.
  const mounted = React.useRef(true);
  React.useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
      stopRef.current = true;
    };
  }, []);

  if (!wooConfigured) {
    return (
      <div className="rounded-xl border border-line bg-surface p-8 text-center text-sm text-muted">
        {t.publish.notConfigured}
      </div>
    );
  }

  return (
    <div className="space-y-4">
      {!hasSnapshot && (
        <div className="rounded-xl border border-skip/40 bg-skip/8 px-4 py-3 text-sm text-skip">
          {t.publish.noSnapshot}
        </div>
      )}

      {/* Delta summary + source lens */}
      <div className="flex flex-wrap items-center gap-2 rounded-xl border border-line bg-surface px-4 py-3">
        <span className="text-sm font-semibold">{t.publish.deltaTitle(counts.missing)}</span>
        {/* A lens over the sources this shop actually has: a single-source
            catalog gets no "StockX (0)" tab to filter by. */}
        {mixedSources && (
          <div className="flex items-center gap-1 rounded-lg border border-line bg-surface-2 p-0.5">
            {(["all", "goldensneakers", "kicksdb"] as const).map((key) => (
              <button
                key={key}
                type="button"
                onClick={() => {
                  clearSelection();
                  pushFilter({ src: key === "all" ? undefined : key });
                }}
                className={`rounded-md px-2.5 py-1 text-[11px] font-semibold transition-colors ${
                  source === key ? "bg-accent text-accent-fg shadow-xs" : "text-muted hover:text-ink"
                }`}
              >
                {t.publish.sourceTabs[key]} ({counts[key]})
              </button>
            ))}
          </div>
        )}
        <Input
          aria-label={t.publish.searchPlaceholder}
          placeholder={t.publish.searchPlaceholder}
          className="h-8 w-56 text-xs"
          value={term}
          onChange={(e) => {
            setTerm(e.target.value);
            pushFilterDebounced({ q: e.target.value.trim() || undefined });
          }}
        />
        {/* Force reimport needs something to point at: the products it acts on
            are by definition the ones already on the store. */}
        <label className="flex cursor-pointer items-center gap-2 text-xs font-medium text-muted" title={t.publish.showOnStoreHint}>
          <Checkbox
            checked={showOnStore}
            onCheckedChange={(c) => {
              clearSelection();
              pushFilter({ onStore: c === true ? "1" : undefined });
            }}
            aria-label={t.publish.showOnStore}
          />
          {t.publish.showOnStore}
        </label>
        <div className="ml-auto flex items-center gap-2">
          <Button type="button" variant="ghost" size="sm" onClick={() => void selectAll()} disabled={selectingAll || busy}>
            {selectingAll ? t.publish.selectingAll : t.publish.selectAll}
          </Button>
          <Button type="button" variant="ghost" size="sm" onClick={clearSelection}>
            {t.publish.clear}
          </Button>
        </div>
      </div>

      {/* Options + run controls */}
      <div className="space-y-3 rounded-xl border border-line bg-surface px-4 py-3">
        <div className="flex flex-wrap items-center gap-x-5 gap-y-2 text-xs">
          <label className="flex cursor-pointer items-center gap-2 font-medium text-muted" title={t.publish.galleryHint}>
            <Checkbox
              checked={includeGallery}
              onCheckedChange={(c) => setIncludeGallery(c === true)}
              aria-label={t.publish.gallery}
            />
            {t.publish.gallery}
          </label>
          <label
            className={`flex cursor-pointer items-center gap-2 font-medium ${force ? "text-skip" : "text-muted"}`}
            title={t.publish.forceHint}
          >
            <Checkbox
              checked={force}
              onCheckedChange={(c) => {
                setOutcome(null);
                setConfirming(false);
                setForce(c === true);
                if (c !== true) setReplaceMedia(false);
              }}
              aria-label={t.publish.force}
            />
            {t.publish.force}
          </label>
          {force && (
            <label className="flex cursor-pointer items-center gap-2 font-medium text-muted" title={t.publish.replaceMediaHint}>
              <Checkbox
                checked={replaceMedia}
                onCheckedChange={(c) => setReplaceMedia(c === true)}
                aria-label={t.publish.replaceMedia}
              />
              {t.publish.replaceMedia}
            </label>
          )}
        </div>

        {force && <p className="text-[11px] leading-snug text-skip">{t.publish.forceWarning}</p>}

        <div className="flex flex-wrap items-center gap-3">
          {busy ? (
            <>
              <span className="inline-flex items-center gap-2 text-sm font-medium tnum">
                <span
                  aria-hidden
                  className="spin h-3.5 w-3.5 rounded-full border-2 border-line-strong border-t-accent-strong"
                />
                {runningLabel}
              </span>
              <Button
                type="button"
                variant="outline"
                size="sm"
                onClick={() => {
                  stopRef.current = true;
                  setStopping(true);
                }}
                disabled={stopping}
              >
                {stopping ? t.publish.stopping : t.publish.stop}
              </Button>
              {liveRunning && <span className="text-[11px] text-faint">{t.publish.keepOpen}</span>}
            </>
          ) : (
            <>
              <Button
                type="button"
                variant="outline"
                onClick={() => void run(true)}
                disabled={runnable.length === 0}
              >
                {t.publish.dryRun(runnable.length)}
              </Button>
              <Button
                type="button"
                variant="accent"
                onClick={publish}
                disabled={runnable.length === 0 || (force && !dryRunSeen)}
                title={force && !dryRunSeen ? t.publish.forceDryRunFirst : undefined}
              >
                {t.publish.publishNow(runnable.length)}
              </Button>
              {force && !dryRunSeen && runnable.length > 0 && (
                <span className="text-[11px] text-faint">{t.publish.forceDryRunFirst}</span>
              )}
            </>
          )}
          {hiddenSelected > 0 && (
            <span className="text-[11px] text-muted">{t.publish.selectedHidden(hiddenSelected)}</span>
          )}
          {error && <span className="text-sm font-medium text-skip">{error}</span>}
        </div>

        {confirming && !busy && (
          <div className="flex flex-wrap items-center gap-3 rounded-lg border border-accent/40 bg-accent/8 px-3 py-2.5 animate-pop">
            <p className="min-w-0 flex-1 text-xs leading-relaxed text-ink">
              {t.publish.confirmNoDryRun(runnable.length)}
            </p>
            <div className="flex shrink-0 items-center gap-2">
              <Button type="button" variant="ghost" size="sm" onClick={() => setConfirming(false)}>
                {t.publish.cancel}
              </Button>
              <Button type="button" variant="accent" size="sm" onClick={() => void run(false)}>
                {t.publish.confirmPublish(runnable.length)}
              </Button>
            </div>
          </div>
        )}

        {stopped && (
          <p className="text-[11px] font-medium text-warn">
            {t.publish.stoppedAt(stopped.done, stopped.total)}
          </p>
        )}
        {unanswered > 0 && (
          <p className="text-[11px] leading-snug font-medium text-warn">{t.publish.unanswered(unanswered)}</p>
        )}
      </div>

      {media && <MediaQueuePanel initial={media} worker={mediaWorker} siteUrl={siteUrl} />}

      {outcome && <OutcomePanel outcome={outcome} siteUrl={siteUrl} />}

      {/* The non-destructive repair: for products the store already carries. */}
      <RepairPanel />

      {/* Candidate list — one server-resolved page of it. */}
      {candidates.length === 0 ? (
        <div className="rounded-xl border border-line bg-surface p-8 text-center text-sm text-muted">
          {/* Nothing left to publish is a different answer from nothing
              matching what you typed, and only one of them is good news. */}
          {counts.total === 0 ? t.publish.empty : t.publish.noMatches}
        </div>
      ) : (
        <ul className="space-y-1.5">
          {visible.map((c) => (
            <li key={c.sku}>
              <label
                className={`flex cursor-pointer items-center gap-3 rounded-xl border px-3 py-2 transition-colors ${
                  selected.has(c.sku)
                    ? "border-accent/50 bg-accent/8"
                    : "border-line bg-surface hover:border-line/80"
                }`}
              >
                <Checkbox
                  checked={selected.has(c.sku)}
                  onCheckedChange={() => toggle(c.sku)}
                  aria-label={c.title || c.sku}
                />
                <div className="h-10 w-10 shrink-0 overflow-hidden rounded-md border border-line">
                  <CardImage src={c.image} alt={c.title || c.sku} />
                </div>
                <div className="min-w-0 flex-1">
                  <div className="truncate text-sm font-medium">{c.title || c.sku}</div>
                  <div className="flex flex-wrap items-center gap-1.5 text-[11px] text-faint">
                    <span className="font-mono">{c.sku}</span>
                    {c.brand && <span>· {c.brand}</span>}
                    {c.category && (
                      <span>
                        ·{" "}
                        {[c.category, c.secondaryCategory].filter(Boolean).join(" › ")}
                      </span>
                    )}
                  </div>
                </div>
                <div className="shrink-0 text-right text-[11px] text-muted tnum">
                  <div>{t.publish.sizes(c.variantCount)}</div>
                  {c.minAsk != null && <div className="text-faint">{t.publish.from(eur.format(c.minAsk))}</div>}
                </div>
                {mixedSources && (
                  <Badge variant={c.source === "goldensneakers" ? "create" : "update"}>
                    {c.source === "goldensneakers" ? "GS" : "StockX"}
                  </Badge>
                )}
                {c.sizeless && (
                  <Badge variant="warn" title={t.publish.sizelessHint}>
                    {t.publish.sizeless}
                  </Badge>
                )}
                {c.awaitingPhotos ? (
                  <Badge variant="warn" title={t.publish.awaitingPhotosHint}>
                    {t.publish.awaitingPhotos}
                  </Badge>
                ) : (
                  c.onStore && <Badge variant="skip">{t.publish.alreadyOnStore}</Badge>
                )}
              </label>
            </li>
          ))}
        </ul>
      )}
      {matched > candidates.length && (
        <p className="text-center text-[11px] text-faint">{t.publish.truncated(matched)}</p>
      )}
    </div>
  );
}

/**
 * Fold a batch's outcome into the running one: reports concatenate, counters
 * add up, and the audit id shown is the first batch's (each batch writes its
 * own audit row — the operator sees one list, the history keeps the detail).
 */
function mergeOutcomes(a: PublishOutcome, b: PublishOutcome): PublishOutcome {
  return {
    ...a,
    status: b.status === "failed" || a.status === "failed" ? "failed" : a.status,
    products: [...a.products, ...b.products],
    created: a.created + b.created,
    reimported: a.reimported + b.reimported,
    completed: a.completed + b.completed,
    variations: a.variations + b.variations,
    skipped: a.skipped + b.skipped,
    failed: a.failed + b.failed,
  };
}

/** What a run did (or would do), product by product. */
function OutcomePanel({ outcome, siteUrl }: { outcome: PublishOutcome; siteUrl: string }) {
  const { t } = useI18n();
  const created = outcome.products.filter((p) => p.action === "create");
  // The failure that started all this: a product created with no picture at
  // all. It was in the per-row detail and easy to miss; now it is a headline.
  const noImage = outcome.products.filter((p) => p.action !== "skip" && p.images === 0).length;
  const gtins = outcome.products.reduce((n, p) => n + p.gtins, 0);
  const rejectedGtins = outcome.products.reduce((n, p) => n + p.rejectedGtins.length, 0);
  const reimported = outcome.products.filter((p) => p.action === "reimport");
  const completed = outcome.products.filter((p) => p.action === "complete");
  const skipped = outcome.products.filter((p) => p.action === "skip");

  return (
    <div className="space-y-2 rounded-xl border border-line bg-surface px-4 py-3">
      <div className="flex flex-wrap items-center gap-2">
        <span className="text-sm font-semibold">
          {outcome.dryRun ? t.publish.dryRunTitle : t.publish.liveTitle}
        </span>
        {created.length > 0 && <Badge variant="create">{t.publish.willCreate(created.length)}</Badge>}
        {reimported.length > 0 && (
          <Badge variant="update">{t.publish.willReimport(reimported.length)}</Badge>
        )}
        {completed.length > 0 && (
          <Badge variant="warn" title={t.publish.sizelessHint}>
            {t.publish.willComplete(completed.length)}
          </Badge>
        )}
        {skipped.length > 0 && <Badge variant="skip">{t.publish.wasSkipped(skipped.length)}</Badge>}
        {!outcome.dryRun && (
          <span className="text-xs text-muted tnum">{t.publish.variationsCreated(outcome.variations)}</span>
        )}
        {outcome.failed > 0 && (
          <span className="text-xs font-semibold text-skip">{t.publish.failedCount(outcome.failed)}</span>
        )}
        {noImage > 0 && (
          <span className="text-xs font-semibold text-warn" title={t.publish.noImageHint}>
            {t.publish.noImage(noImage)}
          </span>
        )}
        {gtins > 0 && <span className="text-xs text-muted tnum">{t.publish.gtins(gtins)}</span>}
        {rejectedGtins > 0 && (
          <span className="text-xs font-medium text-warn" title={t.publish.rejectedGtinsHint}>
            {t.publish.rejectedGtins(rejectedGtins)}
          </span>
        )}
      </div>
      {!outcome.dryRun && created.length > 0 && (
        <p className="text-[11px] leading-snug text-muted">{t.publish.hiddenUntilPhoto}</p>
      )}
      {outcome.identitySkipped.length > 0 && (
        <p className="text-[11px] leading-snug text-warn">
          {t.publish.identitySkipped(outcome.identitySkipped.join(", "))}
        </p>
      )}
      {/* Bounded like the repair report: the counters above are the whole
          truth, the rows are a readable sample of it. */}
      <ul className="space-y-1">
        {outcome.products.slice(0, REPORT_LIMIT).map((p) => (
          <ReportRow key={p.sku} report={p} dryRun={outcome.dryRun} siteUrl={siteUrl} />
        ))}
      </ul>
      {outcome.products.length > REPORT_LIMIT && (
        <p className="text-[11px] text-faint">
          {t.publish.reportTruncated(outcome.products.length - REPORT_LIMIT)}
        </p>
      )}
    </div>
  );
}

function ReportRow({
  report,
  dryRun,
  siteUrl,
}: {
  report: PublishProductReport;
  dryRun: boolean;
  siteUrl: string;
}) {
  const { t } = useI18n();
  const href =
    report.permalink ??
    (report.storeProductId != null && siteUrl
      ? `${siteUrl.replace(/\/+$/, "")}/wp-admin/post.php?post=${report.storeProductId}&action=edit`
      : null);

  return (
    <li className="flex flex-wrap items-center gap-x-2 gap-y-0.5 border-t border-line/60 pt-1 text-[11px] first:border-0 first:pt-0">
      <span className="font-mono text-faint">{report.sku}</span>
      <span className="min-w-0 flex-1 truncate text-muted">{report.title}</span>
      {report.sizes.length > 0 && (
        <span className="text-faint tnum">{t.publish.sizes(report.sizes.length)}</span>
      )}
      {report.images > 0 && <span className="text-faint tnum">{t.publish.imageCount(report.images)}</span>}
      {report.unpricedSizes.length > 0 && (
        <span className="text-skip" title={report.unpricedSizes.join(", ")}>
          {t.publish.unpriced(report.unpricedSizes.length)}
        </span>
      )}
      {report.rejectedGtins.length > 0 && (
        <span
          className="text-warn"
          title={report.rejectedGtins.map((r) => `${r.sizeLabel}: ${r.value} (${r.reason})`).join("\n")}
        >
          {t.publish.rejectedGtins(report.rejectedGtins.length)}
        </span>
      )}
      {report.action === "complete" && <span className="text-warn">{t.publish.completeNote}</span>}
      {report.reason && <span className="text-faint">{t.publish.skipReasons[report.reason]}</span>}
      {report.error && <span className="font-medium text-skip">{report.error}</span>}
      {!dryRun && href && (
        <a
          href={href}
          target="_blank"
          rel="noreferrer"
          className="font-semibold text-accent-text underline-offset-2 hover:underline"
        >
          {t.publish.openOnStore} →
        </a>
      )}
    </li>
  );
}
