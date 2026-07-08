"use client";

import * as React from "react";
import type { PlanItem } from "@core/core-spine";
import {
  fetchAndPreview,
  previewFromStore,
  type PreviewInput,
  type PreviewResult,
  type FetchStats,
} from "@/server/actions/preview";
import { pingKicksDb } from "@/server/actions/health";
import { debugMatch, debugBulkPrices } from "@/server/actions/debug";
import { resetPricingToDefaults, updatePricing } from "@/server/actions/config";
import { setProductSaleRule, setVariationManualPrice } from "@/server/actions/overrides";
import type { PricingSummary, RoundingMode } from "@/server/config/summary";
import type { PreviewPlan } from "@/lib/plan";
import { emptySummary, isActionable, summarize } from "@/lib/plan";
import { parseSkus } from "@/lib/skus";
import { cn } from "@/lib/utils";
import { useI18n } from "@/i18n/provider";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { Badge } from "@/components/ui/badge";
import type { SnapshotInfo } from "@/server/store-json/repo";
import { ProductGroup } from "./ProductGroup";
import { ExportBar } from "./ExportBar";
import { StoreSnapshotPanel } from "./StoreSnapshotPanel";
import { SanitizePanel } from "./SanitizePanel";
import { NotFoundCard } from "./NotFoundCard";

type Mode = "skus" | "query";

/** How the current view was produced — so an override change replays it exactly. */
type LastRun = { kind: "store" } | { kind: "manual"; input: PreviewInput };

const selKey = (planId: string, variantId: string) => `${planId}:${variantId}`;

