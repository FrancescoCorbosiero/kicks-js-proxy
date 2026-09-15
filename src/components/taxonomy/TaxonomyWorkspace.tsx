"use client";

import * as React from "react";
import type { TaxonomyConfig, TaxonomyRule } from "@core/config";
import {
  previewTaxonomy,
  resetTaxonomy,
  saveTaxonomy,
  type TaxonomyState,
} from "@/server/actions/taxonomy";
import { useI18n } from "@/i18n/provider";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Combobox } from "@/components/ui/combobox";

/**
 * Where a product lands on the store, and which of its identity fields get
 * there at all.
 *
 * The tab exists because the answer is not the same for every source and
 * cannot be guessed from code: KicksDB ships a curated tree worth keeping, a
 * supplier feed ships none and its apparent tree is inferred from titles —
 * writing that would duplicate the brand taxonomy and mint a term per model.
 *
 * The design principle here is that nobody should have to imagine what a rule
 * does. Every edit re-runs against the catalog the shop really has, and the
 * table at the bottom says "these many products, under this category, for
 * example these three". A rule is judged by its effect, not by its wording.
 */

const SELECT =
  "h-8 rounded-md border border-line bg-surface px-2 text-xs text-ink shadow-xs outline-none focus-visible:ring-2 focus-visible:ring-accent/40";

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <label className="block">
      <span className="mb-1 block text-[11px] font-medium text-muted">{label}</span>
      {children}
    </label>
  );
}

