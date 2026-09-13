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
import { CardImage } from "@/components/catalog/CardImage";

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

type SourceFilter = "all" | "goldensneakers" | "kicksdb";

export function PublishWorkspace({
  candidates,
  hasSnapshot,
  wooConfigured,
  siteUrl,
}: {
  candidates: PublishTarget[];
  hasSnapshot: boolean;
  wooConfigured: boolean;
  siteUrl: string;
}) {
  const { t } = useI18n();
  const router = useRouter();

  const [selected, setSelected] = React.useState<Set<string>>(new Set());
  const [source, setSource] = React.useState<SourceFilter>("all");
  const [term, setTerm] = React.useState("");
  const [includeGallery, setIncludeGallery] = React.useState(false);
  const [force, setForce] = React.useState(false);
  const [replaceMedia, setReplaceMedia] = React.useState(false);
  const [showOnStore, setShowOnStore] = React.useState(false);
  const [busy, startRun] = React.useTransition();
  const [outcome, setOutcome] = React.useState<PublishOutcome | null>(null);
  const [progress, setProgress] = React.useState<{ done: number; total: number } | null>(null);
  const [error, setError] = React.useState<string | null>(null);

  const missing = React.useMemo(() => candidates.filter((c) => !c.onStore), [candidates]);

  const counts = React.useMemo(() => {
    const pool = showOnStore ? candidates : missing;
    let gs = 0;
    let kicks = 0;
    for (const c of pool) {
      if (c.source === "goldensneakers") gs += 1;
      else kicks += 1;
    }
    return { all: pool.length, goldensneakers: gs, kicksdb: kicks };
  }, [candidates, missing, showOnStore]);

  // Both sources represented? Everything provider-specific in this tab hangs
  // off this: on a single-source shop the labels are noise, not information.
  const mixedSources = counts.goldensneakers > 0 && counts.kicksdb > 0;

  const visible = React.useMemo(() => {
    const q = term.trim().toLowerCase();
    return (showOnStore ? candidates : missing).filter((c) => {
      // With the lens hidden the filter must not linger: a stale "kicksdb"
      // selection would empty the list with no control left to clear it.
      if (mixedSources && source === "goldensneakers" && c.source !== "goldensneakers") return false;
      if (mixedSources && source === "kicksdb" && c.source === "goldensneakers") return false;
      if (!q) return true;
      return (
        c.sku.toLowerCase().includes(q) ||
        c.title.toLowerCase().includes(q) ||
        c.brand.toLowerCase().includes(q)
      );
    });
  }, [candidates, missing, mixedSources, showOnStore, source, term]);

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
    // Everything visible, however many: a selection larger than one server
    // batch is split into BATCH_SIZE calls by run() below.
    setSelected(new Set(visible.map((c) => c.sku)));
  }

  function clearSelection() {
    setOutcome(null);
    setSelected(new Set());
  }

  /**
   * One publish call per BATCH_SIZE SKUs. The server action caps a batch at
   * 200 (and creating hundreds of products in a single request would outlive
   * the request anyway), so a whole-catalog selection runs as a sequence of
   * batches whose reports are merged into one outcome. A batch that fails
   * stops the run and keeps what already went through — the products created
   * so far are real, and hiding them would send the operator back to wp-admin.
   */
  const BATCH_SIZE = 25;

  function run(dryRun: boolean) {
    setError(null);
    const skus = [...selected];
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
      // leave the list instead of lingering as phantom candidates.
      if (!dryRun && merged) {
        setSelected(new Set());
        router.refresh();
      }
    });
  }

  const runningLabel = progress
    ? t.publish.progress(progress.done, progress.total)
    : t.publish.running;

  // The live button unlocks only after a dry run of the CURRENT selection.
  const dryRunSeen =
    outcome?.dryRun === true &&
    outcome.products.length === selected.size &&
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
        <span className="text-sm font-semibold">{t.publish.deltaTitle(missing.length)}</span>
        {/* A lens over the sources this shop actually has: a single-source
            catalog gets no "StockX (0)" tab to filter by. */}
        {mixedSources && (
          <div className="flex items-center gap-1 rounded-lg border border-line bg-surface-2 p-0.5">
            {(["all", "goldensneakers", "kicksdb"] as const).map((key) => (
              <button
                key={key}
                type="button"
                onClick={() => setSource(key)}
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
          onChange={(e) => setTerm(e.target.value)}
        />
        {/* Force reimport needs something to point at: the products it acts on
            are by definition the ones already on the store. */}
        <label className="flex cursor-pointer items-center gap-2 text-xs font-medium text-muted" title={t.publish.showOnStoreHint}>
          <Checkbox
            checked={showOnStore}
            onCheckedChange={(c) => {
              setShowOnStore(c === true);
              clearSelection();
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
            disabled={busy || selected.size === 0}
          >
            {busy ? runningLabel : t.publish.dryRun(selected.size)}
          </Button>
          <Button
            type="button"
            variant="accent"
            onClick={() => run(false)}
            disabled={busy || selected.size === 0 || !dryRunSeen}
            title={!dryRunSeen ? t.publish.dryRunFirst : undefined}
          >
            {busy ? runningLabel : t.publish.publishNow(selected.size)}
          </Button>
          {!dryRunSeen && selected.size > 0 && (
            <span className="text-[11px] text-faint">{t.publish.dryRunFirst}</span>
          )}
          {error && <span className="text-sm font-medium text-skip">{error}</span>}
        </div>
      </div>

      {outcome && <OutcomePanel outcome={outcome} siteUrl={siteUrl} />}

      {/* Candidate list */}
      {candidates.length === 0 ? (
        <div className="rounded-xl border border-line bg-surface p-8 text-center text-sm text-muted">
          {t.publish.empty}
        </div>
      ) : (
        <ul className="space-y-1.5">
          {visible.slice(0, 300).map((c) => (
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
      {visible.length > 300 && (
        <p className="text-center text-[11px] text-faint">{t.publish.truncated(visible.length)}</p>
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
      </div>
      <ul className="space-y-1">
        {outcome.products.map((p) => (
          <ReportRow key={p.sku} report={p} dryRun={outcome.dryRun} siteUrl={siteUrl} />
        ))}
      </ul>
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
