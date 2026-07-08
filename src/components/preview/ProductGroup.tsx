"use client";

import * as React from "react";
import type { Plan, PlanItem } from "@core/core-spine";
import { isActionable, summarize } from "@/lib/plan";
import { cn } from "@/lib/utils";
import { useI18n } from "@/i18n/provider";
import { Badge } from "@/components/ui/badge";
import { Checkbox } from "@/components/ui/checkbox";
import { Input } from "@/components/ui/input";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";

function deltaInfo(item: PlanItem): { text: string; dir: "up" | "down" | "flat" } | null {
  if (item.currentPrice == null || item.proposedPrice == null || item.currentPrice === 0) return null;
  const d = ((item.proposedPrice - item.currentPrice) / item.currentPrice) * 100;
  const dir = Math.abs(d) < 0.05 ? "flat" : d > 0 ? "up" : "down";
  return { text: `${d >= 0 ? "+" : ""}${d.toFixed(1)}%`, dir };
}

function money(v: number | null, currency: string): string {
  return v == null ? "—" : `${v.toFixed(2)} ${currency}`;
}

function Delta({ item }: { item: PlanItem }) {
  const info = deltaInfo(item);
  if (!info) return <span className="text-faint">—</span>;
  if (info.dir === "flat") return <span className="tnum text-faint">{info.text}</span>;
  const up = info.dir === "up";
  return (
    <span className={cn("inline-flex items-center justify-end gap-0.5 tnum font-semibold", up ? "text-up" : "text-down")}>
      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.4" className="h-3 w-3">
        {up ? <path d="M12 19V5M6 11l6-6 6 6" /> : <path d="M12 5v14M6 13l6 6 6-6" />}
      </svg>
      {info.text}
    </span>
  );
}

function Chevron({ open }: { open: boolean }) {
  return (
    <svg
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      className={cn("h-4 w-4 shrink-0 text-faint transition-transform duration-200", open && "rotate-90")}
    >
      <path d="m9 18 6-6-6-6" />
    </svg>
  );
}

function avatarLabel(brand?: string, sku?: string): string {
  const src = (brand || sku || "?").trim();
  const parts = src.split(/\s+/).filter(Boolean);
  if (parts.length >= 2) return (parts[0][0] + parts[1][0]).toUpperCase();
  return src.slice(0, 2).toUpperCase();
}

interface Props {
  plan: Plan;
  title?: string;
  brand?: string;
  euSizes?: Record<string, string>;
  highlighted?: boolean;
  selected: Set<string>; // stockxVariantIds included for apply
  onToggle: (variantId: string, checked: boolean) => void;
  onToggleAll: (checked: boolean) => void;
  defaultOpen?: boolean;
  // operator overrides (persisted, applied on the next preview)
  followSaleRule?: boolean;
  manualPrices?: Record<string, number>; // stockxVariantId -> locked price
  busy?: boolean; // a preview is recomputing — freeze the controls
  onSetSaleRule?: (follow: boolean) => void;
  onSetManualPrice?: (variantId: string, euSize: string, price: number | null) => void;
}

/**
 * A compact per-variation manual-price control. Local draft state so typing never
 * triggers a recompute; commits on Enter/blur, clears on empty. Rendered only for
 * variations that exist on the store (a matched variation id + a known EU size).
 */
function ManualPriceCell({
  price,
  euSize,
  currency,
  busy,
  onCommit,
}: {
  price: number | undefined;
  euSize: string | undefined;
  currency: string;
  busy: boolean;
  onCommit: (euSize: string, price: number | null) => void;
}) {
  const { t } = useI18n();
  const [draft, setDraft] = React.useState(price != null ? String(price) : "");

  // Keep the draft in sync when the persisted value changes (e.g. after recompute).
  React.useEffect(() => setDraft(price != null ? String(price) : ""), [price]);

  if (!euSize) return <span className="text-faint">—</span>;

  function commit() {
    const trimmed = draft.trim();
    if (trimmed === "") {
      if (price != null) onCommit(euSize!, null); // cleared -> unlock
      return;
    }
    const n = Number.parseFloat(trimmed.replace(",", "."));
    if (Number.isNaN(n) || n <= 0) {
      setDraft(price != null ? String(price) : ""); // reject junk, restore
      return;
    }
    if (n !== price) onCommit(euSize!, n);
  }

  return (
    <div className="flex items-center justify-end gap-1">
      <Input
        aria-label={t.product.manualLock}
        value={draft}
        disabled={busy}
        onChange={(e) => setDraft(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === "Enter") (e.target as HTMLInputElement).blur();
        }}
        onBlur={commit}
        placeholder={t.product.manualPlaceholder}
        inputMode="decimal"
        className={cn("h-7 w-20 px-2 text-right text-xs tnum", price != null && "border-accent/60 text-accent-text")}
      />
      {price != null && (
        <button
          type="button"
          aria-label={t.product.manualClear}
          disabled={busy}
          onClick={() => onCommit(euSize, null)}
          className="grid h-5 w-5 shrink-0 place-items-center rounded text-faint transition-colors hover:text-skip disabled:opacity-40"
        >
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.4" className="h-3 w-3">
            <path d="M18 6 6 18M6 6l12 12" />
          </svg>
        </button>
      )}
      <span className="sr-only">{currency}</span>
    </div>
  );
}