export function TaxonomyWorkspace({ initial }: { initial: TaxonomyState }) {
  const { t } = useI18n();
  const [draft, setDraft] = React.useState<TaxonomyConfig>(initial.taxonomy);
  const [state, setState] = React.useState<TaxonomyState>(initial);
  const [saved, setSaved] = React.useState<TaxonomyConfig>(initial.taxonomy);
  const [busy, setBusy] = React.useState(false);
  const [previewing, setPreviewing] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);

  const dirty = JSON.stringify(draft) !== JSON.stringify(saved);

  // Re-run the draft against the real catalog, shortly after typing stops.
  React.useEffect(() => {
    if (!dirty) return;
    setPreviewing(true);
    const timer = setTimeout(async () => {
      const res = await previewTaxonomy(draft);
      if (res.ok && res.state) setState(res.state);
      else if (!res.ok) setError(res.error ?? t.taxonomy.failed);
      setPreviewing(false);
    }, 400);
    return () => {
      clearTimeout(timer);
      setPreviewing(false);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [draft, dirty]);

  function patch(next: Partial<TaxonomyConfig>) {
    setError(null);
    setDraft((d) => ({ ...d, ...next }));
  }

  function patchRule(id: string, next: Partial<TaxonomyRule>) {
    patch({ rules: draft.rules.map((r) => (r.id === id ? { ...r, ...next } : r)) });
  }

  function addRule() {
    patch({
      rules: [
        ...draft.rules,
        { id: crypto.randomUUID(), enabled: true, scope: {}, category: "" },
      ],
    });
  }

  async function save() {
    setBusy(true);
    setError(null);
    try {
      const res = await saveTaxonomy(draft);
      if (!res.ok || !res.state) {
        setError(res.error ?? t.taxonomy.failed);
        return;
      }
      setState(res.state);
      setSaved(res.state.taxonomy);
      setDraft(res.state.taxonomy);
    } finally {
      setBusy(false);
    }
  }

  async function reset() {
    setBusy(true);
    setError(null);
    try {
      const res = await resetTaxonomy();
      if (!res.ok || !res.state) {
        setError(res.error ?? t.taxonomy.failed);
        return;
      }
      setState(res.state);
      setSaved(res.state.taxonomy);
      setDraft(res.state.taxonomy);
    } finally {
      setBusy(false);
    }
  }

  const brandOptions = React.useMemo(() => state.brands.map((value) => ({ value })), [state.brands]);
  const familyOptions = React.useMemo(
    () => state.categories.map((value) => ({ value })),
    [state.categories],
  );

  return (
    <div className="space-y-5">
      {/* 1. Who is trusted with its own tree */}
      <section className="rounded-xl border border-line bg-surface p-4 shadow-xs">
        <div className="text-sm font-bold">{t.taxonomy.sourcesTitle}</div>
        <p className="mt-0.5 max-w-3xl text-xs leading-relaxed text-muted">
          {t.taxonomy.sourcesHint}
        </p>
        <ul className="mt-3 space-y-2">
          {state.sources.length === 0 && (
            <li className="text-xs text-faint">{t.taxonomy.noSources}</li>
          )}
          {state.sources.map(({ source, products }) => {
            const tree = draft.useSourceTree.some((s) => s.toLowerCase() === source.toLowerCase());
            return (
              <li
                key={source}
                className="flex flex-wrap items-center gap-3 rounded-lg border border-line bg-surface-2 px-3 py-2"
              >
                <span className="text-sm font-semibold">{source}</span>
                <span className="text-xs text-faint tnum">{t.taxonomy.products(products)}</span>
                <div className="ml-auto flex items-center gap-1 rounded-lg border border-line bg-surface p-0.5">
                  <button
                    type="button"
                    onClick={() =>
                      patch({
                        useSourceTree: draft.useSourceTree.filter(
                          (s) => s.toLowerCase() !== source.toLowerCase(),
                        ),
                      })
                    }
                    className={`rounded-md px-2.5 py-1 text-[11px] font-semibold transition-colors ${
                      !tree ? "bg-accent text-accent-fg shadow-xs" : "text-muted hover:text-ink"
                    }`}
                  >
                    {t.taxonomy.modeRules}
                  </button>
                  <button
                    type="button"
                    onClick={() => patch({ useSourceTree: [...draft.useSourceTree, source] })}
                    className={`rounded-md px-2.5 py-1 text-[11px] font-semibold transition-colors ${
                      tree ? "bg-accent text-accent-fg shadow-xs" : "text-muted hover:text-ink"
                    }`}
                  >
                    {t.taxonomy.modeTree}
                  </button>
                </div>
              </li>
            );
          })}
        </ul>
      </section>

      {/* 2. The default, and the rules that bend it */}
      <section className="space-y-3 rounded-xl border border-line bg-surface p-4 shadow-xs">
        <div>
          <div className="text-sm font-bold">{t.taxonomy.rulesTitle}</div>
          <p className="mt-0.5 max-w-3xl text-xs leading-relaxed text-muted">
            {t.taxonomy.rulesHint}
          </p>
        </div>

        <div className="flex flex-wrap items-end gap-3">
          <Field label={t.taxonomy.defaultCategory}>
            <Input
              className="h-8 w-56 text-xs"
              value={draft.defaultCategory}
              placeholder={t.taxonomy.defaultPlaceholder}
              onChange={(e) => patch({ defaultCategory: e.target.value })}
            />
          </Field>
          <div className="flex items-center gap-1.5 pb-1">
            {["Sneakers", "Abbigliamento", "Accessori"].map((preset) => (
              <button
                key={preset}
                type="button"
                onClick={() => patch({ defaultCategory: preset })}
                className="rounded-md border border-line bg-surface-2 px-2 py-1 text-[11px] font-medium text-muted hover:text-ink"
              >
                {preset}
              </button>
            ))}
          </div>
          <p className="w-full text-[11px] text-faint">{t.taxonomy.defaultHint}</p>
        </div>

        <ul className="space-y-2">
          {draft.rules.map((rule, i) => (
            <li
              key={rule.id}
              className={`rounded-xl border bg-surface-2 p-3 ${
                rule.enabled ? "border-line" : "border-line/60 opacity-60"
              }`}
            >
              <div className="mb-2 flex flex-wrap items-center gap-3">
                <span className="text-xs font-semibold">{t.taxonomy.ruleN(i + 1)}</span>
                <label className="flex cursor-pointer items-center gap-1.5 text-[11px] font-medium text-muted">
                  <input
                    type="checkbox"
                    className="h-3.5 w-3.5 accent-current"
                    checked={rule.enabled}
                    onChange={(e) => patchRule(rule.id, { enabled: e.target.checked })}
                  />
                  {t.taxonomy.enabled}
                </label>
                <Button
                  type="button"
                  variant="ghost"
                  size="sm"
                  className="ml-auto text-skip"
                  onClick={() => patch({ rules: draft.rules.filter((r) => r.id !== rule.id) })}
                >
                  {t.taxonomy.deleteRule}
                </Button>
              </div>

              <div className="grid gap-x-3 gap-y-2.5 sm:grid-cols-3">
                <Field label={t.taxonomy.scopeSource}>
                  <select
                    aria-label={t.taxonomy.scopeSource}
                    className={`${SELECT} w-full`}
                    value={rule.scope.source ?? ""}
                    onChange={(e) =>
                      patchRule(rule.id, {
                        scope: { ...rule.scope, source: e.target.value || undefined },
                      })
                    }
                  >
                    <option value="">{t.taxonomy.any}</option>
                    {state.sources.map((s) => (
                      <option key={s.source} value={s.source}>
                        {s.source}
                      </option>
                    ))}
                  </select>
                </Field>

                <Field label={t.taxonomy.scopeBrand}>
                  <Combobox
                    aria-label={t.taxonomy.scopeBrand}
                    value={rule.scope.brand ?? ""}
                    onChange={(v) =>
                      patchRule(rule.id, { scope: { ...rule.scope, brand: v || undefined } })
                    }
                    options={brandOptions}
                    anyLabel={t.taxonomy.any}
                    placeholder={t.taxonomy.any}
                  />
                </Field>

                <Field label={t.taxonomy.scopeFamily}>
                  <Combobox
                    aria-label={t.taxonomy.scopeFamily}
                    value={rule.scope.category ?? ""}
                    onChange={(v) =>
                      patchRule(rule.id, { scope: { ...rule.scope, category: v || undefined } })
                    }
                    options={familyOptions}
                    anyLabel={t.taxonomy.any}
                    placeholder={t.taxonomy.any}
                  />
                </Field>

                <Field label={t.taxonomy.scopeName}>
                  <Input
                    className="h-8 text-xs"
                    placeholder={t.taxonomy.scopeNamePlaceholder}
                    value={rule.scope.model ?? ""}
                    onChange={(e) =>
                      patchRule(rule.id, {
                        scope: { ...rule.scope, model: e.target.value || undefined },
                      })
                    }
                  />
                </Field>

                <Field label={t.taxonomy.scopeSku}>
                  <Input
                    className="h-8 text-xs"
                    placeholder={t.taxonomy.any}
                    value={rule.scope.sku ?? ""}
                    onChange={(e) =>
                      patchRule(rule.id, {
                        scope: { ...rule.scope, sku: e.target.value || undefined },
                      })
                    }
                  />
                </Field>

                <Field label={t.taxonomy.ruleCategory}>
                  <Input
                    className="h-8 text-xs"
                    placeholder={t.taxonomy.ruleCategoryPlaceholder}
                    value={rule.category}
                    onChange={(e) => patchRule(rule.id, { category: e.target.value })}
                  />
                </Field>
              </div>
            </li>
          ))}
        </ul>

        <Button type="button" variant="outline" size="sm" onClick={addRule}>
          {t.taxonomy.addRule}
        </Button>
      </section>

      {/* 3. Which fields reach the store at all */}
      <section className="rounded-xl border border-line bg-surface p-4 shadow-xs">
        <div className="text-sm font-bold">{t.taxonomy.fieldsTitle}</div>
        <p className="mt-0.5 max-w-3xl text-xs leading-relaxed text-muted">
          {t.taxonomy.fieldsHint}
        </p>
        <div className="mt-3 flex flex-wrap gap-x-6 gap-y-2">
          {(
            [
              ["brandTaxonomy", t.taxonomy.writeBrandTaxonomy, t.taxonomy.writeBrandTaxonomyHint],
              ["brandAttribute", t.taxonomy.writeBrandAttribute, t.taxonomy.writeBrandAttributeHint],
              ["genderAttribute", t.taxonomy.writeGender, t.taxonomy.writeGenderHint],
            ] as const
          ).map(([key, label, hint]) => (
            <label
              key={key}
              className="flex cursor-pointer items-center gap-2 text-xs font-medium text-muted"
              title={hint}
            >
              <input
                type="checkbox"
                className="h-3.5 w-3.5 accent-current"
                checked={draft.write[key]}
                onChange={(e) => patch({ write: { ...draft.write, [key]: e.target.checked } })}
              />
              {label}
            </label>
          ))}
        </div>
      </section>

      {/* 4. What it does to the catalog you actually have */}
      <section className="rounded-xl border border-accent/40 bg-accent/5 p-4">
        <div className="flex flex-wrap items-center gap-2">
          <span className="text-sm font-bold">{t.taxonomy.previewTitle}</span>
          <span className="text-xs text-muted tnum">{t.taxonomy.previewTotal(state.total)}</span>
          {previewing && (
            <span className="spin h-3.5 w-3.5 rounded-full border-2 border-accent/30 border-t-accent" />
          )}
          {dirty && !previewing && (
            <span className="text-[11px] font-semibold text-warn">{t.taxonomy.unsaved}</span>
          )}
        </div>
        <p className="mt-0.5 text-xs text-muted">{t.taxonomy.previewHint}</p>

        {state.preview.length === 0 ? (
          <p className="mt-3 text-sm text-muted">{t.taxonomy.previewEmpty}</p>
        ) : (
          <ul className="mt-3 space-y-1">
            {state.preview.map((row) => (
              <li
                key={row.category || "__none__"}
                className="flex flex-wrap items-baseline gap-x-3 gap-y-0.5 rounded-lg bg-surface px-3 py-2"
              >
                <span className={`text-sm font-semibold ${row.category ? "" : "text-warn"}`}>
                  {row.category || t.taxonomy.noCategory}
                </span>
                <span className="text-xs font-medium text-muted tnum">
                  {t.taxonomy.products(row.products)}
                </span>
                <span className="min-w-0 flex-1 truncate text-[11px] text-faint">
                  {row.samples.map((s) => s.title || s.sku).join(" · ")}
                </span>
              </li>
            ))}
          </ul>
        )}
      </section>

      {/* 5. Commit */}
      <div className="flex flex-wrap items-center gap-3">
        <Button type="button" variant="accent" onClick={save} disabled={busy || !dirty}>
          {busy ? t.taxonomy.saving : t.taxonomy.save}
        </Button>
        <Button type="button" variant="ghost" size="sm" onClick={reset} disabled={busy}>
          {t.taxonomy.reset}
        </Button>
        {!dirty && <span className="text-xs font-medium text-up">{t.taxonomy.upToDate}</span>}
        {error && <span className="text-sm font-medium text-skip">{error}</span>}
        <p className="w-full text-[11px] text-faint">{t.taxonomy.appliesHint}</p>
      </div>
    </div>
  );
}
