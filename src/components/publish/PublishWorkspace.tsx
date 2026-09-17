"use client";

import * as React from "react";
import { useRouter } from "next/navigation";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Badge } from "@/components/ui/badge";
import { Checkbox } from "@/components/ui/checkbox";
import { useI18n } from "@/i18n/provider";
import { runPublish } from "@/server/actions/publish";
import type { PublishOutcome, PublishProductReport, PublishTarget } from "@/server/woo/publish";
import { hasMixedSources, type PublishCounts, type PublishSourceLens } from "@/lib/publish-page";
import { mergeQuery, type QueryParams } from "@/lib/qs";
import { CardImage } from "@/components/catalog/CardImage";
import { RepairPanel } from "./RepairPanel";

/**
 * Bounds, all for the same reason: everything below is rendered by the browser,
 * and the catalog has no ceiling. A shop with 4000 unpublished products must
 * cost the same in DOM nodes and in requests as a shop with 40. The list's own
 * bound lives on the server (PAGE_LIMIT) — the browser is never sent more.
 */
/**
 * SKUs one run may touch — the server action's own per-call cap. Publishing is
 * a create per product plus a call per size plus media, so this is already
 * thousands of writes against the live store; a click must never queue more.
 */
const RUN_LIMIT = 200;
/** SKUs per publish call: RUN_LIMIT split into requests the server survives. */
const BATCH_SIZE = 25;
/** Report rows rendered. The counters above them always cover the whole run. */
const REPORT_LIMIT = 60;

/**
 * The Publisher's workspace: the catalog→store delta, selectable, with a
 * mandatory dry run in front of the real write.
 *
 * The posture is deliberately more cautious than the sync tab's. Repricing is
 * reversible — write the old number back. Creating a product is not: an
 * accidental parent has to be hunted down in wp-admin. So nothing is selected
 * by default, the live run is armed only after a dry run has been seen, and
 * force reimport (which DELETES and recreates a live product's sizes) is a
 * separate, explicitly-labelled opt-in.
 */

const eur = new Intl.NumberFormat("it-IT", { style: "currency", currency: "EUR" });

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
}) {
  const { t } = useI18n();
  const router = useRouter();

  const [selected, setSelected] = React.useState<Set<string>>(new Set());
  const [includeGallery, setIncludeGallery] = React.useState(false);
  const [force, setForce] = React.useState(false);
  const [replaceMedia, setReplaceMedia] = React.useState(false);
  const [busy, startRun] = React.useTransition();
  const [, startFilter] = React.useTransition();
  const [outcome, setOutcome] = React.useState<PublishOutcome | null>(null);
  const [progress, setProgress] = React.useState<{ done: number; total: number } | null>(null);
  const [error, setError] = React.useState<string | null>(null);

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
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(sku)) next.delete(sku);
      else next.add(sku);
      return next;
    });
  }

  function selectAllVisible() {
    setOutcome(null);
    // The rows on screen, and no more. Selecting the whole filtered set while
    // only a page of it was rendered handed a single click a catalog-sized
    // run: on a 4000-product shop that was 160 back-to-back publish calls,
    // each one creating products on the live store, and a report the browser
    // had to keep growing in the DOM until the tab died.
    setSelected(new Set(visible.slice(0, RUN_LIMIT).map((c) => c.sku)));
  }

  function clearSelection() {
    setOutcome(null);
    setSelected(new Set());
  }

  /**
   * What a click will actually touch: the selection, bounded. Anything past
   * RUN_LIMIT stays ticked and goes in the next run — better a second click
   * than a browser tab issuing unbounded write calls at the store until one
   * of them times out.
   */
  const runnable = React.useMemo(() => [...selected].slice(0, RUN_LIMIT), [selected]);
  const heldBack = selected.size - runnable.length;

  function run(dryRun: boolean) {
    setError(null);
    const skus = runnable;
    setProgress(skus.length > BATCH_SIZE ? { done: 0, total: skus.length } : null);
    startRun(async () => {
      let merged: PublishOutcome | null = null;
      for (let i = 0; i < skus.length; i += BATCH_SIZE) {
        const batch = skus.slice(i, i + BATCH_SIZE);
        const res = await runPublish({
          skus: batch,
          dryRun,
          includeGallery,
          force,
          replaceMedia,
        });
        if (!res.ok || !res.outcome) {
          setError(res.error ?? t.publish.failed);
          break;
        }
        merged = merged ? mergeOutcomes(merged, res.outcome) : res.outcome;
        setOutcome(merged);
        if (skus.length > BATCH_SIZE) {
          setProgress({ done: Math.min(i + BATCH_SIZE, skus.length), total: skus.length });
        }
      }
      setProgress(null);
      // A live run changed the store: re-read the delta so published products
      // leave the list instead of lingering as phantom candidates. Only what
      // actually ran is unticked — a selection held back by RUN_LIMIT is still
      // waiting, and clearing it would silently drop work the operator asked for.
      if (!dryRun && merged) {
        const ran = new Set(merged.products.map((p) => p.sku));
        setSelected((prev) => new Set([...prev].filter((sku) => !ran.has(sku))));
        router.refresh();
      }
    });
  }

  const runningLabel = progress
    ? t.publish.progress(progress.done, progress.total)
    : t.publish.running;

  // The live button unlocks only after a dry run of exactly what will run.
  const dryRunSeen =
    outcome?.dryRun === true &&
    outcome.products.length === runnable.length &&
    outcome.products.every((p) => selected.has(p.sku));

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
          <Button type="button" variant="ghost" size="sm" onClick={selectAllVisible}>
            {t.publish.selectAll}
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
          <Button
            type="button"
            variant="outline"
            onClick={() => run(true)}
            disabled={busy || runnable.length === 0}
          >
            {busy ? runningLabel : t.publish.dryRun(runnable.length)}
          </Button>
          <Button
            type="button"
            variant="accent"
            onClick={() => run(false)}
            disabled={busy || runnable.length === 0 || !dryRunSeen}
            title={!dryRunSeen ? t.publish.dryRunFirst : undefined}
          >
            {busy ? runningLabel : t.publish.publishNow(runnable.length)}
          </Button>
          {!dryRunSeen && runnable.length > 0 && (
            <span className="text-[11px] text-faint">{t.publish.dryRunFirst}</span>
          )}
          {heldBack > 0 && (
            <span className="text-[11px] font-medium text-warn">
              {t.publish.runCapped(RUN_LIMIT, heldBack)}
            </span>
          )}
          {error && <span className="text-sm font-medium text-skip">{error}</span>}
        </div>
      </div>

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
                {c.onStore && <Badge variant="skip">{t.publish.alreadyOnStore}</Badge>}
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