export function ProductGroup({
  plan,
  title,
  brand,
  euSizes,
  highlighted = false,
  selected,
  onToggle,
  onToggleAll,
  defaultOpen = false,
  followSaleRule = true,
  manualPrices,
  busy = false,
  onSetSaleRule,
  onSetManualPrice,
}: Props) {
  const { t } = useI18n();
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
    <div
      className={cn(
        "overflow-hidden rounded-xl border bg-surface shadow-xs transition-shadow hover:shadow-sm",
        highlighted ? "border-accent/40 ring-1 ring-accent/30" : "border-line",
      )}
    >
      <div className="flex items-center gap-3 px-3 py-2.5">
        <button
          type="button"
          onClick={() => setOpen((o) => !o)}
          className="flex min-w-0 flex-1 items-center gap-2.5 text-left"
          aria-expanded={open}
        >
          <Chevron open={open} />
          <span className="grid h-9 w-9 shrink-0 place-items-center rounded-lg border border-line bg-surface-2 text-[11px] font-extrabold tracking-tight text-muted">
            {avatarLabel(brand, plan.sku)}
          </span>
          <div className="min-w-0">
            <div className="flex items-center gap-2 truncate text-sm font-semibold">
              {title || plan.sku || t.product.noSku}
              {highlighted && <Badge variant="accent">{t.product.exactMatch}</Badge>}
            </div>
            <div className="truncate text-xs text-faint">
              <span className="font-mono">{plan.sku}</span>
              {brand ? ` · ${brand}` : ""} · {t.product.variants(plan.items.length)} · {plan.currency}
            </div>
          </div>
        </button>
        <div className="flex shrink-0 items-center gap-1.5">
          {s.update > 0 && <Badge variant="update">{t.product.shortUpd(s.update)}</Badge>}
          {s.create > 0 && <Badge variant="create">{t.product.shortNew(s.create)}</Badge>}
          {s.skip > 0 && <Badge variant="skip">{t.product.shortSkip(s.skip)}</Badge>}
          {s.noop > 0 && <Badge variant="noop">{t.product.shortNoop(s.noop)}</Badge>}
          {actionable.length > 0 && (
            <span className="ml-1 hidden text-xs font-medium text-muted tnum sm:inline">
              {t.product.sel(selectedCount, actionable.length)}
            </span>
          )}
          {onSetSaleRule && (
            <label
              className="ml-1 hidden cursor-pointer items-center gap-1.5 rounded-md border border-line bg-surface-2 px-2 py-1 text-xs font-medium text-muted transition-colors hover:text-ink sm:flex"
              title={t.product.saleRuleHint}
            >
              <Checkbox
                checked={followSaleRule}
                disabled={busy}
                onCheckedChange={(c) => onSetSaleRule(c !== false)}
                aria-label={t.product.saleRule}
              />
              {t.product.saleRule}
            </label>
          )}
        </div>
      </div>

      {open && (
        <div className="border-t border-line">
          <Table>
            <TableHeader>
              <TableRow className="hover:bg-transparent">
                <TableHead className="w-8 pl-3">
                  <Checkbox
                    aria-label="Select all in product"
                    checked={headState}
                    disabled={actionable.length === 0}
                    onCheckedChange={(c) => onToggleAll(c === true)}
                  />
                </TableHead>
                <TableHead>{t.product.headerSize}</TableHead>
                <TableHead>{t.product.headerUpc}</TableHead>
                <TableHead className="text-right">{t.product.headerCurrent}</TableHead>
                <TableHead className="text-right">{t.product.headerProposed}</TableHead>
                <TableHead className="text-right">{t.product.headerDelta}</TableHead>
                {onSetManualPrice && <TableHead className="text-right">{t.product.headerManual}</TableHead>}
                <TableHead>{t.product.headerAction}</TableHead>
                <TableHead>{t.product.headerReason}</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {plan.items.map((item) => {
                const can = isActionable(item.action);
                const isSel = can && selected.has(item.stockxVariantId);
                return (
                  <TableRow
                    key={item.stockxVariantId}
                    className={cn(
                      !can && "opacity-55",
                      isSel && "bg-accent/[0.06] hover:bg-accent/[0.09]",
                    )}
                  >
                    <TableCell className="pl-3">
                      <Checkbox
                        aria-label={`Include ${item.sizeLabel}`}
                        disabled={!can}
                        checked={isSel}
                        onCheckedChange={(c) => onToggle(item.stockxVariantId, c === true)}
                      />
                    </TableCell>
                    <TableCell>
                      {euSizes?.[item.stockxVariantId] ? (
                        <span className="flex items-baseline gap-1.5">
                          <span className="font-semibold">{t.product.eu(euSizes[item.stockxVariantId])}</span>
                          <span className="text-xs text-faint">({item.sizeLabel})</span>
                        </span>
                      ) : (
                        <span className="font-semibold">{item.sizeLabel}</span>
                      )}
                    </TableCell>
                    <TableCell className="font-mono text-xs text-faint">{item.upc ?? "—"}</TableCell>
                    <TableCell className="text-right tnum text-muted">
                      {money(item.currentPrice, plan.currency)}
                    </TableCell>
                    <TableCell className="text-right font-semibold tnum">
                      {money(item.proposedPrice, plan.currency)}
                    </TableCell>
                    <TableCell className="text-right">
                      <Delta item={item} />
                    </TableCell>
                    {onSetManualPrice && (
                      <TableCell className="text-right">
                        {item.storeVariationId != null ? (
                          <ManualPriceCell
                            price={manualPrices?.[item.stockxVariantId]}
                            euSize={euSizes?.[item.stockxVariantId]}
                            currency={plan.currency}
                            busy={busy}
                            onCommit={(euSize, price) => onSetManualPrice(item.stockxVariantId, euSize, price)}
                          />
                        ) : (
                          <span className="text-faint">—</span>
                        )}
                      </TableCell>
                    )}
                    <TableCell>
                      <Badge variant={item.action}>{t.actions[item.action]}</Badge>
                    </TableCell>
                    <TableCell className="text-xs text-faint">{item.reason ?? ""}</TableCell>
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
