"use client";

import * as React from "react";
import { resetPricingToDefaults, updatePricing } from "@/server/actions/config";
import { setGlobalSaleRule } from "@/server/actions/overrides";
import type { PricingSummary, RoundingMode } from "@/server/config/summary";
import { cn } from "@/lib/utils";
import { useI18n } from "@/i18n/provider";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Checkbox } from "@/components/ui/checkbox";

/**
 * The shared pricing bar: shows the live rule (banded or flat markup, VAT,
 * rounding, minAsks, guardrail), the store-wide "reprice discounted" switch,
 * and the inline editor + reset. Used by both the Sync tab and the hidden
 * file-flow preview; `onChanged` fires after any persisted change so the host
 * can recompute its plan.
 */
export function PricingBar({
  initial,
  initialFollowSaleRule,
  busy = false,
  onChanged,
}: {
  initial: PricingSummary;
  initialFollowSaleRule: boolean;
  busy?: boolean;
  onChanged?: () => void;
}) {
  const { t } = useI18n();
  const [price, setPrice] = React.useState<PricingSummary>(initial);
  const [followSaleRule, setFollowSaleRule] = React.useState(initialFollowSaleRule);
  const [error, setError] = React.useState<string | null>(null);
  const [editing, setEditing] = React.useState(false);
  const [saving, startSave] = React.useTransition();
  const [resetting, startReset] = React.useTransition();
  const [savingRule, startRule] = React.useTransition();

  // Draft fields for the editor (strings so inputs stay controlled).
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
    setError(null);
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
      onChanged?.();
    });
  }

  function onResetPricing() {
    setError(null);
    startReset(async () => {
      const next = await resetPricingToDefaults();
      setPrice(next);
      setEditing(false);
      onChanged?.();
    });
  }

  /** Bulk switch: preserve (default) vs reprice discounted items across all products. */
  function onToggleGlobalSaleRule(follow: boolean) {
    setError(null);
    setFollowSaleRule(follow);
    startRule(async () => {
      const res = await setGlobalSaleRule({ followSaleRule: follow });
      if (!res.ok) {
        setError(res.error ?? t.pricing.saveFailed);
        setFollowSaleRule(!follow); // roll the optimistic flip back
        return;
      }
      onChanged?.();
    });
  }

  const pending = busy || saving || resetting || savingRule;

  const chips: string[] = [
    ...(price.markupBands?.length
      ? price.markupBands.map((b) =>
          b.upTo != null ? t.pricing.bandUpTo(b.upTo, b.percent) : t.pricing.bandAbove(b.percent),
        )
      : [price.markupPercent != null ? t.pricing.markup(price.markupPercent) : t.pricing.noMarkup]),
    ...(price.vatRatePercent ? [t.pricing.vat(price.vatRatePercent)] : []),
    ...(price.roundingMode
      ? [t.pricing.rounding(t.pricing.roundingOptions[price.roundingMode], price.increment ?? null)]
      : []),
    ...(price.minAsks != null ? [t.pricing.minAsks(price.minAsks)] : []),
    price.hasGuardrail ? t.pricing.guardrailOn : t.pricing.guardrailOff,
  ];

  return (
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
        {price.markupBands?.length ? (
          <span
            className="rounded-full bg-accent/12 px-2 py-0.5 text-[11px] font-semibold text-accent-text"
            title={t.pricing.dynamicHint}
          >
            {t.pricing.dynamicBadge}
          </span>
        ) : null}
        <div className="flex flex-wrap items-center gap-1.5">
          {chips.map((c) => (
            <span
              key={c}
              className="rounded-md border border-line bg-surface-2 px-2 py-0.5 text-xs font-medium text-muted tnum"
            >
              {c}
            </span>
          ))}
        </div>
        <label
          className={cn(
            "flex cursor-pointer items-center gap-2 rounded-lg border px-2.5 py-1 text-xs font-medium transition-colors",
            followSaleRule
              ? "border-line bg-surface-2 text-muted hover:text-ink"
              : "border-accent/50 bg-accent/10 text-accent-text",
          )}
          title={t.pricing.discountRuleHint}
        >
          <Checkbox
            checked={!followSaleRule}
            disabled={pending}
            onCheckedChange={(c) => onToggleGlobalSaleRule(c !== true)}
            aria-label={t.pricing.discountRule}
          />
          {t.pricing.discountRule}
        </label>
        <div className="ml-auto flex gap-1">
          <Button type="button" variant="ghost" size="sm" onClick={() => (editing ? setEditing(false) : openEditor())}>
            {editing ? t.pricing.cancel : t.pricing.edit}
          </Button>
          <Button type="button" variant="ghost" size="sm" onClick={onResetPricing} disabled={resetting}>
            {resetting ? t.pricing.resetting : t.pricing.reset}
          </Button>
        </div>
      </div>

      {error && <p className="mt-2 text-sm text-skip">{error}</p>}

      {editing && (
        <div className="mt-3 border-t border-line pt-3 animate-fade-up">
          {price.markupBands?.length ? (
            <p className="mb-2 text-xs text-muted">{t.pricing.bandsEditHint}</p>
          ) : null}
          <div className="flex flex-wrap items-end gap-3">
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
        </div>
      )}
    </div>
  );
}
