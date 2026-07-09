"use client";

import * as React from "react";
import { listCatalog, type CatalogListResult } from "@/server/actions/catalog";
import { filterCatalog } from "@/lib/catalog";
import { useI18n } from "@/i18n/provider";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";

// The catalog can hold thousands of SKUs; render a slice (copy still gets all).
const VISIBLE_CAP = 500;

/**
 * A self-contained section for discovering the KicksDB catalog: the SKUs verified
 * fetchable on KicksDB (the ever-increasing known-good set). Loads on demand,
 * filters client-side, and copies the SKU list — independent of the store snapshot.
 */
export function CatalogPanel({ defaultMarket }: { defaultMarket: string }) {
  const { t } = useI18n();
  const [market, setMarket] = React.useState(defaultMarket);
  const [pending, start] = React.useTransition();
  const [error, setError] = React.useState<string | null>(null);
  const [loaded, setLoaded] = React.useState<CatalogListResult | null>(null);
  const [filter, setFilter] = React.useState("");
  const [copied, setCopied] = React.useState(false);

  function load() {
    setError(null);
    start(async () => {
      const res = await listCatalog({ market });
      if (!res.ok) {
        setError(res.error ?? t.catalog.failed);
        setLoaded(null);
        return;
      }
      setFilter("");
      setLoaded(res);
    });
  }

  const filtered = loaded ? filterCatalog(loaded.items, filter) : [];
  const visible = filtered.slice(0, VISIBLE_CAP);

  async function copy() {
    try {
      await navigator.clipboard.writeText(filtered.map((i) => i.sku).join("\n"));
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch {
      /* clipboard blocked — no-op */
    }
  }

  return (
    <div className="rounded-xl border border-line bg-surface p-4 shadow-xs">
      <div className="flex flex-wrap items-center gap-3">
        <span className="grid h-9 w-9 shrink-0 place-items-center rounded-lg bg-accent/15 text-accent-text">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" className="h-[18px] w-[18px]">
            <ellipse cx="12" cy="5" rx="8" ry="3" />
            <path d="M4 5v6c0 1.7 3.6 3 8 3s8-1.3 8-3V5M4 11v6c0 1.7 3.6 3 8 3s8-1.3 8-3v-6" />
          </svg>
        </span>
        <div className="min-w-0">
          <div className="text-sm font-semibold">{t.catalog.title}</div>
          <div className="text-xs text-muted">{t.catalog.desc}</div>
        </div>
        <div className="ml-auto flex items-center gap-2">
          <Input
            aria-label={t.catalog.market}
            className="w-20"
            value={market}
            onChange={(e) => setMarket(e.target.value.toUpperCase())}
          />
          <Button type="button" variant="accent" onClick={load} disabled={pending}>
            {pending ? (
              <>
                <span className="spin h-4 w-4 rounded-full border-2 border-accent-fg/30 border-t-accent-fg" />
                {t.catalog.loading}
              </>
            ) : loaded ? (
              t.catalog.refresh
            ) : (
              t.catalog.load
            )}
          </Button>
        </div>
      </div>

      {error && <p className="mt-2 text-sm text-skip">{error}</p>}

      {loaded && (
        <div className="mt-3 space-y-2 border-t border-line pt-3 animate-fade-up">
          <div className="flex flex-wrap items-center gap-2">
            <span className="text-sm font-semibold tnum">{t.catalog.total(loaded.total)}</span>
            <span className="text-line-strong">·</span>
            <span className="text-xs text-faint">{loaded.market}</span>
            <Button
              type="button"
              variant="outline"
              size="sm"
              onClick={copy}
              disabled={filtered.length === 0}
              className="ml-auto"
            >
              {copied ? t.catalog.copied : t.catalog.copy(filtered.length)}
            </Button>
          </div>

          {loaded.total === 0 ? (
            <p className="text-sm text-muted">{t.catalog.empty}</p>
          ) : (
            <>
              <Input
                placeholder={t.catalog.filterPlaceholder}
                value={filter}
                onChange={(e) => setFilter(e.target.value)}
              />
              <div className="max-h-80 overflow-auto rounded-lg border border-line bg-surface-2">
                <ul className="divide-y divide-line/60 text-sm">
                  {visible.map((i) => (
                    <li key={i.sku} className="flex items-center gap-3 px-3 py-1.5">
                      <span className="shrink-0 font-mono text-xs">{i.sku}</span>
                      {(i.title || i.brand) && (
                        <span className="min-w-0 flex-1 truncate text-right text-xs text-faint">
                          {[i.title, i.brand].filter(Boolean).join(" · ")}
                        </span>
                      )}
                    </li>
                  ))}
                </ul>
              </div>
              {filtered.length > VISIBLE_CAP && (
                <p className="text-xs text-faint">{t.catalog.shown(visible.length, filtered.length)}</p>
              )}
            </>
          )}
        </div>
      )}
    </div>
  );
}
