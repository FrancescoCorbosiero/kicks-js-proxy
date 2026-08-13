"use client";

import * as React from "react";
import type { MarkupBand, RoundingConfig, ScopedPricingRule } from "@core/config";
import { savePricingRules } from "@/server/actions/config";
import { useI18n } from "@/i18n/provider";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";

/**
 * The margins admin: the whole rule list edited in place, saved as one
 * document. Each card is a rule — scope (who it applies to), margin (percent,
 * fixed € or price bands) and the advanced knobs. Deliberately form-only, no
 * modal flows: the operator sees every rule and its precedence at a glance.
 */

type MarginType = "percent" | "fixed" | "bands" | "none";

function marginTypeOf(r: ScopedPricingRule): MarginType {
  if (r.markupBands && r.markupBands.length > 0) return "bands";
  if (r.markupFixed != null) return "fixed";
  if (r.markupPercent != null) return "percent";
  return "none";
}

/** Parse a locale-tolerant number input; "" -> undefined. */
function num(v: string): number | undefined {
  const t = v.trim().replace(",", ".");
  if (t === "") return undefined;
  const n = Number.parseFloat(t);
  return Number.isFinite(n) ? n : undefined;
}

const FIELD = "h-8 w-24 text-xs";
const SELECT =
  "h-8 rounded-md border border-line bg-surface px-2 text-xs text-ink shadow-xs outline-none focus-visible:ring-2 focus-visible:ring-accent/40";

export function MarginsWorkspace({ initialRules }: { initialRules: ScopedPricingRule[] }) {
  const { t } = useI18n();
  const [rules, setRules] = React.useState<ScopedPricingRule[]>(initialRules);
  const [saving, setSaving] = React.useState(false);
  const [note, setNote] = React.useState<{ ok: boolean; text: string } | null>(null);

  function patchRule(index: number, patch: Partial<ScopedPricingRule>) {
    setNote(null);
    setRules((rs) => rs.map((r, i) => (i === index ? { ...r, ...patch } : r)));
  }

  function addRule() {
    setNote(null);
    setRules((rs) => [
      ...rs,
      {
        id: `rule-${crypto.randomUUID().slice(0, 8)}`,
        scope: {},
        enabled: true,
        markupPercent: 10,
      },
    ]);
  }

  function removeRule(index: number) {
    setNote(null);
    setRules((rs) => rs.filter((_, i) => i !== index));
  }

  async function save() {
    setSaving(true);
    setNote(null);
    const res = await savePricingRules(rules);
    setSaving(false);
    if (res.ok && res.rules) {
      setRules(res.rules);
      setNote({ ok: true, text: t.margins.saved });
    } else {
      setNote({ ok: false, text: `${t.margins.saveFailed}: ${res.error ?? ""}` });
    }
  }

  return (
    <div className="space-y-4">
      {rules.length === 0 && (
        <div className="rounded-xl border border-line bg-surface p-8 text-center text-sm text-muted">
          {t.margins.empty}
        </div>
      )}
      <ul className="space-y-4">
        {rules.map((rule, i) => (
          <RuleCard
            key={rule.id}
            rule={rule}
            index={i}
            onPatch={(p) => patchRule(i, p)}
            onRemove={() => removeRule(i)}
          />
        ))}
      </ul>

      <div className="flex flex-wrap items-center gap-3">
        <Button type="button" variant="outline" onClick={addRule}>
          + {t.margins.addRule}
        </Button>
        <Button type="button" variant="accent" onClick={save} disabled={saving}>
          {saving ? t.margins.saving : t.margins.save}
        </Button>
        {note && (
          <span className={`text-sm font-medium ${note.ok ? "text-up" : "text-skip"}`}>
            {note.text}
          </span>
        )}
      </div>
    </div>
  );
}

function ruleLabel(
  rule: ScopedPricingRule,
  index: number,
  t: ReturnType<typeof useI18n>["t"],
): string {
  if (rule.id === "general") return t.margins.generalRule;
  if (rule.id === "goldensneakers-passthrough" || rule.scope.source === "goldensneakers") {
    return t.margins.gsRule;
  }
  const bits = [
    rule.scope.brand,
    rule.scope.model && `“${rule.scope.model}”`,
    rule.scope.sku,
    rule.scope.sizeMin != null || rule.scope.sizeMax != null
      ? `${rule.scope.sizeMin ?? ""}–${rule.scope.sizeMax ?? ""}`
      : null,
  ].filter(Boolean);
  return bits.length > 0 ? bits.join(" · ") : t.margins.customRule(index + 1);
}

