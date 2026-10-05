"use client";

import * as React from "react";
import { useRouter, useSearchParams } from "next/navigation";
import { useI18n } from "@/i18n/provider";
import { loadCatalogDrawer } from "@/server/actions/catalog";
import { Button } from "@/components/ui/button";
import { ProductDrawer } from "./ProductDrawer";

/**
 * The catalog's product drawer, opened WITHOUT a page navigation.
 *
 * It used to be a server render: clicking a card navigated to ?product=, and
 * the whole catalog page — grid, counts, category tree — was rebuilt on the
 * server just to add the drawer; again on close; again after every lock or
 * price edit. Now the card only updates the URL (native history, which Next
 * keeps in sync with useSearchParams), the drawer opens at once on a skeleton
 * and fetches its own data. ?product= still deep-links and Back still closes.
 *
 * Edits reload the drawer alone; the grid behind it is refreshed once, when
 * the drawer closes, and only if something was saved.
 */

type Loaded = Awaited<ReturnType<typeof loadCatalogDrawer>>;

/** The current catalog URL with ?product= set or removed. */
function urlWithProduct(sku: string | null): string {
  const url = new URL(window.location.href);
  if (sku) url.searchParams.set("product", sku);
  else url.searchParams.delete("product");
  return `${url.pathname}${url.search}`;
}

/**
 * A grid card that opens the drawer in place. A real link underneath, so a
 * middle-click or ⌘-click still opens the product in a new tab.
 */
export function ProductCardLink({
  sku,
  href,
  className,
  children,
}: {
  sku: string;
  href: string;
  className?: string;
  children: React.ReactNode;
}) {
  return (
    <a
      href={href}
      className={className}
      onClick={(e) => {
        if (e.defaultPrevented || e.button !== 0 || e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) return;
        e.preventDefault();
        window.history.pushState(null, "", urlWithProduct(sku));
      }}
    >
      {children}
    </a>
  );
}

export function CatalogDrawerHost({ market }: { market: string }) {
  const router = useRouter();
  const sku = useSearchParams().get("product");
  const [loaded, setLoaded] = React.useState<{ sku: string; result: Loaded } | null>(null);
  // Only the latest request may land: a quick second click wins.
  const latest = React.useRef(0);
  // Something was saved while the drawer was open: the grid is stale.
  const gridStale = React.useRef(false);

  const load = React.useCallback(
    async (target: string) => {
      const id = ++latest.current;
      let result: Loaded;
      try {
        result = await loadCatalogDrawer({ market, sku: target });
      } catch (e) {
        result = { ok: false, error: e instanceof Error ? e.message : String(e) };
      }
      if (id === latest.current) setLoaded({ sku: target, result });
    },
    [market],
  );

  React.useEffect(() => {
    if (sku) {
      void load(sku);
    } else if (gridStale.current) {
      // Closed (button, Escape or Back) after an edit: one grid refresh, now.
      gridStale.current = false;
      router.refresh();
    }
  }, [sku, load, router]);

  const close = React.useCallback(() => {
    window.history.pushState(null, "", urlWithProduct(null));
  }, []);

  if (!sku) return null;

  const current = loaded?.sku === sku ? loaded.result : null;
  if (current == null) return <DrawerShell sku={sku} onClose={close} loading />;
  if (!current.ok) return <DrawerShell sku={sku} onClose={close} error={current.error} />;
  if (current.data == null) return <DrawerShell sku={sku} onClose={close} />;

  return (
    <ProductDrawer
      key={sku}
      data={current.data}
      onClose={close}
      onChanged={() => {
        gridStale.current = true;
        void load(sku);
      }}
    />
  );
}

/** The drawer's frame while it loads, or when the product can't be shown. */
function DrawerShell({
  sku,
  onClose,
  loading,
  error,
}: {
  sku: string;
  onClose: () => void;
  loading?: boolean;
  error?: string;
}) {
  const { t } = useI18n();

  React.useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  const title = loading ? sku : error ? t.drawer.loadFailed : t.drawer.notFoundTitle;

  return (
    <div className="fixed inset-0 z-40" role="dialog" aria-modal="true" aria-label={title} aria-busy={loading}>
      <button
        type="button"
        aria-label={t.drawer.close}
        className="absolute inset-0 bg-black/40 backdrop-blur-[2px]"
        onClick={onClose}
      />
      <div className="absolute inset-y-0 right-0 flex w-full flex-col border-l border-line bg-bg shadow-2xl animate-fade-up sm:max-w-lg">
        <div className="flex items-center gap-3 border-b border-line px-4 py-3">
          <div className="min-w-0 flex-1">
            {loading ? (
              <div className="shimmer h-4 w-48 rounded bg-surface-2" />
            ) : (
              <div className="truncate text-sm font-semibold">{title}</div>
            )}
            <div className="mt-1 truncate font-mono text-[11px] text-faint">{sku}</div>
          </div>
          <Button type="button" variant="outline" size="sm" onClick={onClose}>
            {t.drawer.close}
          </Button>
        </div>
        {loading ? (
          <div className="space-y-4 p-4">
            <div className="flex gap-4">
              <div className="shimmer aspect-square w-28 shrink-0 rounded-lg bg-surface-2 sm:w-36" />
              <div className="flex-1 space-y-2 pt-1">
                <div className="shimmer h-3 w-24 rounded bg-surface-2" />
                <div className="shimmer h-3 w-40 rounded bg-surface-2" />
                <div className="shimmer h-3 w-32 rounded bg-surface-2" />
              </div>
            </div>
            <div className="shimmer h-14 rounded-xl bg-surface-2" />
            <div className="shimmer h-72 rounded-xl bg-surface-2" />
          </div>
        ) : (
          <p className="p-4 text-sm leading-relaxed text-muted">{error ?? t.drawer.notFoundBody}</p>
        )}
      </div>
    </div>
  );
}
