"use client";

import * as React from "react";
import { useRouter } from "next/navigation";
import { Input } from "@/components/ui/input";
import { useI18n } from "@/i18n/provider";
import { mergeQuery, type QueryParams } from "@/lib/qs";
import { cn } from "@/lib/utils";

const DEBOUNCE_MS = 350;

const SELECT_CLASSES =
  "h-9 rounded-md border border-line bg-surface px-2.5 text-sm text-ink shadow-xs outline-none focus-visible:ring-2 focus-visible:ring-accent/40";

/**
 * The discovery filter bar. The URL is the source of truth: every change is
 * pushed as a query-string update (text/number inputs debounced, selects
 * immediate) and the server re-renders the grid. Changing any filter resets
 * the page cursor.
 */
export function CatalogFilters({
  params,
}: {
  /** Current URL params — the base every update merges over. */
  params: QueryParams;
}) {
  const { t } = useI18n();
  const router = useRouter();
  const timer = React.useRef<ReturnType<typeof setTimeout> | null>(null);

  // Local echo of the text inputs so typing stays responsive between debounces.
  const [q, setQ] = React.useState(String(params.q ?? ""));
  const [min, setMin] = React.useState(String(params.min ?? ""));
  const [max, setMax] = React.useState(String(params.max ?? ""));

  React.useEffect(() => () => {
    if (timer.current) clearTimeout(timer.current);
  }, []);

  function push(updates: QueryParams) {
    router.replace(`/catalog${mergeQuery(params, { ...updates, page: undefined })}`, {
      scroll: false,
    });
  }

  function pushDebounced(updates: QueryParams) {
    if (timer.current) clearTimeout(timer.current);
    timer.current = setTimeout(() => push(updates), DEBOUNCE_MS);
  }

  const hasFilters = !!(params.q || params.fresh || params.min || params.max || params.brand);

  return (
    <div className="flex flex-wrap items-center gap-2">
      <Input
        aria-label={t.discovery.searchPlaceholder}
        placeholder={t.discovery.searchPlaceholder}
        className="w-full sm:w-64"
        value={q}
        onChange={(e) => {
          setQ(e.target.value);
          pushDebounced({ q: e.target.value.trim() || undefined });
        }}
      />

      <select
        aria-label={t.discovery.freshnessLabel}
        className={SELECT_CLASSES}
        value={String(params.fresh ?? "all")}
        onChange={(e) => push({ fresh: e.target.value === "all" ? undefined : e.target.value })}
      >
        <option value="all">{t.discovery.freshness.all}</option>
        <option value="fresh">{t.discovery.freshness.fresh}</option>
        <option value="stale">{t.discovery.freshness.stale}</option>
      </select>

      <Input
        aria-label={t.discovery.priceMin}
        placeholder={t.discovery.priceMin}
        inputMode="numeric"
        className="w-20"
        value={min}
        onChange={(e) => {
          setMin(e.target.value);
          pushDebounced({ min: e.target.value.trim() || undefined });
        }}
      />
      <Input
        aria-label={t.discovery.priceMax}
        placeholder={t.discovery.priceMax}
        inputMode="numeric"
        className="w-20"
        value={max}
        onChange={(e) => {
          setMax(e.target.value);
          pushDebounced({ max: e.target.value.trim() || undefined });
        }}
      />

      <div className="ml-auto flex items-center gap-2">
        {hasFilters && (
          <button
            type="button"
            className="text-xs font-medium text-muted underline-offset-2 hover:text-ink hover:underline"
            onClick={() => {
              setQ("");
              setMin("");
              setMax("");
              router.replace("/catalog", { scroll: false });
            }}
          >
            {t.discovery.clearFilters}
          </button>
        )}
        <select
          aria-label={t.discovery.sortLabel}
          className={cn(SELECT_CLASSES, "font-medium")}
          value={String(params.sort ?? "brand")}
          onChange={(e) => push({ sort: e.target.value === "brand" ? undefined : e.target.value })}
        >
          <option value="brand">{t.discovery.sort.brand}</option>
          <option value="title">{t.discovery.sort.title}</option>
          <option value="added">{t.discovery.sort.added}</option>
          <option value="fetched">{t.discovery.sort.fetched}</option>
          <option value="priceAsc">{t.discovery.sort.priceAsc}</option>
          <option value="priceDesc">{t.discovery.sort.priceDesc}</option>
        </select>
      </div>
    </div>
  );
}
