"use client";

import * as React from "react";
import { rebuildStoreProducts } from "@/server/actions/sync";
import type { RebuildOutcome } from "@/server/woo/rebuild";
import { parseSkus } from "@/lib/skus";
import { useI18n } from "@/i18n/provider";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";

/**
 * The destructive standardization tool: obliterate + re-create the variation
 * sets of chosen products from the KicksDB catalog. Guarded three times: a
 * dry-run gate (live unlocks only for the exact same SKU set), an explicit
 * acknowledgement checkbox, and per-product failure isolation server-side.
 */
export function RebuildPanel({
  previewSkus,
  disabled,
  onDone,
}: {
  /** SKUs of the products currently in the preview — one-click prefill. */
  previewSkus: string[];
  disabled?: boolean;
  onDone: () => void;
}) {
  const { t } = useI18n();
  const [text, setText] = React.useState("");
  const [running, setRunning] = React.useState<"dry" | "live" | null>(null);
  const [error, setError] = React.useState<string | null>(null);
  const [ack, setAck] = React.useState(false);
  const [dry, setDry] = React.useState<{ outcome: RebuildOutcome; signature: string } | null>(null);
  const [applied, setApplied] = React.useState<RebuildOutcome | null>(null);

  const skus = React.useMemo(() => parseSkus(text), [text]);
  const signature = [...skus].sort().join(",");
  const dryValid = dry != null && dry.signature === signature;
  const rebuildable = dryValid ? dry.outcome.products.filter((p) => p.error == null).length : 0;

  function run(dryRun: boolean) {
    if (skus.length === 0 || running) return;
    setError(null);
    setApplied(null);
    setRunning(dryRun ? "dry" : "live");
    void (async () => {
      try {
        const res = await rebuildStoreProducts({ skus, dryRun });
        if (!res.ok || !res.outcome) {
          setError(res.error ?? t.sync.rebuild.failed);
          return;
        }
        if (dryRun) {
          setDry({ outcome: res.outcome, signature });
        } else {
          setApplied(res.outcome);
          setDry(null);
          setAck(false);
          onDone();
        }
      } finally {
        setRunning(null);
      }
    })();
  }

  const report = dryValid ? dry!.outcome : applied;

  return (
    <details className="group rounded-xl border border-skip/40 bg-surface shadow-xs">
      <summary className="cursor-pointer list-none px-5 py-3 text-sm font-medium text-muted transition-colors hover:text-ink">
        <span className="inline-flex items-center gap-2">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" className="h-3.5 w-3.5 text-skip transition-transform group-open:rotate-90">
            <path d="m9 18 6-6-6-6" />
          </svg>
          <span className="font-semibold text-skip">{t.sync.rebuild.title}</span>
          <span className="text-xs text-faint">{t.sync.rebuild.tag}</span>
        </span>
      </summary>

      <div className="space-y-3 border-t border-line p-5">
        <p className="max-w-2xl text-xs leading-relaxed text-muted">{t.sync.rebuild.desc}</p>

        <Textarea
          rows={3}
          placeholder="U906023D, IE7002, CT8012-047…"
          value={text}
          onChange={(e) => setText(e.target.value)}
        />
        <div className="flex flex-wrap items-center gap-2">
          <span className="text-xs text-muted tnum">{t.importPage.parsed(skus.length)}</span>
          {previewSkus.length > 0 && (
            <button
              type="button"
              className="text-xs font-medium text-accent-text underline-offset-2 hover:underline"
              onClick={() => setText(previewSkus.join("\n"))}
            >
              {t.sync.rebuild.usePreview(previewSkus.length)}
            </button>
          )}
          <div className="ml-auto flex items-center gap-2">
            <Button
              type="button"
              variant="outline"
              onClick={() => run(true)}
              disabled={disabled || skus.length === 0 || running != null}
            >
              {running === "dry" ? t.sync.apply.dryRunning : t.sync.apply.dryRun}
            </Button>
            <Button
              type="button"
              variant="accent"
              className="bg-skip text-white hover:bg-skip/90"
              onClick={() => run(false)}
              disabled={disabled || !dryValid || !ack || rebuildable === 0 || running != null}
              title={dryValid ? undefined : t.sync.apply.needDryRun}
            >
              {running === "live" ? t.sync.rebuild.rebuilding : t.sync.rebuild.rebuild(rebuildable)}
            </Button>
          </div>
        </div>

        {dryValid && (
          <label className="flex cursor-pointer items-start gap-2 text-xs font-medium text-skip">
            <input
              type="checkbox"
              className="mt-0.5 h-3.5 w-3.5 accent-current"
              checked={ack}
              onChange={(e) => setAck(e.target.checked)}
            />
            {t.sync.rebuild.ack}
          </label>
        )}

        {error && <p className="text-sm text-skip">{error}</p>}

        {report && (
          <div className="space-y-1 rounded-lg border border-line bg-surface-2 p-3 text-xs animate-fade-up">
            <div className="font-semibold">
              {report.dryRun
                ? t.sync.rebuild.dryTitle(report.products.length)
                : t.sync.rebuild.doneTitle(report.created, report.deleted, report.failedProducts)}
            </div>
            <ul className="divide-y divide-line/60">
              {report.products.map((p) => (
                <li key={p.sku} className="flex flex-wrap items-center gap-x-3 gap-y-0.5 py-1.5 tnum">
                  <span className="font-mono">{p.sku}</span>
                  {p.error ? (
                    <span className="text-skip">{p.error}</span>
                  ) : (
                    <>
                      <span>{t.sync.rebuild.line(p.oldCount, p.newSizes.length)}</span>
                      <span className="text-faint">{t.sync.rebuild.carried(p.carried)}</span>
                      {p.droppedOldSizes.length > 0 && (
                        <span className="text-warn" title={p.droppedOldSizes.join(", ")}>
                          {t.sync.rebuild.dropped(p.droppedOldSizes.length)}
                        </span>
                      )}
                      {p.unpricedSizes.length > 0 && (
                        <span className="text-faint">{t.sync.rebuild.unpriced(p.unpricedSizes.length)}</span>
                      )}
                      <span className="ml-auto text-faint">{p.newSizes.join(" · ")}</span>
                    </>
                  )}
                </li>
              ))}
            </ul>
          </div>
        )}
      </div>
    </details>
  );
}
