"use client";

import type { Plan, PlanItem } from "@core/core-spine";
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

/** Only update/create rows can be applied; noop/skip are informational. */
export function isActionable(action: PlanItem["action"]): boolean {
  return action === "update" || action === "create";
}

function deltaPercent(item: PlanItem): string {
  if (item.currentPrice == null || item.proposedPrice == null || item.currentPrice === 0) return "—";
  const d = ((item.proposedPrice - item.currentPrice) / item.currentPrice) * 100;
  return `${d >= 0 ? "+" : ""}${d.toFixed(1)}%`;
}

function money(v: number | null, currency: string): string {
  return v == null ? "—" : `${v.toFixed(2)} ${currency}`;
}

interface Props {
  plan: Plan;
  selected: Set<string>; // stockxVariantIds included for apply
  onToggle: (variantId: string, checked: boolean) => void;
  onToggleAll: (checked: boolean) => void;
}

export function PreviewTable({ plan, selected, onToggle, onToggleAll }: Props) {
  const actionable = plan.items.filter((i) => isActionable(i.action));
  const selectedCount = actionable.filter((i) => selected.has(i.stockxVariantId)).length;
  const headState: boolean | "indeterminate" =
    actionable.length > 0 && selectedCount === actionable.length
      ? true
      : selectedCount === 0
        ? false
        : "indeterminate";

  return (
    <div className="rounded-lg border border-neutral-200">
      <div className="flex items-center justify-between border-b border-neutral-200 px-3 py-2">
        <div className="text-sm font-medium">
          {plan.sku || "(no SKU)"}{" "}
          <span className="font-normal text-neutral-500">· {plan.items.length} variants</span>
        </div>
        <div className="text-xs text-neutral-500">{plan.currency}</div>
      </div>
      <Table>
        <TableHeader>
          <TableRow>
            <TableHead className="w-8">
              <Checkbox
                aria-label="Select all"
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
                <TableCell className="font-mono text-xs text-neutral-500">{item.upc ?? "—"}</TableCell>
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
  );
}
