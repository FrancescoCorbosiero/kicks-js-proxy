"use client";

import * as React from "react";
import { createStoreProducts, listCreatable } from "@/server/actions/sync";
import type { CreatableEntry, CreateOutcome } from "@/server/woo/create";
import { chunkArray } from "@/lib/chunk";
import { useI18n } from "@/i18n/provider";
import { Button } from "@/components/ui/button";

/** Products per bulk-create chunk (each product = 1 parent POST + 1 batch). */
const CHUNK = 10;

interface Progress {
  done: number;
  total: number;
  created: number;
  variations: number;
  failed: number;
  errors: { sku: string; error: string }[];
  finished: boolean;
}

/**
 * Create the products the feeds carry but the store lacks (mostly GoldenSneakers).
 * Distinct, guarded operation: compute the scope, choose draft/publish + images,
 * dry-run, then confirm. Products are born from their owner's data with the
 * same canonical identity as the rebuild.
 */
export function CreatePanel({ disabled, onDone }: { disabled?: boolean; onDone: () => void }) {
  const { t } = useI18n();
  const [scope, setScope] = React.useState<{ items: CreatableEntry[]; gs: number; kicksdb: number } | null>(null);
  const [loading, setLoading] = React.useState(false);
  const [status, setStatus] = React.useState<"draft" | "publish">("draft");
  const [withImages, setWithImages] = React.useState(false);
  const [includeKicksdb, setIncludeKicksdb] = React.useState(false);
  const [running, setRunning] = React.useState<"dry" | "live" | null>(null);
  const [error, setError] = React.useState<string | null>(null);
  const [dry, setDry] = React.useState<CreateOutcome | null>(null);
  const [progress, setProgress] = React.useState<Progress | null>(null);
  const cancelRef = React.useRef(false);

  const selected = React.useMemo(
    () => (scope ? scope.items.filter((i) => includeKicksdb || i.owner === "goldensneakers") : []),
    [scope, includeKicksdb],
  );

  async function loadScope() {
    setLoading(true);
    setError(null);
    try {
      const res = await listCreatable();
      if (!res.ok) setError(res.error ?? t.sync.create.failed);
      else setScope({ items: res.items, gs: res.gs, kicksdb: res.kicksdb });
    } finally {
      setLoading(false);
    }
  }

  async function run(dryRun: boolean) {
    if (selected.length === 0 || running) return;
    setError(null);
    setDry(null);
    setRunning(dryRun ? "dry" : "live");
    cancelRef.current = false;
    const skus = selected.map((i) => i.sku);

    if (dryRun) {
      try {
        const res = await createStoreProducts({ skus: skus.slice(0, 100), dryRun: true, status, withImages });
        if (!res.ok || !res.outcome) setError(res.error ?? t.sync.create.failed);
        else setDry(res.outcome);
      } finally {
        setRunning(null);
      }
      return;
    }

    // Live: chunked, one accumulated audit row, cancellable.
    const p: Progress = { done: 0, total: skus.length, created: 0, variations: 0, failed: 0, errors: [], finished: false };
    setProgress({ ...p });
    try {
      let auditId: string | undefined;
      for (const chunk of chunkArray(skus, CHUNK)) {
        if (cancelRef.current) break;
        const res = await createStoreProducts({ skus: chunk, dryRun: false, status, withImages, auditId });
        if (!res.ok || !res.outcome) {
          setError(res.error ?? t.sync.create.failed);
          break;
        }
        auditId = res.outcome.auditId;
        p.done += chunk.length;
        p.created += res.outcome.created;
        p.variations += res.outcome.variationsCreated;
        p.failed += res.outcome.failed;
        for (const r of res.outcome.products) {
          if (r.error && p.errors.length < 20) p.errors.push({ sku: r.sku, error: r.error });
        }
        setProgress({ ...p });
      }
      p.finished = true;
      setProgress({ ...p });
      setDry(null);
      onDone();
    } finally {
      setRunning(null);
    }
  }

  return (
    <details className="group rounded-xl border border-accent/40 bg-surface shadow-xs">
      <summary className="cursor-pointer list-none px-5 py-3 text-sm font-medium text-muted transition-colors hover:text-ink">
        <span className="inline-flex items-center gap-2">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" className="h-3.5 w-3.5 text-accent-text transition-transform group-open:rotate-90">
            <path d="m9 18 6-6-6-6" />
          </svg>
          <span className="font-semibold text-accent-text">{t.sync.create.title}</span>
          <span className="text-xs text-faint">{t.sync.create.tag}</span>
        </span>
      </summary>

      <div className="space-y-3 border-t border-line p-5">
        <p className="max-w-2xl text-xs leading-relaxed text-muted">{t.sync.create.desc}</p>

        <div className="flex flex-wrap items-center gap-2">
          {scope ? (
            <span className="text-sm font-semibold tnum">
              {t.sync.create.scope(scope.gs, scope.kicksdb)}
            </span>
          ) : (
            <Button type="button" variant="outline" size="sm" onClick={loadScope} disabled={loading || running != null}>
              {loading ? t.catalog.loading : t.sync.create.compute}
            </Button>
          )}
          {scope && scope.kicksdb > 0 && (
            <label className="flex cursor-pointer items-center gap-2 text-xs font-medium text-muted">
              <input type="checkbox" className="h-3.5 w-3.5 accent-current" checked={includeKicksdb} onChange={(e) => setIncludeKicksdb(e.target.checked)} />
              {t.sync.create.includeKicksdb(scope.kicksdb)}
            </label>
          )}
        </div>

        {scope && selected.length > 0 && (
          <>
            <div className="flex flex-wrap items-center gap-3 rounded-lg border border-line bg-surface-2 p-3 text-xs">
              <label className="flex items-center gap-2 font-medium">
                {t.sync.create.statusLabel}
                <select
                  value={status}
                  onChange={(e) => setStatus(e.target.value as "draft" | "publish")}
                  className="h-8 rounded-md border border-line bg-surface px-2 text-xs"
                >
                  <option value="draft">{t.sync.create.draft}</option>
                  <option value="publish">{t.sync.create.publish}</option>
                </select>
              </label>
              <label className="flex cursor-pointer items-center gap-2 font-medium text-muted" title={t.sync.create.imagesHint}>
                <input type="checkbox" className="h-3.5 w-3.5 accent-current" checked={withImages} onChange={(e) => setWithImages(e.target.checked)} />
                {t.sync.create.images}
              </label>
            </div>

            <div className="flex flex-wrap items-center gap-2">
              <Button type="button" variant="outline" onClick={() => run(true)} disabled={disabled || running != null}>
                {running === "dry" ? t.sync.apply.dryRunning : t.sync.apply.dryRun}
              </Button>
              {progress && running === "live" ? (
                <Button type="button" variant="outline" onClick={() => (cancelRef.current = true)}>
                  {t.sync.pull.cancel}
                </Button>
              ) : (
                <Button
                  type="button"
                  variant="accent"
                  onClick={() => run(false)}
                  disabled={disabled || !dry || running != null}
                  title={dry ? undefined : t.sync.apply.needDryRun}
                >
                  {t.sync.create.create(selected.length)}
                </Button>
              )}
            </div>
          </>
        )}

        {error && <p className="text-sm text-skip">{error}</p>}

        {dry && !progress && (
          <div className="space-y-1 rounded-lg border border-line bg-surface-2 p-3 text-xs animate-fade-up">
            <div className="font-semibold">{t.sync.create.dryTitle(dry.products.length, status === "publish")}</div>
            <ul className="grid gap-x-6 gap-y-0.5 sm:grid-cols-2">
              {dry.products.slice(0, 16).map((p) => (
                <li key={p.sku} className="flex items-center gap-2 tnum">
                  <span className={`rounded px-1 text-[9px] font-bold uppercase ${p.owner === "goldensneakers" ? "bg-warn/15 text-warn" : "bg-surface text-faint"}`}>
                    {p.owner === "goldensneakers" ? "GS" : "KX"}
                  </span>
                  <span className="font-mono text-faint">{p.sku}</span>
                  <span className="ml-auto text-muted">{t.sync.create.sizesCount(p.sizes.length)}</span>
                </li>
              ))}
            </ul>
            {dry.products.length > 16 && <div className="text-faint">{t.sync.apply.dryMore(dry.products.length - 16)}</div>}
          </div>
        )}

        {progress && (
          <div className="space-y-1.5">
            <div className="flex items-center gap-3 text-xs text-muted tnum">
              {!progress.finished && <span className="spin h-3.5 w-3.5 rounded-full border-2 border-accent/30 border-t-accent" />}
              <span className="font-semibold">{t.sync.create.progress(progress.done, progress.total)}</span>
              <span>{t.sync.create.doneLine(progress.created, progress.variations, progress.failed)}</span>
            </div>
            <div className="h-1.5 w-full overflow-hidden rounded-full bg-surface-2">
              <div className="h-full rounded-full bg-accent transition-all" style={{ width: `${Math.round((progress.done / Math.max(1, progress.total)) * 100)}%` }} />
            </div>
            {progress.errors.length > 0 && (
              <details className="text-xs text-muted">
                <summary className="cursor-pointer font-medium text-skip">{t.sync.rebuild.bulkErrors(progress.failed)}</summary>
                <ul className="mt-1 space-y-0.5 font-mono">
                  {progress.errors.map((e) => (
                    <li key={e.sku}>{e.sku}: {e.error}</li>
                  ))}
                </ul>
              </details>
            )}
          </div>
        )}
      </div>
    </details>
  );
}
