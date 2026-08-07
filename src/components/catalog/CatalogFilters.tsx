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
  brands,
}: {
  /** Current URL params — the base every update merges over. */
  params: QueryParams;
  /** Brands present in the market — the (demoted) brand filter's options. */
  brands: { brand: string; count: number }[];
}) {
  const { t } = useI18n();
  const router = useRouter();
  const timer = React.useRef<ReturnType<typeof setTimeout> | null>(null);
  const [isPending, startTransition] = React.useTransition();

  // Local echo of the text inputs so typing stays responsive between debounces.
  const [q, setQ] = React.useState(String(params.q ?? ""));
  const [min, setMin] = React.useState(String(params.min ?? ""));
  const [max, setMax] = React.useState(String(params.max ?? ""));

  React.useEffect(() => () => {
    if (timer.current) clearTimeout(timer.current);
  }, []);

  function push(updates: QueryParams) {
    // Merge over the LIVE URL, not the render-time `params` prop: a debounced
    // push fires up to 350ms after the keystroke, and by then the user may
    // have clicked a provider tab or another link — a stale base would
    // silently revert that navigation. window.location updates synchronously
    // at navigation start, unlike the prop (stale until the RSC payload lands).
    const current: QueryParams = Object.fromEntries(
      new URLSearchParams(window.location.search).entries(),
    );
    // Inside a transition so the current grid stays interactive and we can
    // show a pending spinner instead of a frozen page.
    startTransition(() => {
      router.replace(`/catalog${mergeQuery(current, { ...updates, page: undefined })}`, {
        scroll: false,
      });
    });
  }

  function pushDebounced(updates: QueryParams) {
    if (timer.current) clearTimeout(timer.current);
    timer.current = setTimeout(() => push(updates), DEBOUNCE_MS);
  }

  // The provider tab (owner) is navigation, not a filter — clearing keeps it.
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
        aria-label={t.discovery.brands}
        className={SELECT_CLASSES}
        value={String(params.brand ?? "")}
        onChange={(e) => push({ brand: e.target.value || undefined })}
      >
        <option value="">{t.discovery.allBrands}</option>
        {brands.map((b) => (
          <option key={b.brand} value={b.brand}>
            {b.brand} ({b.count})
          </option>
        ))}
      </select>

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
        {isPending && (
          <span
            aria-hidden="true"
            className="spin h-3.5 w-3.5 rounded-full border-2 border-line-strong border-t-accent-strong"
          />
        )}
        {hasFilters && (
          <button
            type="button"
            className="text-xs font-medium text-muted underline-offset-2 hover:text-ink hover:underline"
            onClick={() => {
              // A pending debounced push would resurrect the cleared filters.
              if (timer.current) {
                clearTimeout(timer.current);
                timer.current = null;
              }
              setQ("");
              setMin("");
              setMax("");
              // Through push(): keeps owner/market/sort (navigation state, not
              // filters) and shows the pending spinner like every other control.
              push({
                q: undefined,
                fresh: undefined,
                min: undefined,
                max: undefined,
                brand: undefined,
              });
            }}
          >
            {t.discovery.clearFilters}
          </button>
        )}
        <select
          aria-label={t.discovery.sortLabel}
          className={cn(SELECT_CLASSES, "font-medium")}
          value={String(params.sort ?? "added")}
          onChange={(e) => push({ sort: e.target.value === "added" ? undefined : e.target.value })}
        >
          <option value="added">{t.discovery.sort.added}</option>
          <option value="brand">{t.discovery.sort.brand}</option>
          <option value="title">{t.discovery.sort.title}</option>
          <option value="fetched">{t.discovery.sort.fetched}</option>
          <option value="priceAsc">{t.discovery.sort.priceAsc}</option>
          <option value="priceDesc">{t.discovery.sort.priceDesc}</option>
        </select>
      </div>
    </div>
  );
}
