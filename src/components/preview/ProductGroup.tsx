"use client";

import * as React from "react";
import type { Plan, PlanItem } from "@core/core-spine";
import { isActionable, summarize } from "@/lib/plan";
import { Badge } from "@/components/ui/badge";
import { Checkbox } from "@/components/ui/checkbox";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";

function deltaPercent(item: PlanItem): string {
  if (item.currentPrice == null || item.proposedPrice == null || item.currentPrice === 0) return "—";
  const d = ((item.proposedPrice - item.currentPrice) / item.currentPrice) * 100;
  return `${d >= 0 ? "+" : ""}${d.toFixed(1)}%`;
}

function money(v: number | null, currency: string): string {
  return v == null ? "—" : `${v.toFixed(2)} ${currency}`;
}

function Chevron({ open }: { open: boolean }) {
  return (
    <svg
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      className={`h-4 w-4 shrink-0 text-neutral-400 transition-transform ${open ? "rotate-90" : ""}`}
    >
      <path d="m9 18 6-6-6-6" />
    </svg>
  );
}

interface Props {
  plan: Plan;
  title?: string;
  brand?: string;
  selected: Set<string>; // stockxVariantIds included for apply
  onToggle: (variantId: string, checked: boolean) => void;
  onToggleAll: (checked: boolean) => void;
  defaultOpen?: boolean;
}

export function ProductGroup({
  plan,
  title,
  brand,
  selected,
  onToggle,
  onToggleAll,
  defaultOpen = false,
}: Props) {
  const [open, setOpen] = React.useState(defaultOpen);
  const s = summarize(plan.items);
  const actionable = plan.items.filter((i) => isActionable(i.action));
  const selectedCount = actionable.filter((i) => selected.has(i.stockxVariantId)).length;
  const headState: boolean | "indeterminate" =
    actionable.length > 0 && selectedCount === actionable.length
      ? true
      : selectedCount === 0
        ? false
        : "indeterminate";

  return (
    <div className="overflow-hidden rounded-lg border border-neutral-200 bg-white">
      <div className="flex items-center gap-3 px-3 py-2.5">
        <button
          type="button"
          onClick={() => setOpen((o) => !o)}
          className="flex min-w-0 flex-1 items-center gap-2 text-left"
          aria-expanded={open}
        >
          <Chevron open={open} />
          <div className="min-w-0">
            <div className="truncate text-sm font-semibold">
              {title || plan.sku || "(no SKU)"}
            </div>
            <div className="truncate text-xs text-neutral-500">
              {plan.sku}
              {brand ? ` · ${brand}` : ""} · {plan.items.length} variants · {plan.currency}
            </div>
          </div>
        </button>
        <div className="flex shrink-0 items-center gap-1.5">
          {s.update > 0 && <Badge variant="update">{s.update} upd</Badge>}
          {s.create > 0 && <Badge variant="create">{s.create} new</Badge>}
          {s.skip > 0 && <Badge variant="skip">{s.skip} skip</Badge>}
          {s.noop > 0 && <Badge variant="noop">{s.noop} noop</Badge>}
          {actionable.length > 0 && (
            <span className="ml-1 text-xs text-neutral-500">
              {selectedCount}/{actionable.length} sel
            </span>
          )}
        </div>
      </div>

      {open && (
        <div className="border-t border-neutral-200">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead className="w-8">
                  <Checkbox
                    aria-label="Select all in product"
                    checked={headState}
                    disabled={actionable.length === 0}
                    onCheckedChange={(c) => onToggleAll(c === true)}
                  />
                </TableHead>
                <TableHead>Size</TableHead>
                <TableHead>UPC</TableHead>
                <TableHead className="text-right">Current</TableHead>
                <TableHead className="text-right">Proposed</TableHead>
                <TableHead className="text-right">Δ</TableHead>
                <TableHead>Action</TableHead>
                <TableHead>Reason</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {plan.items.map((item) => {
                const can = isActionable(item.action);
                return (
                  <TableRow key={item.stockxVariantId} className={can ? "" : "opacity-60"}>
                    <TableCell>
                      <Checkbox
                        aria-label={`Include ${item.sizeLabel}`}
                        disabled={!can}
                        checked={can && selected.has(item.stockxVariantId)}
                        onCheckedChange={(c) => onToggle(item.stockxVariantId, c === true)}
                      />
                    </TableCell>
                    <TableCell className="font-medium">{item.sizeLabel}</TableCell>
                    <TableCell className="font-mono text-xs text-neutral-500">
                      {item.upc ?? "—"}
                    </TableCell>
                    <TableCell className="text-right tabular-nums">
                      {money(item.currentPrice, plan.currency)}
                    </TableCell>
                    <TableCell className="text-right font-medium tabular-nums">
                      {money(item.proposedPrice, plan.currency)}
                    </TableCell>
                    <TableCell className="text-right tabular-nums text-neutral-500">
                      {deltaPercent(item)}
                    </TableCell>
                    <TableCell>
                      <Badge variant={item.action}>{item.action}</Badge>
                    </TableCell>
                    <TableCell className="text-xs text-neutral-500">{item.reason ?? ""}</TableCell>
                  </TableRow>
                );
              })}
            </TableBody>
          </Table>
        </div>
      )}
    </div>
  );
}
