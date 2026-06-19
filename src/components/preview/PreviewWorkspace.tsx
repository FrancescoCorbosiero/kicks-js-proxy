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
import type { PricingSummary, RoundingMode } from "@/server/config/summary";
import type { PreviewPlan } from "@/lib/plan";
import { emptySummary, isActionable, summarize } from "@/lib/plan";
import { parseSkus } from "@/lib/skus";
import { cn } from "@/lib/utils";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { Badge } from "@/components/ui/badge";
import type { SnapshotInfo } from "@/server/store-json/repo";
import { ProductGroup } from "./ProductGroup";
import { ExportBar } from "./ExportBar";
import { StoreSnapshotPanel } from "./StoreSnapshotPanel";

type Mode = "skus" | "query";

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
        setError(res.error ?? "Could not save pricing");
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
    startTransition(async () => applyResult(await fetchAndPreview(input), input.mode === "skus"));
  }

  /** Primary workflow: fetch StockX for every SKU in the uploaded store file. */
  function loadFromStore() {
    setError(null);
    startTransition(async () => applyResult(await previewFromStore(market), true));
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
    price.markupPercent != null ? `+${price.markupPercent}% markup` : "no markup",
    ...(price.vatRatePercent ? [`${price.vatRatePercent}% VAT`] : []),
    ...(price.roundingMode
      ? [`round ${price.roundingMode}${price.increment != null ? ` ${price.increment}` : ""}`]
      : []),
    ...(price.minAsks != null ? [`minAsks ${price.minAsks}`] : []),
    price.hasGuardrail ? "delta guardrail on" : "no delta cap",
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
          <span className="text-sm font-semibold">Pricing</span>
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
              {editing ? "Cancel" : "Edit"}
            </Button>
            <Button type="button" variant="ghost" size="sm" onClick={onResetPricing} disabled={resetting}>
              {resetting ? "Resetting…" : "Reset"}
            </Button>
          </div>
        </div>

        {editing && (
          <div className="mt-3 flex flex-wrap items-end gap-3 border-t border-line pt-3 animate-fade-up">
            <div className="space-y-1">
              <Label htmlFor="p-markup">Markup %</Label>
              <Input id="p-markup" className="w-24" value={dMarkup} onChange={(e) => setDMarkup(e.target.value)} inputMode="decimal" />
            </div>
            <div className="space-y-1">
              <Label htmlFor="p-vat">VAT %</Label>
              <Input id="p-vat" className="w-24" value={dVat} onChange={(e) => setDVat(e.target.value)} inputMode="decimal" />
            </div>
            <div className="space-y-1">
              <Label htmlFor="p-round">Rounding</Label>
              <select
                id="p-round"
                value={dRounding}
                onChange={(e) => setDRounding(e.target.value as RoundingMode)}
                className="h-9 rounded-md border border-line bg-surface-2 px-2 text-sm text-ink focus-visible:border-accent/50 focus-visible:outline-none focus-visible:ring-4 focus-visible:ring-accent/15"
              >
                <option value="none">none</option>
                <option value="integer">integer</option>
                <option value="charm">charm (.99)</option>
                <option value="nearest">nearest</option>
              </select>
            </div>
            <div className="space-y-1">
              <Label htmlFor="p-inc">Increment</Label>
              <Input id="p-inc" className="w-24" placeholder="0.99 / 5" value={dIncrement} onChange={(e) => setDIncrement(e.target.value)} inputMode="decimal" />
            </div>
            <div className="space-y-1">
              <Label htmlFor="p-min">Min asks</Label>
              <Input id="p-min" className="w-20" value={dMinAsks} onChange={(e) => setDMinAsks(e.target.value)} inputMode="numeric" />
            </div>
            <Button type="button" onClick={savePricing} disabled={saving}>
              {saving ? "Saving…" : "Save & recompute"}
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
            <span className="font-semibold">Work on your store file</span>
            <span className="ml-2 text-muted">
              <span className="tnum">{storeCount}</span> products — fetch StockX prices and preview the repricing.
            </span>
          </div>
          <div className="ml-auto flex flex-wrap items-center gap-2">
            <Button type="button" variant="accent" onClick={loadFromStore} disabled={pending}>
              {pending ? (
                <>
                  <span className="spin h-4 w-4 rounded-full border-2 border-accent-fg/30 border-t-accent-fg" />
                  Fetching…
                </>
              ) : plans.length > 0 ? (
                "Refresh from file"
              ) : (
                "Fetch & preview"
              )}
            </Button>
            <Button type="button" variant="ghost" size="sm" onClick={onDiagnose} disabled={diagPending}>
              {diagPending ? "…" : "Diagnose matching"}
            </Button>
            <Button type="button" variant="ghost" size="sm" onClick={onBulkSample} disabled={diagPending}>
              {diagPending ? "…" : "Test bulk prices"}
            </Button>
          </div>
        </div>
      )}

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
            Or search manually (by SKU / query)
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
                {m === "skus" ? "By SKUs" : "By query"}
              </button>
            ))}
          </div>

          {mode === "skus" ? (
            <div className="space-y-1.5">
              <Label htmlFor="skus">StockX style codes (comma / space / newline separated)</Label>
              <Textarea
                id="skus"
                placeholder="CT8012-047, DZ5485-612"
                value={skusText}
                onChange={(e) => setSkusText(e.target.value)}
              />
            </div>
          ) : (
            <div className="space-y-1.5">
              <Label htmlFor="query">Search query</Label>
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
              <Label htmlFor="market">Market</Label>
              <Input
                id="market"
                className="w-24"
                value={market}
                onChange={(e) => setMarket(e.target.value.toUpperCase())}
              />
            </div>
            <Button type="submit" disabled={pending}>
              {pending ? "Fetching…" : "Fetch & preview"}
            </Button>
            <Button type="button" variant="outline" onClick={onPing} disabled={pinging}>
              {pinging ? "Checking…" : "Test KicksDB"}
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
        <div className="rounded-lg border border-warn/25 bg-warn/10 px-4 py-3 text-sm text-warn animate-fade-up">
          <span className="font-semibold">Not found on StockX:</span> {stats.notFound.join(", ")}
        </div>
      )}

      {plans.length > 0 && (
        <div className="space-y-3">
          <div className="flex flex-wrap items-center gap-2 rounded-xl border border-line bg-surface px-4 py-3 text-sm shadow-xs">
            <span className="font-semibold tnum">{plans.length} products</span>
            <span className="text-line-strong">·</span>
            <Badge variant="update">{totals.update} update</Badge>
            <Badge variant="create">{totals.create} create</Badge>
            <Badge variant="skip">{totals.skip} skip</Badge>
            <Badge variant="noop">{totals.noop} noop</Badge>
            <span className="ml-1 inline-flex items-center gap-1.5 rounded-full bg-accent/12 px-2.5 py-0.5 text-xs font-semibold text-accent-text">
              <span className="h-1.5 w-1.5 rounded-full bg-accent" />
              <span className="tnum">{selectedCount}</span> selected
            </span>
            {stats && (
              <span className="ml-auto text-xs text-faint tnum">
                {stats.fromCache} cached · {stats.fetched} fetched live
              </span>
            )}
            <Button type="button" variant="ghost" size="sm" onClick={() => setAllOpen((o) => !o)} className={stats ? "" : "ml-auto"}>
              {allOpen ? "Collapse all" : "Expand all"}
            </Button>
          </div>

          <div className="flex flex-wrap items-center gap-1.5 px-1 text-sm">
            <span className="mr-1 text-xs font-semibold uppercase tracking-wider text-faint">Quick select</span>
            <Button type="button" variant="outline" size="sm" onClick={() => selectWhere(() => true)}>
              All ({totals.update + totals.create})
            </Button>
            <Button type="button" variant="outline" size="sm" onClick={() => setSelected(new Set())}>
              None
            </Button>
            <Button type="button" variant="outline" size="sm" onClick={() => selectWhere((_, i) => i.action === "update")}>
              Updates ({totals.update})
            </Button>
            <Button type="button" variant="outline" size="sm" onClick={() => selectWhere((_, i) => i.action === "create")}>
              New ({totals.create})
            </Button>
            {plans.some((p) => p.exactMatch) && (
              <Button type="button" variant="outline" size="sm" onClick={() => selectWhere((p) => p.exactMatch)}>
                Exact match
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
              />
            ))}
          </div>

          <ExportBar selections={applySelections} />
        </div>
      )}
    </div>
  );
}
