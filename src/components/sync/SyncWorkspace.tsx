"use client";

import * as React from "react";
import { useRouter } from "next/navigation";
import type { PlanItem } from "@core/core-spine";
import { previewFromStore, type PreviewResult, type FetchStats } from "@/server/actions/preview";
import {
  advanceStorePull,
  applySyncPrices,
  cancelStorePull,
  getSyncState,
  startStorePull,
  type SyncPageState,
} from "@/server/actions/sync";
import { setProductSaleRule, setVariationManualPrice } from "@/server/actions/overrides";
import type { PullProgress } from "@/server/woo/pull";
import type { ApplyOutcome, ApplyHistoryEntry } from "@/server/woo/apply";
import type { SnapshotInfo } from "@/server/store-json/repo";
import type { PreviewPlan } from "@/lib/plan";
import { emptySummary, isActionable, summarize } from "@/lib/plan";
import { useI18n } from "@/i18n/provider";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { ProductGroup } from "@/components/preview/ProductGroup";
import { NotFoundCard } from "@/components/preview/NotFoundCard";

const selKey = (planId: string, variantId: string) => `${planId}:${variantId}`;

const eur = new Intl.NumberFormat("it-IT", { style: "currency", currency: "EUR" });

/** Stable signature of the current selection — a dry run is only valid for it. */
function selectionSignature(selections: { planId: string; variantIds: string[] }[]): string {
  return selections
    .map((s) => `${s.planId}:${[...s.variantIds].sort().join(",")}`)
    .sort()
    .join("|");
}

