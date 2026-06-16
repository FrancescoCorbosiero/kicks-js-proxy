"use client";

import * as React from "react";
import { fetchAndPreview, type PreviewInput } from "@/server/actions/preview";
import type { PreviewPlan } from "@/lib/plan";
import { emptySummary, summarize } from "@/lib/plan";
import { parseSkus } from "@/lib/skus";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { Badge } from "@/components/ui/badge";
import { PreviewTable, isActionable } from "./PreviewTable";

type Mode = "skus" | "query";

const selKey = (planId: string, variantId: string) => `${planId}:${variantId}`;

export function PreviewWorkspace({ defaultMarket }: { defaultMarket: string }) {
  const [mode, setMode] = React.useState<Mode>("skus");
  const [skusText, setSkusText] = React.useState("");
  const [query, setQuery] = React.useState("");
  const [market, setMarket] = React.useState(defaultMarket);

  const [pending, startTransition] = React.useTransition();
  const [error, setError] = React.useState<string | null>(null);
  const [plans, setPlans] = React.useState<PreviewPlan[]>([]);
  const [selected, setSelected] = React.useState<Set<string>>(new Set());

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
        setSelected(new Set());
        return;
      }
      // Default selection: every actionable row included.
      const next = new Set<string>();
      for (const p of res.plans) {
        for (const item of p.plan.items) {
          if (isActionable(item.action)) next.add(selKey(p.planId, item.stockxVariantId));
        }
      }
      setPlans(res.plans);
      setSelected(next);
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

  // Overall summary across all plans (what the fetch produced).
  const totals = plans.reduce((acc, p) => {
    const s = summarize(p.plan.items);
    acc.update += s.update;
    acc.create += s.create;
    acc.noop += s.noop;
    acc.skip += s.skip;
    return acc;
  }, emptySummary());
  const selectedCount = selected.size;

  return (
    <div className="space-y-6">
      <form onSubmit={onSubmit} className="space-y-4 rounded-lg border border-neutral-200 p-4">
        <div className="flex gap-4">
          <label className="flex items-center gap-2 text-sm">
            <input
              type="radio"
              name="mode"
              checked={mode === "skus"}
              onChange={() => setMode("skus")}
            />
            By SKUs
          </label>
          <label className="flex items-center gap-2 text-sm">
            <input
              type="radio"
              name="mode"
              checked={mode === "query"}
              onChange={() => setMode("query")}
            />
            By query
          </label>
        </div>

        {mode === "skus" ? (
          <div className="space-y-1">
            <Label htmlFor="skus">StockX style codes (comma / space / newline separated)</Label>
            <Textarea
              id="skus"
              placeholder="CT8012-047, DZ5485-612"
              value={skusText}
              onChange={(e) => setSkusText(e.target.value)}
            />
          </div>
        ) : (
          <div className="space-y-1">
            <Label htmlFor="query">Search query</Label>
            <Input
              id="query"
              placeholder="Jordan 1 Bred Toe"
              value={query}
              onChange={(e) => setQuery(e.target.value)}
            />
          </div>
        )}

        <div className="flex items-end gap-4">
          <div className="space-y-1">
            <Label htmlFor="market">Market</Label>
            <Input
              id="market"
              className="w-28"
              value={market}
              onChange={(e) => setMarket(e.target.value.toUpperCase())}
            />
          </div>
          <Button type="submit" disabled={pending}>
            {pending ? "Fetching…" : "Fetch & preview"}
          </Button>
        </div>

        {error && <p className="text-sm text-rose-600">{error}</p>}
      </form>

      {plans.length > 0 && (
        <div className="space-y-4">
          <div className="flex flex-wrap items-center gap-2 text-sm">
            <span className="font-medium">Summary:</span>
            <Badge variant="update">{totals.update} update</Badge>
            <Badge variant="create">{totals.create} create</Badge>
            <Badge variant="skip">{totals.skip} skip</Badge>
            <Badge variant="noop">{totals.noop} noop</Badge>
            <span className="ml-2 text-neutral-500">{selectedCount} selected for apply</span>
          </div>

          {plans.map((p) => (
            <PreviewTable
              key={p.planId}
              plan={p.plan}
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
      )}
    </div>
  );
}
