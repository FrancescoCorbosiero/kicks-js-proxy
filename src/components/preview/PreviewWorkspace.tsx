"use client";

import * as React from "react";
import type { PlanItem } from "@core/core-spine";
import { fetchAndPreview, type PreviewInput, type FetchStats } from "@/server/actions/preview";
import { pingKicksDb } from "@/server/actions/health";
import type { PreviewPlan } from "@/lib/plan";
import { emptySummary, isActionable, summarize } from "@/lib/plan";
import { parseSkus } from "@/lib/skus";
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
}: {
  defaultMarket: string;
  snapshotInfo: SnapshotInfo | null;
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

  function onPing() {
    setPing(null);
    startPing(async () => setPing(await pingKicksDb()));
  }

  function onSubmit(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    const input: PreviewInput =
      mode === "skus"
        ? { mode, skus: parseSkus(skusText), market }
        : { mode, query: query.trim(), market };

    startTransition(async () => {
      const res = await fetchAndPreview(input);
      if (!res.ok) {
        setError(res.error ?? "Unknown error");
        setPlans([]);
        setStats(null);
        setSelected(new Set());
        return;
      }
      // SKU mode is an explicit list the operator typed -> default to all
      // actionable selected. Query mode is exploratory -> select nothing; the
      // operator picks granularly (or uses a quick-select preset).
      const next = new Set<string>();
      if (input.mode === "skus") {
        for (const p of res.plans) {
          for (const item of p.plan.items) {
            if (isActionable(item.action)) next.add(selKey(p.planId, item.stockxVariantId));
          }
        }
      }
      setStats(res.stats ?? null);
      setPlans(res.plans);
      setSelected(next);
      setAllOpen(res.plans.length <= 3); // auto-expand only for small result sets
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

  return (
    <div className="space-y-6">
      <StoreSnapshotPanel initialInfo={snapshotInfo} />
      <form onSubmit={onSubmit} className="space-y-4 rounded-xl border border-neutral-200 bg-white p-5 shadow-sm">
        <div className="inline-flex rounded-lg border border-neutral-200 p-0.5 text-sm">
          {(["skus", "query"] as const).map((m) => (
            <button
              key={m}
              type="button"
              onClick={() => setMode(m)}
              className={`rounded-md px-3 py-1.5 font-medium transition-colors ${
                mode === m ? "bg-neutral-900 text-white" : "text-neutral-600 hover:bg-neutral-100"
              }`}
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
          <p className={ping.ok ? "text-sm text-emerald-600" : "text-sm text-rose-600"}>{ping.message}</p>
        )}
        {error && <p className="text-sm text-rose-600">{error}</p>}
      </form>

      {stats?.notFound && stats.notFound.length > 0 && (
        <div className="rounded-lg border border-amber-200 bg-amber-50 px-4 py-3 text-sm text-amber-800">
          <span className="font-medium">Not found on StockX:</span> {stats.notFound.join(", ")}
        </div>
      )}

      {plans.length > 0 && (
        <div className="space-y-3">
          <div className="flex flex-wrap items-center gap-2 rounded-xl border border-neutral-200 bg-white px-4 py-3 text-sm shadow-sm">
            <span className="font-semibold">{plans.length} products</span>
            <span className="text-neutral-300">·</span>
            <Badge variant="update">{totals.update} update</Badge>
            <Badge variant="create">{totals.create} create</Badge>
            <Badge variant="skip">{totals.skip} skip</Badge>
            <Badge variant="noop">{totals.noop} noop</Badge>
            <span className="ml-1 text-neutral-500">{selectedCount} selected for apply</span>
            {stats && (
              <span className="ml-auto text-xs text-neutral-400">
                {stats.fromCache} cached · {stats.fetched} fetched live
              </span>
            )}
            <Button
              type="button"
              variant="ghost"
              size="sm"
              onClick={() => setAllOpen((o) => !o)}
              className="text-neutral-600"
            >
              {allOpen ? "Collapse all" : "Expand all"}
            </Button>
          </div>

          <div className="flex flex-wrap items-center gap-1.5 px-1 text-sm">
            <span className="mr-1 text-xs font-medium text-neutral-500">Quick select:</span>
            <Button type="button" variant="outline" size="sm" onClick={() => selectWhere(() => true)}>
              All ({totals.update + totals.create})
            </Button>
            <Button type="button" variant="outline" size="sm" onClick={() => setSelected(new Set())}>
              None
            </Button>
            <Button
              type="button"
              variant="outline"
              size="sm"
              onClick={() => selectWhere((_, i) => i.action === "update")}
            >
              Updates ({totals.update})
            </Button>
            <Button
              type="button"
              variant="outline"
              size="sm"
              onClick={() => selectWhere((_, i) => i.action === "create")}
            >
              New ({totals.create})
            </Button>
            {plans.some((p) => p.exactMatch) && (
              <Button
                type="button"
                variant="outline"
                size="sm"
                onClick={() => selectWhere((p) => p.exactMatch)}
              >
                Exact match
              </Button>
            )}
          </div>

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

          <ExportBar selections={applySelections} />
        </div>
      )}
    </div>
  );
}