function RuleCard({
  rule,
  index,
  onPatch,
  onRemove,
}: {
  rule: ScopedPricingRule;
  index: number;
  onPatch: (patch: Partial<ScopedPricingRule>) => void;
  onRemove: () => void;
}) {
  const { t } = useI18n();
  const type = marginTypeOf(rule);
  const isGeneral = rule.id === "general";

  function setType(next: MarginType) {
    // One margin mechanism per rule: switching clears the others.
    const cleared: Partial<ScopedPricingRule> = {
      markupPercent: undefined,
      markupFixed: undefined,
      markupBands: undefined,
    };
    if (next === "percent") cleared.markupPercent = 10;
    if (next === "fixed") cleared.markupFixed = 5;
    if (next === "bands")
      cleared.markupBands = [
        { upTo: 150, percent: 35 },
        { upTo: 300, percent: 30 },
        { upTo: null, percent: 19 },
      ];
    onPatch(cleared);
  }

  function patchScope(patch: Partial<ScopedPricingRule["scope"]>) {
    onPatch({ scope: { ...rule.scope, ...patch } });
  }

  function patchBand(bandIndex: number, patch: Partial<MarkupBand>) {
    const bands = (rule.markupBands ?? []).map((b, i) =>
      i === bandIndex ? { ...b, ...patch } : b,
    );
    onPatch({ markupBands: bands });
  }

  const rounding: RoundingConfig = rule.rounding ?? { mode: "none" };

  return (
    <li
      className={`overflow-hidden rounded-xl border bg-surface shadow-xs ${
        rule.enabled ? "border-line" : "border-line/60 opacity-60"
      }`}
    >
      <div className="flex flex-wrap items-center gap-3 border-b border-line px-4 py-3">
        <span className="min-w-0 flex-1 truncate text-sm font-semibold">
          {ruleLabel(rule, index, t)}
        </span>
        <label className="flex cursor-pointer items-center gap-1.5 text-xs font-medium text-muted">
          <input
            type="checkbox"
            className="h-3.5 w-3.5 accent-current"
            checked={rule.enabled}
            onChange={(e) => onPatch({ enabled: e.target.checked })}
          />
          {t.margins.enabled}
        </label>
        {!isGeneral && (
          <Button type="button" variant="ghost" size="sm" className="text-skip" onClick={onRemove}>
            {t.margins.deleteRule}
          </Button>
        )}
      </div>

      <div className="grid gap-4 px-4 py-4 sm:grid-cols-2">
        {/* Scope */}
        <div>
          <div className="text-xs font-semibold">{t.margins.scopeTitle}</div>
          <p className="mb-2 mt-0.5 text-[11px] leading-snug text-muted">{t.margins.scopeHint}</p>
          <div className="flex flex-wrap items-center gap-2">
            <select
              aria-label={t.margins.scopeSource}
              className={SELECT}
              value={rule.scope.source ?? ""}
              onChange={(e) => patchScope({ source: e.target.value || undefined })}
            >
              <option value="">{t.margins.scopeSource}: {t.margins.scopeSourceAny}</option>
              <option value="kicksdb">kicksdb</option>
              <option value="goldensneakers">goldensneakers</option>
            </select>
            <Input
              aria-label={t.margins.scopeBrand}
              placeholder={t.margins.scopeBrand}
              className="h-8 w-32 text-xs"
              value={rule.scope.brand ?? ""}
              onChange={(e) => patchScope({ brand: e.target.value || undefined })}
            />
            <Input
              aria-label={t.margins.scopeModel}
              placeholder={t.margins.scopeModel}
              className="h-8 w-36 text-xs"
              value={rule.scope.model ?? ""}
              onChange={(e) => patchScope({ model: e.target.value || undefined })}
            />
            <Input
              aria-label={t.margins.scopeSku}
              placeholder={t.margins.scopeSku}
              className="h-8 w-32 font-mono text-xs"
              value={rule.scope.sku ?? ""}
              onChange={(e) => patchScope({ sku: e.target.value || undefined })}
            />
            <div className="flex items-center gap-1 text-[11px] text-muted">
              <Input
                aria-label={t.margins.scopeSizeMin}
                placeholder={t.margins.scopeSizeMin}
                inputMode="decimal"
                className="h-8 w-20 text-xs"
                value={rule.scope.sizeMin != null ? String(rule.scope.sizeMin) : ""}
                onChange={(e) => patchScope({ sizeMin: num(e.target.value) })}
              />
              <span>{t.margins.scopeSizeMax}</span>
              <Input
                aria-label={t.margins.scopeSizeMax}
                inputMode="decimal"
                className="h-8 w-20 text-xs"
                value={rule.scope.sizeMax != null ? String(rule.scope.sizeMax) : ""}
                onChange={(e) => patchScope({ sizeMax: num(e.target.value) })}
              />
            </div>
          </div>
        </div>

        {/* Margin */}
        <div>
          <div className="mb-2 text-xs font-semibold">{t.margins.marginTitle}</div>
          <div className="flex flex-wrap items-center gap-2">
            <select
              aria-label={t.margins.marginTitle}
              className={SELECT}
              value={type}
              onChange={(e) => setType(e.target.value as MarginType)}
            >
              <option value="percent">{t.margins.typePercent}</option>
              <option value="fixed">{t.margins.typeFixed}</option>
              <option value="bands">{t.margins.typeBands}</option>
              <option value="none">{t.margins.typeNone}</option>
            </select>
            {type === "percent" && (
              <label className="flex items-center gap-1.5 text-xs text-muted">
                {t.margins.percentLabel}
                <Input
                  inputMode="decimal"
                  className={FIELD}
                  value={rule.markupPercent != null ? String(rule.markupPercent) : ""}
                  onChange={(e) => onPatch({ markupPercent: num(e.target.value) })}
                />
              </label>
            )}
            {type === "fixed" && (
              <label className="flex items-center gap-1.5 text-xs text-muted">
                {t.margins.fixedLabel}
                <Input
                  inputMode="decimal"
                  className={FIELD}
                  value={rule.markupFixed != null ? String(rule.markupFixed) : ""}
                  onChange={(e) => onPatch({ markupFixed: num(e.target.value) })}
                />
              </label>
            )}
          </div>

          {type === "bands" && (
            <div className="mt-2 space-y-1.5">
              {(rule.markupBands ?? []).map((band, bi) => (
                <div key={bi} className="flex flex-wrap items-center gap-1.5 text-xs text-muted tnum">
                  <span>{t.margins.bandUpTo}</span>
                  <Input
                    inputMode="decimal"
                    aria-label={t.margins.bandUpTo}
                    placeholder={t.margins.bandInfinity}
                    className="h-7 w-20 text-xs"
                    value={band.upTo != null ? String(band.upTo) : ""}
                    onChange={(e) => patchBand(bi, { upTo: num(e.target.value) ?? null })}
                  />
                  <span>→ {t.margins.bandPercent}</span>
                  <Input
                    inputMode="decimal"
                    aria-label={t.margins.bandPercent}
                    className="h-7 w-16 text-xs"
                    value={String(band.percent)}
                    onChange={(e) => patchBand(bi, { percent: num(e.target.value) ?? 0 })}
                  />
                  <button
                    type="button"
                    aria-label={t.margins.bandRemove}
                    className="rounded p-1 text-faint hover:text-skip"
                    onClick={() =>
                      onPatch({ markupBands: (rule.markupBands ?? []).filter((_, i) => i !== bi) })
                    }
                  >
                    ✕
                  </button>
                </div>
              ))}
              <button
                type="button"
                className="text-xs font-medium text-accent-text underline-offset-2 hover:underline"
                onClick={() =>
                  onPatch({
                    markupBands: [...(rule.markupBands ?? []), { upTo: null, percent: 20 }],
                  })
                }
              >
                + {t.margins.bandAdd}
              </button>
            </div>
          )}

          {/* The knob that guarantees money is never lost on cheap asks —
              front and center, not buried in the advanced section. */}
          <label
            className="mt-3 flex items-center gap-1.5 text-xs text-muted"
            title={t.margins.minMarginHint}
          >
            {t.margins.minMargin}
            <Input
              inputMode="decimal"
              className={FIELD}
              value={rule.minMarginFixed != null ? String(rule.minMarginFixed) : ""}
              onChange={(e) => onPatch({ minMarginFixed: num(e.target.value) })}
            />
          </label>
          <p className="mt-1 max-w-md text-[11px] leading-snug text-faint">
            {t.margins.minMarginHint}
          </p>
        </div>
      </div>

      {/* Advanced knobs */}
      <details className="border-t border-line px-4 py-3">
        <summary className="cursor-pointer text-xs font-semibold text-muted hover:text-ink">
          {t.margins.advanced}
        </summary>
        <div className="mt-3 flex flex-wrap items-end gap-x-4 gap-y-3 text-xs text-muted">
          <label className="flex flex-col gap-1">
            {t.margins.floor}
            <Input
              inputMode="decimal"
              className={FIELD}
              value={rule.floor != null ? String(rule.floor) : ""}
              onChange={(e) => onPatch({ floor: num(e.target.value) })}
            />
          </label>
          <label className="flex flex-col gap-1">
            {t.margins.minAsks}
            <Input
              inputMode="numeric"
              className={FIELD}
              value={rule.minAsks != null ? String(rule.minAsks) : ""}
              onChange={(e) => {
                const n = num(e.target.value);
                onPatch({ minAsks: n != null ? Math.round(n) : undefined });
              }}
            />
          </label>
          <label className="flex flex-col gap-1">
            {t.margins.rounding}
            <span className="flex items-center gap-1.5">
              <select
                aria-label={t.margins.rounding}
                className={SELECT}
                value={rounding.mode}
                onChange={(e) =>
                  onPatch({
                    rounding: { ...rounding, mode: e.target.value as RoundingConfig["mode"] },
                  })
                }
              >
                {(["none", "integer", "charm", "nearest"] as const).map((m) => (
                  <option key={m} value={m}>
                    {t.margins.roundingModes[m]}
                  </option>
                ))}
              </select>
              {(rounding.mode === "charm" || rounding.mode === "nearest") && (
                <Input
                  inputMode="decimal"
                  aria-label={t.margins.increment}
                  placeholder={t.margins.increment}
                  className="h-8 w-16 text-xs"
                  value={rounding.increment != null ? String(rounding.increment) : ""}
                  onChange={(e) => onPatch({ rounding: { ...rounding, increment: num(e.target.value) } })}
                />
              )}
            </span>
          </label>
          <label className="flex flex-col gap-1">
            {t.margins.vat}
            <Input
              inputMode="decimal"
              className={FIELD}
              value={rule.tax ? String(rule.tax.vatRatePercent) : ""}
              onChange={(e) => {
                const n = num(e.target.value);
                onPatch({
                  tax: n != null ? { priceIncludesVat: n > 0, vatRatePercent: n } : undefined,
                });
              }}
            />
          </label>
          <label className="flex flex-col gap-1">
            {t.margins.minDelta}
            <Input
              inputMode="decimal"
              className={FIELD}
              value={rule.minDeltaPercent != null ? String(rule.minDeltaPercent) : ""}
              onChange={(e) => onPatch({ minDeltaPercent: num(e.target.value) })}
            />
          </label>
          <label className="flex flex-col gap-1">
            {t.margins.maxDelta}
            <Input
              inputMode="decimal"
              className={FIELD}
              value={rule.maxDeltaPercent != null ? String(rule.maxDeltaPercent) : ""}
              onChange={(e) => onPatch({ maxDeltaPercent: num(e.target.value) })}
            />
          </label>
          <label className="flex flex-col gap-1" title={t.margins.outlierFloorHint}>
            {t.margins.outlierFloor}
            <Input
              inputMode="decimal"
              className={FIELD}
              value={rule.outlierFloorPercent != null ? String(rule.outlierFloorPercent) : ""}
              onChange={(e) => onPatch({ outlierFloorPercent: num(e.target.value) })}
            />
          </label>
        </div>
      </details>
    </li>
  );
}