export function PreviewWorkspace({
  defaultMarket,
  snapshotInfo,
  pricing,
}: {
  defaultMarket: string;
  snapshotInfo: SnapshotInfo | null;
  pricing: PricingSummary;
}) {
  const { t } = useI18n();
  const [mode, setMode] = React.useState<Mode>("skus");
  const [skusText, setSkusText] = React.useState("");
  const [query, setQuery] = React.useState("");
  const [market, setMarket] = React.useState(defaultMarket);

  const [pending, startTransition] = React.useTransition();
  const [error, setError] = React.useState<string | null>(null);
  const [plans, setPlans] = React.useState<PreviewPlan[]>([]);
  const [stats, setStats] = React.useState<FetchStats | null>(null);
  const [selected, setSelected] = React.useState<Set<string>>(new Set());
  const [allOpen, setAllOpen] = React.useState(false);
  const [lastRun, setLastRun] = React.useState<LastRun>({ kind: "store" });

  const [ping, setPing] = React.useState<{ ok: boolean; message: string } | null>(null);
  const [pinging, startPing] = React.useTransition();
  const [hasSnapshot, setHasSnapshot] = React.useState(!!snapshotInfo);
  const [storeCount, setStoreCount] = React.useState(snapshotInfo?.productCount ?? 0);
  const [diag, setDiag] = React.useState<string | null>(null);
  const [diagPending, startDiag] = React.useTransition();
  const [price, setPrice] = React.useState<PricingSummary>(pricing);
  const [resetting, startReset] = React.useTransition();
  const [editing, setEditing] = React.useState(false);
  const [saving, startSave] = React.useTransition();

  // Draft fields for the pricing editor (strings so inputs stay controlled).
  const [dMarkup, setDMarkup] = React.useState("");
  const [dVat, setDVat] = React.useState("");
  const [dRounding, setDRounding] = React.useState<RoundingMode>("charm");
  const [dIncrement, setDIncrement] = React.useState("");
  const [dMinAsks, setDMinAsks] = React.useState("");

  function openEditor() {
    setDMarkup(String(price.markupPercent ?? 0));
    setDVat(String(price.vatRatePercent ?? 0));
    setDRounding(price.roundingMode ?? "charm");
    setDIncrement(price.increment != null ? String(price.increment) : "");
    setDMinAsks(String(price.minAsks ?? 0));
    setEditing(true);
  }

  function savePricing() {
    startSave(async () => {
      const res = await updatePricing({
        markupPercent: Number(dMarkup),
        vatRatePercent: Number(dVat),
        roundingMode: dRounding,
        increment: dIncrement.trim() === "" ? undefined : Number(dIncrement),
        minAsks: Number(dMinAsks),
      });
      if (!res.ok || !res.summary) {
        setError(res.error ?? t.pricing.saveFailed);
        return;
      }
      setPrice(res.summary);
      setEditing(false);
      if (hasSnapshot && plans.length > 0) loadFromStore(); // recompute with new pricing
    });
  }

  function onResetPricing() {
    startReset(async () => {
      const next = await resetPricingToDefaults();
      setPrice(next);
      setEditing(false);
      if (hasSnapshot && plans.length > 0) loadFromStore(); // recompute with new pricing
    });
  }

  function onDiagnose() {
    setDiag(null);
    startDiag(async () => {
      const res = await debugMatch();
      setDiag(res.ok ? (res.json ?? "") : `Error: ${res.error}`);
    });
  }

  function onBulkSample() {
    setDiag(null);
    startDiag(async () => {
      const res = await debugBulkPrices();
      setDiag(res.ok ? (res.json ?? "") : `Error: ${res.error}`);
    });
  }

  function onPing() {
    setPing(null);
    startPing(async () => setPing(await pingKicksDb()));
  }

  /** Apply a preview result to state. selectAll = pre-select all actionable rows. */
  function applyResult(res: PreviewResult, selectAll: boolean) {
    if (!res.ok) {
      setError(res.error ?? "Unknown error");
      setPlans([]);
      setStats(null);
      setSelected(new Set());
      return;
    }
    const next = new Set<string>();
    if (selectAll) {
      for (const p of res.plans) {
        for (const item of p.plan.items) {
          if (isActionable(item.action)) next.add(selKey(p.planId, item.stockxVariantId));
        }
      }
    }
    setError(null);
    setStats(res.stats ?? null);
    setPlans(res.plans);
    setSelected(next);
    setAllOpen(res.plans.length <= 3); // auto-expand only for small result sets
  }

  function onSubmit(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    const input: PreviewInput =
      mode === "skus"
        ? { mode, skus: parseSkus(skusText), market }
        : { mode, query: query.trim(), market };

    // SKU mode is an explicit list -> select all actionable. Query mode is
    // exploratory -> select nothing (operator picks granularly).
    setLastRun({ kind: "manual", input });
    startTransition(async () => applyResult(await fetchAndPreview(input), input.mode === "skus"));
  }

  /** Primary workflow: fetch StockX for every SKU in the uploaded store file. */
  function loadFromStore() {
    setError(null);
    setLastRun({ kind: "store" });
    startTransition(async () => applyResult(await previewFromStore(market), true));
  }

  /** Re-run whatever produced the current view (after an override change). */
  function rerun() {
    setError(null);
    startTransition(async () => {
      const res =
        lastRun.kind === "store"
          ? await previewFromStore(market)
          : await fetchAndPreview(lastRun.input);
      applyResult(res, lastRun.kind === "store" || lastRun.input.mode === "skus");
    });
  }

  /** Persist a product's sale-rule choice, then recompute so the diff reflects it. */
  function onSetSaleRule(sku: string, follow: boolean) {
    startTransition(async () => {
      const res = await setProductSaleRule({ sku, followSaleRule: follow });
      if (!res.ok) {
        setError(res.error ?? "Could not save override");
        return;
      }
      rerun();
    });
  }

  /** Persist (or clear) a variation's manual locked price, then recompute. */
  function onSetManualPrice(sku: string, euSize: string, price: number | null) {
    startTransition(async () => {
      const res = await setVariationManualPrice({ parentSku: sku, euSize, price });
      if (!res.ok) {
        setError(res.error ?? "Could not save override");
        return;
      }
      rerun();
    });
  }

  /** Rebuild the selection from a predicate over (plan, item). Quick-select. */
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

  const totals = plans.reduce((acc, p) => {
    const s = summarize(p.plan.items);
    acc.update += s.update;
    acc.create += s.create;
    acc.noop += s.noop;
    acc.skip += s.skip;
    return acc;
  }, emptySummary());
  const selectedCount = selected.size;

  // Build apply selections (only plans with selected variants) and the set of
  // plans whose selection includes a "create" row (candidates for M3 import).
  const applySelections = plans
    .map((p) => ({
      planId: p.planId,
      variantIds: p.plan.items
        .filter((i) => selected.has(selKey(p.planId, i.stockxVariantId)))
        .map((i) => i.stockxVariantId),
    }))
    .filter((s) => s.variantIds.length > 0);

  const priceChips: string[] = [
    price.markupPercent != null ? t.pricing.markup(price.markupPercent) : t.pricing.noMarkup,
    ...(price.vatRatePercent ? [t.pricing.vat(price.vatRatePercent)] : []),
    ...(price.roundingMode
      ? [t.pricing.rounding(t.pricing.roundingOptions[price.roundingMode], price.increment ?? null)]
      : []),
    ...(price.minAsks != null ? [t.pricing.minAsks(price.minAsks)] : []),
    price.hasGuardrail ? t.pricing.guardrailOn : t.pricing.guardrailOff,
  ];

  return (
    <div className="space-y-5">
      {/* Pricing rule bar */}
      <div className="rounded-xl border border-line bg-surface px-4 py-3 shadow-xs">
        <div className="flex flex-wrap items-center gap-2.5">
          <span className="grid h-8 w-8 place-items-center rounded-lg bg-accent/15 text-accent-text">
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" className="h-[17px] w-[17px]">
              <path d="M3 6h13M3 12h8M3 18h11" />
              <circle cx="19" cy="6" r="2" />
              <circle cx="15" cy="12" r="2" />
              <circle cx="18" cy="18" r="2" />
            </svg>
          </span>
          <span className="text-sm font-semibold">{t.pricing.title}</span>
          <div className="flex flex-wrap items-center gap-1.5">
            {priceChips.map((c) => (
              <span
                key={c}
                className="rounded-md border border-line bg-surface-2 px-2 py-0.5 text-xs font-medium text-muted"
              >
                {c}
              </span>
            ))}
          </div>
          <div className="ml-auto flex gap-1">
            <Button type="button" variant="ghost" size="sm" onClick={() => (editing ? setEditing(false) : openEditor())}>
              {editing ? t.pricing.cancel : t.pricing.edit}
            </Button>
            <Button type="button" variant="ghost" size="sm" onClick={onResetPricing} disabled={resetting}>
              {resetting ? t.pricing.resetting : t.pricing.reset}
            </Button>
          </div>
        </div>

        {editing && (
          <div className="mt-3 flex flex-wrap items-end gap-3 border-t border-line pt-3 animate-fade-up">
            <div className="space-y-1">
              <Label htmlFor="p-markup">{t.pricing.labelMarkup}</Label>
              <Input id="p-markup" className="w-24" value={dMarkup} onChange={(e) => setDMarkup(e.target.value)} inputMode="decimal" />
            </div>
            <div className="space-y-1">
              <Label htmlFor="p-vat">{t.pricing.labelVat}</Label>
              <Input id="p-vat" className="w-24" value={dVat} onChange={(e) => setDVat(e.target.value)} inputMode="decimal" />
            </div>
            <div className="space-y-1">
              <Label htmlFor="p-round">{t.pricing.labelRounding}</Label>
              <select
                id="p-round"
                value={dRounding}
                onChange={(e) => setDRounding(e.target.value as RoundingMode)}
                className="h-9 rounded-md border border-line bg-surface-2 px-2 text-sm text-ink focus-visible:border-accent/50 focus-visible:outline-none focus-visible:ring-4 focus-visible:ring-accent/15"
              >
                <option value="none">{t.pricing.roundingOptions.none}</option>
                <option value="integer">{t.pricing.roundingOptions.integer}</option>
                <option value="charm">{t.pricing.roundingOptions.charm}</option>
                <option value="nearest">{t.pricing.roundingOptions.nearest}</option>
              </select>
            </div>
            <div className="space-y-1">
              <Label htmlFor="p-inc">{t.pricing.labelIncrement}</Label>
              <Input id="p-inc" className="w-24" placeholder="0.99 / 5" value={dIncrement} onChange={(e) => setDIncrement(e.target.value)} inputMode="decimal" />
            </div>
            <div className="space-y-1">
              <Label htmlFor="p-min">{t.pricing.labelMinAsks}</Label>
              <Input id="p-min" className="w-20" value={dMinAsks} onChange={(e) => setDMinAsks(e.target.value)} inputMode="numeric" />
            </div>
            <Button type="button" onClick={savePricing} disabled={saving}>
              {saving ? t.pricing.saving : t.pricing.save}
            </Button>
          </div>
        )}
      </div>

      <StoreSnapshotPanel
        initialInfo={snapshotInfo}
        onLoaded={(info) => {
          setHasSnapshot(true);
          setStoreCount(info.productCount);
          loadFromStore(); // auto-fetch StockX for the whole file on upload
        }}
      />

      {hasSnapshot && (
        <div className="relative flex flex-wrap items-center gap-3 overflow-hidden rounded-xl border border-line bg-surface p-4 shadow-xs">
          <span className="absolute inset-y-0 left-0 w-1 bg-accent" />
          <div className="text-sm">
            <span className="font-semibold">{t.storeBar.title}</span>
            <span className="ml-2 text-muted">{t.storeBar.desc(storeCount)}</span>
          </div>
          <div className="ml-auto flex flex-wrap items-center gap-2">
            <Button type="button" variant="accent" onClick={loadFromStore} disabled={pending}>
              {pending ? (
                <>
                  <span className="spin h-4 w-4 rounded-full border-2 border-accent-fg/30 border-t-accent-fg" />
                  {t.storeBar.fetching}
                </>
              ) : plans.length > 0 ? (
                t.storeBar.refresh
              ) : (
                t.storeBar.fetch
              )}
            </Button>
            <Button type="button" variant="ghost" size="sm" onClick={onDiagnose} disabled={diagPending}>
              {diagPending ? "…" : t.storeBar.diagnose}
            </Button>
            <Button type="button" variant="ghost" size="sm" onClick={onBulkSample} disabled={diagPending}>
              {diagPending ? "…" : t.storeBar.testBulk}
            </Button>
          </div>
        </div>
      )}

      {hasSnapshot && <SanitizePanel />}

      {diag && (
        <pre className="max-h-96 overflow-auto rounded-lg border border-line bg-surface-2 p-3 font-mono text-xs text-muted">
          {diag}
        </pre>
      )}

      <details className="group rounded-xl border border-line bg-surface shadow-xs">
        <summary className="cursor-pointer list-none px-5 py-3 text-sm font-medium text-muted transition-colors hover:text-ink">
          <span className="inline-flex items-center gap-2">
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" className="h-3.5 w-3.5 text-faint transition-transform group-open:rotate-90">
              <path d="m9 18 6-6-6-6" />
            </svg>
            {t.search.summary}
          </span>
        </summary>
        <form onSubmit={onSubmit} className="space-y-4 border-t border-line p-5">
          <div className="inline-flex rounded-lg border border-line bg-surface-2 p-0.5 text-sm">
            {(["skus", "query"] as const).map((m) => (
              <button
                key={m}
                type="button"
                onClick={() => setMode(m)}
                className={cn(
                  "rounded-md px-3 py-1.5 font-medium transition-colors",
                  mode === m ? "bg-surface text-ink shadow-xs" : "text-muted hover:text-ink",
                )}
              >
                {m === "skus" ? t.search.bySkus : t.search.byQuery}
              </button>
            ))}
          </div>

          {mode === "skus" ? (
            <div className="space-y-1.5">
              <Label htmlFor="skus">{t.search.skusLabel}</Label>
              <Textarea
                id="skus"
                placeholder="CT8012-047, DZ5485-612"
                value={skusText}
                onChange={(e) => setSkusText(e.target.value)}
              />
            </div>
          ) : (
            <div className="space-y-1.5">
              <Label htmlFor="query">{t.search.queryLabel}</Label>
              <Input
                id="query"
                placeholder="Jordan 1 Bred Toe"
                value={query}
                onChange={(e) => setQuery(e.target.value)}
              />
            </div>
          )}

          <div className="flex items-end gap-3">
            <div className="space-y-1.5">
              <Label htmlFor="market">{t.search.market}</Label>
              <Input
                id="market"
                className="w-24"
                value={market}
                onChange={(e) => setMarket(e.target.value.toUpperCase())}
              />
            </div>
            <Button type="submit" disabled={pending}>
              {pending ? t.search.fetching : t.search.fetch}
            </Button>
            <Button type="button" variant="outline" onClick={onPing} disabled={pinging}>
              {pinging ? t.search.checking : t.search.testKicks}
            </Button>
          </div>

          {ping && (
            <p className={cn("text-sm", ping.ok ? "text-down" : "text-skip")}>{ping.message}</p>
          )}
        </form>
      </details>

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
          <div className="flex flex-wrap items-center gap-2 rounded-xl border border-line bg-surface px-4 py-3 text-sm shadow-xs">
            <span className="font-semibold tnum">{t.results.products(plans.length)}</span>
            <span className="text-line-strong">·</span>
            <Badge variant="update">{t.results.update(totals.update)}</Badge>
            <Badge variant="create">{t.results.create(totals.create)}</Badge>
            <Badge variant="skip">{t.results.skip(totals.skip)}</Badge>
            <Badge variant="noop">{t.results.noop(totals.noop)}</Badge>
            <span className="ml-1 inline-flex items-center gap-1.5 rounded-full bg-accent/12 px-2.5 py-0.5 text-xs font-semibold text-accent-text tnum">
              <span className="h-1.5 w-1.5 rounded-full bg-accent" />
              {t.results.selected(selectedCount)}
            </span>
            {stats && (
              <span className="ml-auto flex flex-wrap items-center gap-x-2 text-xs text-faint tnum">
                <span>{t.results.cacheStats(stats.fromCache, stats.fetched)}</span>
                {stats.catalog && (
                  <span className="text-accent-text">
                    {t.results.catalogStats(stats.catalog.total, stats.catalog.added)}
                  </span>
                )}
              </span>
            )}
            <Button type="button" variant="ghost" size="sm" onClick={() => setAllOpen((o) => !o)} className={stats ? "" : "ml-auto"}>
              {allOpen ? t.results.collapseAll : t.results.expandAll}
            </Button>
          </div>

          <div className="flex flex-wrap items-center gap-1.5 px-1 text-sm">
            <span className="mr-1 text-xs font-semibold uppercase tracking-wider text-faint">{t.results.quickSelect}</span>
            <Button type="button" variant="outline" size="sm" onClick={() => selectWhere(() => true)}>
              {t.results.all(totals.update + totals.create)}
            </Button>
            <Button type="button" variant="outline" size="sm" onClick={() => setSelected(new Set())}>
              {t.results.none}
            </Button>
            <Button type="button" variant="outline" size="sm" onClick={() => selectWhere((_, i) => i.action === "update")}>
              {t.results.updates(totals.update)}
            </Button>
            <Button type="button" variant="outline" size="sm" onClick={() => selectWhere((_, i) => i.action === "create")}>
              {t.results.new(totals.create)}
            </Button>
            {plans.some((p) => p.exactMatch) && (
              <Button type="button" variant="outline" size="sm" onClick={() => selectWhere((p) => p.exactMatch)}>
                {t.results.exactMatch}
              </Button>
            )}
          </div>

          <div className="space-y-3 stagger">
            {plans.map((p) => (
              <ProductGroup
                // Re-mount on allOpen change so expand/collapse-all propagates.
                key={`${p.planId}-${allOpen}`}
                plan={p.plan}
                title={p.title}
                brand={p.brand}
                euSizes={p.euSizes}
                highlighted={p.exactMatch}
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
                onSetSaleRule={hasSnapshot ? (follow) => onSetSaleRule(p.sku, follow) : undefined}
                onSetManualPrice={
                  hasSnapshot
                    ? (_variantId, euSize, price) => onSetManualPrice(p.sku, euSize, price)
                    : undefined
                }
              />
            ))}
          </div>

          <ExportBar selections={applySelections} />
        </div>
      )}
    </div>
  );
}
