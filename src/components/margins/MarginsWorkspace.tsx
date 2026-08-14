"use client";

import * as React from "react";
import type { MarginKind, MarkupBand, RoundingConfig, ScopedPricingRule } from "@core/config";
import { marginKindOf } from "@core/config";
import { pricingRuleCoverage, savePricingRules, type RuleCoverage } from "@/server/actions/config";
import { useI18n } from "@/i18n/provider";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Combobox, type ComboboxOption } from "@/components/ui/combobox";

/**
 * The margins admin: the whole rule list edited in place, saved as one
 * document. Each card is a rule — scope (who it applies to), margin (percent,
 * fixed € or price bands) and the advanced knobs. Deliberately form-only, no
 * modal flows: the operator sees every rule and its precedence at a glance.
 *
 * Every card also states what the rule DOES: how many catalog products it
 * really sets the margin for, and the shelf price the engine returns at three
 * sample asks. A rule that covers nothing, or that a broader rule silently
 * outranks, used to look exactly like a working one.
 */

type MarginType = MarginKind;

/** One (category, sub-category) pair present in the catalog, with its count. */
export interface FamilyOption {
  category: string;
  secondaryCategory: string;
  count: number;
}

/** A brand the catalog actually holds, with how many products carry it. */
export interface BrandOption {
  brand: string;
  count: number;
}

/** A labelled form field — the label stays visible, unlike a placeholder. */
function Field({
  label,
  hint,
  className,
  children,
}: {
  label: string;
  hint?: string;
  className?: string;
  children: React.ReactNode;
}) {
  return (
    <div className={className}>
      <div className="mb-1 text-[11px] font-medium text-muted">{label}</div>
      {children}
      {hint && <p className="mt-0.5 text-[10px] leading-snug text-faint">{hint}</p>}
    </div>
  );
}

/**
 * The scope as a sentence. A rule is a claim about which products it governs,
 * and reading that claim off six separate inputs is exactly the step where an
 * operator mistakes a name filter for a family one.
 */
function scopeSummary(
  scope: ScopedPricingRule["scope"],
  t: ReturnType<typeof useI18n>["t"],
): string {
  const bits: string[] = [];
  if (scope.source) bits.push(t.margins.sumSource(scope.source));
  if (scope.brand) bits.push(t.margins.sumBrand(scope.brand));
  if (scope.category) {
    bits.push(
      scope.secondaryCategory
        ? t.margins.sumFamilyPair(scope.category, scope.secondaryCategory)
        : t.margins.sumFamily(scope.category),
    );
  } else if (scope.secondaryCategory) {
    bits.push(t.margins.sumFamily(scope.secondaryCategory));
  }
  if (scope.model) bits.push(t.margins.sumName(scope.model));
  if (scope.sku) bits.push(t.margins.sumSku(scope.sku));
  if (scope.sizeMin != null || scope.sizeMax != null) {
    bits.push(t.margins.sumSizes(scope.sizeMin ?? null, scope.sizeMax ?? null));
  }
  return bits.length === 0 ? t.margins.sumEverything : t.margins.sumJoin(bits);
}

const eur = new Intl.NumberFormat("it-IT", { style: "currency", currency: "EUR" });

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