export function SyncWorkspace({
  defaultMarket,
  snapshotInfo,
  initialState,
  seedSkus,
}: {
  defaultMarket: string;
  snapshotInfo: SnapshotInfo | null;
  initialState: SyncPageState;
  seedSkus: string[];
}) {
  const { t } = useI18n();
  const router = useRouter();

  // ----- pull -----
  const [pulling, setPulling] = React.useState(false);
  const [pullProgress, setPullProgress] = React.useState<PullProgress | null>(
    initialState.runningPull,
  );
  const [pullError, setPullError] = React.useState<string | null>(null);
  const cancelRef = React.useRef(false);

  // ----- preview -----
  const [pending, startTransition] = React.useTransition();
  const [error, setError] = React.useState<string | null>(null);
  const [plans, setPlans] = React.useState<PreviewPlan[]>([]);
  const [stats, setStats] = React.useState<FetchStats | null>(null);
  const [selected, setSelected] = React.useState<Set<string>>(new Set());
  const [allOpen, setAllOpen] = React.useState(false);
  const [scope, setScope] = React.useState<string[] | undefined>(
    seedSkus.length > 0 ? seedSkus : undefined,
  );

  // ----- apply -----
  const [history, setHistory] = React.useState<ApplyHistoryEntry[]>(initialState.history);
  const [dry, setDry] = React.useState<{ outcome: ApplyOutcome; signature: string } | null>(null);
  const [applied, setApplied] = React.useState<ApplyOutcome | null>(null);
  const [applyError, setApplyError] = React.useState<string | null>(null);
  const [applying, setApplying] = React.useState<"dry" | "live" | null>(null);

  const hasSnapshot = !!snapshotInfo;

  /** Drive a pull to completion by looping the advance action. */
  async function runPull(existingRunId?: string) {
    setPullError(null);
    setPulling(true);
    cancelRef.current = false;
    try {
      let runId = existingRunId;
      if (!runId) {
        const started = await startStorePull();
        if (!started.ok || !started.progress) {
          setPullError(started.error ?? t.sync.pull.failed);
          return;
        }
        runId = started.progress.runId;
        setPullProgress(started.progress);
        if (started.progress.done) return;
      }
      for (;;) {
        if (cancelRef.current) {
          await cancelStorePull({ runId });
          setPullProgress(null);
          return;
        }
        const res = await advanceStorePull({ runId, pages: 1 });
        if (!res.ok || !res.progress) {
          setPullError(res.error ?? t.sync.pull.failed);
          return;
        }
        setPullProgress(res.progress);
        if (res.progress.status === "failed") {
          setPullError(res.progress.error ?? t.sync.pull.failed);
          return;
        }
        if (res.progress.done) {
          // Snapshot replaced — reload server props (count/source/age) and re-preview.
          router.refresh();
          loadPreview(scope);
          return;
        }
      }
    } finally {
      setPulling(false);
    }
  }

  /** Apply a preview result to state, pre-selecting all actionable rows. */
  function applyResult(res: PreviewResult) {
    if (!res.ok) {
      setError(res.error ?? "Unknown error");
      setPlans([]);
      setStats(null);
      setSelected(new Set());
      return;
    }
    const next = new Set<string>();
    for (const p of res.plans) {
      for (const item of p.plan.items) {
        if (isActionable(item.action)) next.add(selKey(p.planId, item.stockxVariantId));
      }
    }
    setError(null);
    setStats(res.stats ?? null);
    setPlans(res.plans);
    setSelected(next);
    setAllOpen(res.plans.length <= 3);
    setDry(null);
    setApplied(null);
  }

  function loadPreview(skus?: string[]) {
    setError(null);
    startTransition(async () => applyResult(await previewFromStore(defaultMarket, skus)));
  }

  // A drawer "Sync to Woo" link seeds ?skus= — auto-preview that subset once.
  const seededOnce = React.useRef(false);
  React.useEffect(() => {
    if (seededOnce.current) return;
    seededOnce.current = true;
    if (seedSkus.length > 0 && hasSnapshot) loadPreview(seedSkus);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  function rerun() {
    loadPreview(scope);
  }

  function onSetSaleRule(sku: string, follow: boolean) {
    startTransition(async () => {
      const res = await setProductSaleRule({ sku, followSaleRule: follow });
      if (!res.ok) setError(res.error ?? t.drawer.saveFailed);
      else rerun();
    });
  }

  function onSetManualPrice(sku: string, euSize: string, price: number | null) {
    startTransition(async () => {
      const res = await setVariationManualPrice({ parentSku: sku, euSize, price });
      if (!res.ok) setError(res.error ?? t.drawer.saveFailed);
      else rerun();
    });
  }

  function toggle(planId: string, variantId: string, checked: boolean) {
    setSelected((prev) => {
      const next = new Set(prev);
      const k = selKey(planId, variantId);
      if (checked) next.add(k);
      else next.delete(k);
      return next;
    });
  }

  function toggleAll(p: PreviewPlan, checked: boolean) {
    setSelected((prev) => {
      const next = new Set(prev);
      for (const item of p.plan.items) {
        if (!isActionable(item.action)) continue;
        const k = selKey(p.planId, item.stockxVariantId);
        if (checked) next.add(k);
        else next.delete(k);
      }
      return next;
    });
  }

  function selectWhere(predicate: (p: PreviewPlan, item: PlanItem) => boolean) {
    const next = new Set<string>();
    for (const p of plans) {
      for (const item of p.plan.items) {
        if (isActionable(item.action) && predicate(p, item)) {
          next.add(selKey(p.planId, item.stockxVariantId));
        }
      }
    }
    setSelected(next);
  }

  const totals = plans.reduce((acc, p) => {
    const s = summarize(p.plan.items);
    acc.update += s.update;
    acc.create += s.create;
    acc.noop += s.noop;
    acc.skip += s.skip;
    return acc;
  }, emptySummary());

  const applySelections = plans
    .map((p) => ({
      planId: p.planId,
      variantIds: p.plan.items
        .filter(
          (i) => i.action === "update" && selected.has(selKey(p.planId, i.stockxVariantId)),
        )
        .map((i) => i.stockxVariantId),
    }))
    .filter((s) => s.variantIds.length > 0);
  const applyCount = applySelections.reduce((n, s) => n + s.variantIds.length, 0);
  const signature = selectionSignature(applySelections);
  const dryValid = dry != null && dry.signature === signature;

  async function refreshHistory() {
    const state = await getSyncState();
    setHistory(state.history);
  }

  function runDry() {
    if (applySelections.length === 0) return;
    setApplyError(null);
    setApplied(null);
    setApplying("dry");
    void (async () => {
      try {
        const res = await applySyncPrices({ selections: applySelections, dryRun: true });
        if (!res.ok || !res.outcome) setApplyError(res.error ?? t.sync.apply.failed);
        else setDry({ outcome: res.outcome, signature });
        await refreshHistory();
      } finally {
        setApplying(null);
      }
    })();
  }

  function runApply() {
    if (!dryValid || applySelections.length === 0) return;
    setApplyError(null);
    setApplying("live");
    void (async () => {
      try {
        const res = await applySyncPrices({ selections: applySelections, dryRun: false });
        if (!res.ok || !res.outcome) {
          setApplyError(res.error ?? t.sync.apply.failed);
          return;
        }
        setApplied(res.outcome);
        setDry(null);
        await refreshHistory();
        // Re-pull nothing — but recompute the preview so applied rows go noop.
        rerun();
      } finally {
        setApplying(null);
      }
    })();
  }

  const snapshotAge = snapshotInfo
    ? Math.floor((Date.now() - new Date(snapshotInfo.uploadedAt).getTime()) / 86_400_000)
    : null;

  return (
    <div className="space-y-5">
      {/* Store state / pull bar */}
      <div className="relative flex flex-wrap items-center gap-3 overflow-hidden rounded-xl border border-line bg-surface p-4 shadow-xs">
        <span className="absolute inset-y-0 left-0 w-1 bg-accent" />
        <div className="min-w-0 text-sm">
          <div className="font-semibold">{t.sync.pull.title}</div>
          {snapshotInfo ? (
            <div className="mt-0.5 flex flex-wrap items-center gap-x-2 text-xs text-muted">
              <span className="tnum">
                {t.sync.pull.info(
                  snapshotInfo.productCount,
                  new Date(snapshotInfo.uploadedAt).toLocaleString(),
                )}
              </span>
              <span className="rounded-full border border-line bg-surface-2 px-2 py-0.5 font-medium">
                {snapshotInfo.source === "rest" ? t.sync.pull.sourceRest : t.sync.pull.sourceUpload}
              </span>
              {snapshotAge != null && snapshotAge >= 7 && (
                <span className="font-medium text-warn">{t.storeBar.stale(snapshotAge)}</span>
              )}
            </div>
          ) : (
            <div className="mt-0.5 text-xs text-muted">{t.sync.pull.none}</div>
          )}
        </div>

        <div className="ml-auto flex flex-wrap items-center gap-2">
          {pulling || pullProgress?.status === "running" ? (
            <>
              <span className="flex items-center gap-2 text-xs text-muted tnum">
                <span className="spin h-4 w-4 rounded-full border-2 border-accent/30 border-t-accent" />
                {pullProgress
                  ? t.sync.pull.progress(pullProgress.productsFetched, pullProgress.totalProducts)
                  : t.sync.pull.pulling}
              </span>
              {pulling ? (
                <Button type="button" variant="outline" size="sm" onClick={() => (cancelRef.current = true)}>
                  {t.sync.pull.cancel}
                </Button>
              ) : (
                <Button type="button" variant="accent" size="sm" onClick={() => runPull(pullProgress!.runId)}>
                  {t.sync.pull.resume}
                </Button>
              )}
            </>
          ) : (
            <Button
              type="button"
              variant="accent"
              onClick={() => runPull()}
              disabled={!initialState.wooConfigured}
            >
              {t.sync.pull.button}
            </Button>
          )}
          {hasSnapshot && (
            <Button type="button" variant="outline" onClick={() => { setScope(undefined); loadPreview(); }} disabled={pending || pulling}>
              {pending ? t.sync.preview.loading : plans.length > 0 ? t.sync.preview.refresh : t.sync.preview.button}
            </Button>
          )}
        </div>

        {/* progress track */}
        {(pulling || pullProgress?.status === "running") && pullProgress?.totalProducts ? (
          <div className="h-1.5 w-full overflow-hidden rounded-full bg-surface-2">
            <div
              className="h-full rounded-full bg-accent transition-all"
              style={{
                width: `${Math.min(100, Math.round((pullProgress.productsFetched / pullProgress.totalProducts) * 100))}%`,
              }}
            />
          </div>
        ) : null}
      </div>

      {!initialState.wooConfigured && (
        <p className="rounded-lg border border-warn/25 bg-warn/10 px-4 py-3 text-sm text-warn">
          {t.sync.notConfigured}
        </p>
      )}

      {pullError && (
        <p className="rounded-lg border border-skip/25 bg-skip/10 px-4 py-3 text-sm text-skip">
          {pullError}
        </p>
      )}

      {scope && scope.length > 0 && (
        <div className="flex items-center gap-2 text-xs text-muted">
          <span className="rounded-full bg-accent/12 px-2.5 py-1 font-semibold text-accent-text tnum">
            {t.sync.preview.seeded(scope.length)}
          </span>
          <button
            type="button"
            className="font-medium underline-offset-2 hover:text-ink hover:underline"
            onClick={() => {
              setScope(undefined);
              loadPreview();
            }}
          >
            {t.sync.preview.clearSeed}
          </button>
        </div>
      )}

      {!hasSnapshot && (
        <p className="rounded-xl border border-line bg-surface p-8 text-center text-sm text-muted">
          {t.sync.preview.needSnapshot}
        </p>
      )}

      {error && (
        <p className="rounded-lg border border-skip/25 bg-skip/10 px-4 py-3 text-sm text-skip animate-fade-up">
          {error}
        </p>
      )}

      {stats?.notFound && stats.notFound.length > 0 && (
        <NotFoundCard foundSkus={plans.map((p) => p.sku)} notFound={stats.notFound} />
      )}

      {plans.length > 0 && (
        <div className="space-y-3">
          {/* Summary + quick select */}
          <div className="flex flex-wrap items-center gap-2 rounded-xl border border-line bg-surface px-4 py-3 text-sm shadow-xs">
            <span className="font-semibold tnum">{t.results.products(plans.length)}</span>
            <span className="text-line-strong">·</span>
            <Badge variant="update">{t.results.update(totals.update)}</Badge>
            <Badge variant="create">{t.results.create(totals.create)}</Badge>
            <Badge variant="skip">{t.results.skip(totals.skip)}</Badge>
            <Badge variant="noop">{t.results.noop(totals.noop)}</Badge>
            <span className="ml-1 inline-flex items-center gap-1.5 rounded-full bg-accent/12 px-2.5 py-0.5 text-xs font-semibold text-accent-text tnum">
              <span className="h-1.5 w-1.5 rounded-full bg-accent" />
              {t.results.selected(selected.size)}
            </span>
            <Button type="button" variant="ghost" size="sm" className="ml-auto" onClick={() => setAllOpen((o) => !o)}>
              {allOpen ? t.results.collapseAll : t.results.expandAll}
            </Button>
          </div>

          <div className="flex flex-wrap items-center gap-1.5 px-1 text-sm">
            <span className="mr-1 text-xs font-semibold uppercase tracking-wider text-faint">
              {t.results.quickSelect}
            </span>
            <Button type="button" variant="outline" size="sm" onClick={() => selectWhere((_, i) => i.action === "update")}>
              {t.results.updates(totals.update)}
            </Button>
            <Button type="button" variant="outline" size="sm" onClick={() => setSelected(new Set())}>
              {t.results.none}
            </Button>
          </div>

          <div className="space-y-3 stagger">
            {plans.map((p) => (
              <ProductGroup
                key={`${p.planId}-${allOpen}`}
                plan={p.plan}
                title={p.title}
                brand={p.brand}
                euSizes={p.euSizes}
                highlighted={false}
                defaultOpen={allOpen}
                selected={
                  new Set(
                    p.plan.items
                      .filter((i) => selected.has(selKey(p.planId, i.stockxVariantId)))
                      .map((i) => i.stockxVariantId),
                  )
                }
                onToggle={(variantId, checked) => toggle(p.planId, variantId, checked)}
                onToggleAll={(checked) => toggleAll(p, checked)}
                followSaleRule={p.followSaleRule}
                manualPrices={p.manualPrices}
                busy={pending}
                onSetSaleRule={(follow) => onSetSaleRule(p.sku, follow)}
                onSetManualPrice={(_variantId, euSize, price) => onSetManualPrice(p.sku, euSize, price)}
              />
            ))}
          </div>

          {/* Apply bar — dry-run first, live apply unlocked by a matching dry run */}
          <div className="sticky bottom-3 z-20 rounded-xl border border-line bg-surface/95 p-4 shadow-lg backdrop-blur-md">
            <div className="flex flex-wrap items-center gap-3">
              <div className="text-sm">
                <span className="font-semibold tnum">{t.sync.apply.ready(applyCount)}</span>
              </div>
              <div className="ml-auto flex items-center gap-2">
                <Button
                  type="button"
                  variant="outline"
                  onClick={runDry}
                  disabled={applyCount === 0 || applying != null}
                >
                  {applying === "dry" ? t.sync.apply.dryRunning : t.sync.apply.dryRun}
                </Button>
                <Button
                  type="button"
                  variant="accent"
                  onClick={runApply}
                  disabled={!dryValid || applyCount === 0 || applying != null}
                  title={dryValid ? undefined : t.sync.apply.needDryRun}
                >
                  {applying === "live" ? t.sync.apply.applying : t.sync.apply.apply(applyCount)}
                </Button>
              </div>
            </div>

            {applyError && <p className="mt-2 text-sm text-skip">{applyError}</p>}

            {dryValid && dry && (
              <div className="mt-3 space-y-1 border-t border-line pt-3 text-xs animate-fade-up">
                <div className="font-semibold">{t.sync.apply.dryTitle(dry.outcome.variations)}</div>
                <ul className="grid gap-x-6 gap-y-0.5 sm:grid-cols-2">
                  {dry.outcome.changes.slice(0, 12).map((c) => (
                    <li key={c.storeVariationId} className="flex items-center gap-2 tnum">
                      <span className="font-mono text-faint">{c.sku}</span>
                      <span>{c.sizeLabel}</span>
                      <span className="ml-auto text-muted">
                        {c.currentPrice != null ? eur.format(c.currentPrice) : "—"} →{" "}
                        <span className="font-semibold text-ink">{eur.format(c.newPrice)}</span>
                      </span>
                    </li>
                  ))}
                </ul>
                {dry.outcome.changes.length > 12 && (
                  <div className="text-faint">{t.sync.apply.dryMore(dry.outcome.changes.length - 12)}</div>
                )}
              </div>
            )}

            {applied && (
              <p className={`mt-2 text-sm font-medium ${applied.status === "applied" ? "text-up" : "text-skip"}`}>
                {applied.status === "applied"
                  ? t.sync.apply.applied(applied.updated)
                  : t.sync.apply.partial(applied.updated, applied.failed.length)}
              </p>
            )}
          </div>
        </div>
      )}

      {/* History */}
      <div className="rounded-xl border border-line bg-surface p-4 shadow-xs">
        <div className="text-sm font-semibold">{t.sync.history.title}</div>
        {history.length === 0 ? (
          <p className="mt-2 text-sm text-muted">{t.sync.history.empty}</p>
        ) : (
          <ul className="mt-2 divide-y divide-line/60 text-sm">
            {history.map((h) => (
              <li key={h.id} className="flex flex-wrap items-center gap-2 py-1.5">
                <span className="text-xs text-faint tnum">
                  {new Date(h.startedAt).toLocaleString()}
                </span>
                <span
                  className={`rounded-full px-2 py-0.5 text-[11px] font-semibold ${
                    h.dryRun ? "bg-surface-2 text-muted" : "bg-accent/12 text-accent-text"
                  }`}
                >
                  {h.dryRun ? t.sync.history.dry : t.sync.history.live}
                </span>
                <span className="text-xs font-medium text-muted">
                  {t.sync.history.status[h.status]}
                </span>
                <span className="ml-auto text-xs text-muted tnum">
                  {t.sync.history.line(h.updatedCount, h.requestedVariations ?? 0)}
                </span>
              </li>
            ))}
          </ul>
        )}
      </div>
    </div>
  );
}
