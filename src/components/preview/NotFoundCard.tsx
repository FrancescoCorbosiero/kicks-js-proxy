"use client";

import * as React from "react";
import { useI18n } from "@/i18n/provider";
import { Button } from "@/components/ui/button";

interface Props {
  foundSkus: string[]; // the actual KicksDB products (clean list, without the misses)
  notFound: string[]; // SKUs from the file that aren't fetchable on StockX
}

/**
 * Replaces the old "Non trovati su StockX: <giant comma list>" banner: a compact
 * card with the counts and copy buttons, so a 1000-SKU file doesn't dump hundreds
 * of codes into the page.
 */
export function NotFoundCard({ foundSkus, notFound }: Props) {
  const { t } = useI18n();
  const [copied, setCopied] = React.useState<"clean" | "missing" | null>(null);

  async function copy(which: "clean" | "missing", list: string[]) {
    try {
      await navigator.clipboard.writeText(list.join("\n"));
      setCopied(which);
      setTimeout(() => setCopied((c) => (c === which ? null : c)), 1500);
    } catch {
      /* clipboard blocked — no-op */
    }
  }

  return (
    <div className="rounded-xl border border-warn/25 bg-warn/[0.06] p-4 shadow-xs animate-fade-up">
      <div className="flex flex-wrap items-center gap-3">
        <span className="grid h-9 w-9 shrink-0 place-items-center rounded-lg bg-warn/15 text-warn">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" className="h-[18px] w-[18px]">
            <path d="M12 9v4m0 4h.01M10.3 3.9 1.8 18a2 2 0 0 0 1.7 3h17a2 2 0 0 0 1.7-3L13.7 3.9a2 2 0 0 0-3.4 0Z" />
          </svg>
        </span>
        <div className="min-w-0">
          <div className="text-sm font-semibold">{t.results.notFoundCard.title}</div>
          <div className="text-xs text-muted">{t.results.notFoundCard.desc}</div>
        </div>
        <div className="ml-auto flex items-center gap-2 text-xs font-medium tnum">
          <span className="rounded-md border border-line bg-surface px-2 py-0.5 text-down">
            {t.results.notFoundCard.found(foundSkus.length)}
          </span>
          <span className="rounded-md border border-warn/30 bg-warn/10 px-2 py-0.5 text-warn">
            {t.results.notFoundCard.missing(notFound.length)}
          </span>
        </div>
      </div>

      <div className="mt-3 flex flex-wrap items-center gap-2 border-t border-warn/20 pt-3">
        <Button
          type="button"
          variant="outline"
          size="sm"
          onClick={() => copy("clean", foundSkus)}
          disabled={foundSkus.length === 0}
        >
          {copied === "clean" ? t.results.notFoundCard.copied : t.results.notFoundCard.copyClean(foundSkus.length)}
        </Button>
        <Button
          type="button"
          variant="outline"
          size="sm"
          onClick={() => copy("missing", notFound)}
          disabled={notFound.length === 0}
        >
          {copied === "missing" ? t.results.notFoundCard.copied : t.results.notFoundCard.copyMissing(notFound.length)}
        </Button>
      </div>
    </div>
  );
}