export function MarginsWorkspace({
  initialRules,
  families = [],
  brands = [],
}: {
  initialRules: ScopedPricingRule[];
  families?: FamilyOption[];
  brands?: BrandOption[];
}) {
  const { t } = useI18n();
  const [rules, setRules] = React.useState<ScopedPricingRule[]>(initialRules);
  const [saving, setSaving] = React.useState(false);
  const [note, setNote] = React.useState<{ ok: boolean; text: string } | null>(null);
  const [coverage, setCoverage] = React.useState<Map<string, RuleCoverage>>(new Map());

  // Diagnostics track the list being EDITED, not the saved one: retune a band
  // and the sample prices move before you commit. Debounced, and stale
  // responses are dropped so a slow round-trip can't overwrite a newer one.
  React.useEffect(() => {
    let cancelled = false;
    const timer = setTimeout(() => {
      pricingRuleCoverage(rules)
        .then((res) => {
          if (cancelled) return;
          setCoverage(new Map(res.coverage.map((c) => [c.ruleId, c])));
        })
        .catch(() => {
          /* diagnostics are advisory — never block editing */
        });
    }, 400);
    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
  }, [rules]);

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
            families={families}
            brands={brands}
            coverage={coverage.get(rule.id) ?? null}
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
  const family = [rule.scope.category, rule.scope.secondaryCategory].filter(Boolean).join(" › ");
  const bits = [
    rule.scope.brand,
    family || null,
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
  families,
  brands,
  coverage,
  onPatch,
  onRemove,
}: {
  rule: ScopedPricingRule;
  index: number;
  families: FamilyOption[];
  brands: BrandOption[];
  coverage: RuleCoverage | null;
  onPatch: (patch: Partial<ScopedPricingRule>) => void;
  onRemove: () => void;
}) {
  const { t } = useI18n();
  const type = marginKindOf(rule);
  const isGeneral = rule.id === "general";

  // Category → its sub-categories, from what the catalog actually holds.
  const categories = React.useMemo(() => {
    const byCategory = new Map<string, { count: number; subs: Map<string, number> }>();
    for (const f of families) {
      if (!f.category) continue;
      const entry = byCategory.get(f.category) ?? { count: 0, subs: new Map<string, number>() };
      entry.count += f.count;
      if (f.secondaryCategory) {
        entry.subs.set(f.secondaryCategory, (entry.subs.get(f.secondaryCategory) ?? 0) + f.count);
      }
      byCategory.set(f.category, entry);
    }
    return byCategory;
  }, [families]);

  const categoryOptions = React.useMemo<ComboboxOption[]>(
    () =>
      [...categories.entries()]
        .sort((a, b) => a[0].localeCompare(b[0]))
        .map(([value, entry]) => ({ value, count: entry.count })),
    [categories],
  );

  const subCategoryOptions = React.useMemo<ComboboxOption[]>(() => {
    const chosen = rule.scope.category;
    if (!chosen) return [];
    const entry = categories.get(chosen);
    if (!entry) return [];
    return [...entry.subs.entries()]
      .sort((a, b) => a[0].localeCompare(b[0]))
      .map(([value, count]) => ({ value, count }));
  }, [categories, rule.scope.category]);

  const brandOptions = React.useMemo<ComboboxOption[]>(
    () => brands.map((b) => ({ value: b.brand, count: b.count })),
    [brands],
  );

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
        {/* Scope — one labelled field per axis. The old wrapping row of bare
            placeholders made "Yeezy Foam" ambiguous the moment it was typed:
            brand? model? SKU? Labels stay visible, and every axis the catalog
            knows the values of is a picker rather than a guess. */}
        <div>
          <div className="text-xs font-semibold">{t.margins.scopeTitle}</div>
          <p className="mb-3 mt-0.5 text-[11px] leading-snug text-muted">{t.margins.scopeHint}</p>

          <div className="grid gap-x-3 gap-y-2.5 sm:grid-cols-2">
            <Field label={t.margins.scopeSource}>
              <select
                aria-label={t.margins.scopeSource}
                className={`${SELECT} w-full`}
                value={rule.scope.source ?? ""}
                onChange={(e) => patchScope({ source: e.target.value || undefined })}
              >
                <option value="">{t.margins.scopeSourceAny}</option>
                <option value="kicksdb">kicksdb</option>
                <option value="goldensneakers">goldensneakers</option>
              </select>
            </Field>

            <Field label={t.margins.scopeBrand}>
              <Combobox
                aria-label={t.margins.scopeBrand}
                value={rule.scope.brand ?? ""}
                onChange={(v) => patchScope({ brand: v || undefined })}
                options={brandOptions}
                anyLabel={t.margins.scopeAny}
                placeholder={t.margins.scopeAny}
                customLabel={t.margins.scopeUseTyped}
                emptyLabel={t.margins.scopeNoMatch}
              />
            </Field>

            <Field label={t.margins.scopeCategory}>
              <Combobox
                aria-label={t.margins.scopeCategory}
                value={rule.scope.category ?? ""}
                onChange={(v) =>
                  // A sub-family only means something inside its family.
                  patchScope({ category: v || undefined, secondaryCategory: undefined })
                }
                options={categoryOptions}
                anyLabel={t.margins.scopeAny}
                placeholder={t.margins.scopeAny}
                customLabel={t.margins.scopeUseTyped}
                emptyLabel={t.margins.scopeNoMatch}
              />
            </Field>

            <Field
              label={t.margins.scopeSecondaryCategory}
              hint={!rule.scope.category ? t.margins.scopeSubNeedsFamily : undefined}
            >
              <Combobox
                aria-label={t.margins.scopeSecondaryCategory}
                value={rule.scope.secondaryCategory ?? ""}
                onChange={(v) => patchScope({ secondaryCategory: v || undefined })}
                options={subCategoryOptions}
                disabled={!rule.scope.category}
                anyLabel={t.margins.scopeAny}
                placeholder={t.margins.scopeAny}
                customLabel={t.margins.scopeUseTyped}
                emptyLabel={t.margins.scopeNoMatch}
              />
            </Field>

            <Field label={t.margins.scopeModel} hint={t.margins.scopeModelHint}>
              <Input
                aria-label={t.margins.scopeModel}
                placeholder={t.margins.scopeAny}
                className="h-8 w-full text-xs"
                value={rule.scope.model ?? ""}
                onChange={(e) => patchScope({ model: e.target.value || undefined })}
              />
            </Field>

            <Field label={t.margins.scopeSku}>
              <Input
                aria-label={t.margins.scopeSku}
                placeholder={t.margins.scopeAny}
                className="h-8 w-full font-mono text-xs uppercase"
                value={rule.scope.sku ?? ""}
                onChange={(e) => patchScope({ sku: e.target.value || undefined })}
              />
            </Field>

            <Field label={t.margins.scopeSizes} className="sm:col-span-2">
              <div className="flex items-center gap-1.5">
                <Input
                  aria-label={t.margins.scopeSizeMin}
                  placeholder={t.margins.scopeSizeMin}
                  inputMode="decimal"
                  className="h-8 w-20 text-xs"
                  value={rule.scope.sizeMin != null ? String(rule.scope.sizeMin) : ""}
                  onChange={(e) => patchScope({ sizeMin: num(e.target.value) })}
                />
                <span className="text-[11px] text-faint">{t.margins.scopeSizeMax}</span>
                <Input
                  aria-label={t.margins.scopeSizeMax}
                  placeholder={t.margins.scopeAny}
                  inputMode="decimal"
                  className="h-8 w-20 text-xs"
                  value={rule.scope.sizeMax != null ? String(rule.scope.sizeMax) : ""}
                  onChange={(e) => patchScope({ sizeMax: num(e.target.value) })}
                />
              </div>
            </Field>
          </div>

          {/* The scope as a sentence — the answer to "so what does this rule
              actually cover?", which a grid of fields never quite gives. */}
          <p className="mt-3 rounded-lg bg-surface-2 px-2.5 py-1.5 text-[11px] leading-snug text-muted">
            <span className="font-semibold text-ink">{t.margins.scopeSummaryLabel}</span>{" "}
            {scopeSummary(rule.scope, t)}
          </p>
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

      <RuleDiagnostics rule={rule} coverage={coverage} />

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

/**
 * What this rule actually does, in the two terms that matter: how many
 * catalog products it sets the margin for, and the shelf price the engine
 * returns for them at three sample asks. Zero coverage is called out loudly —
 * that is the state a rule silently sat in while the operator believed it was
 * pricing a family.
 */
function RuleDiagnostics({
  rule,
  coverage,
}: {
  rule: ScopedPricingRule;
  coverage: RuleCoverage | null;
}) {
  const { t } = useI18n();
  if (!coverage) return null;

  const dead = rule.enabled && coverage.products === 0;
  return (
    <div className="flex flex-wrap items-center gap-x-4 gap-y-1.5 border-t border-line bg-canvas/40 px-4 py-2.5 text-[11px]">
      <span className={dead ? "font-semibold text-skip" : "font-medium text-muted"}>
        {dead ? t.margins.coverageNone : t.margins.coverageCount(coverage.products)}
      </span>
      {coverage.sizeScoped && coverage.products > 0 && (
        <span className="text-faint">{t.margins.coverageSizeScoped}</span>
      )}
      <span className="flex flex-wrap items-center gap-x-2.5 gap-y-1 text-faint tnum">
        <span>{t.margins.exampleLabel}</span>
        {coverage.examples.map((ex) => (
          <span key={ex.ask}>
            {eur.format(ex.ask)} →{" "}
            <span className="font-semibold text-ink">
              {ex.price != null ? eur.format(ex.price) : "—"}
            </span>
          </span>
        ))}
      </span>
    </div>
  );
}
