"use client";

import * as React from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { useI18n } from "@/i18n/provider";
import { refreshCatalogProduct } from "@/server/actions/catalog";
import { setProductSaleRule, setVariationManualPrice } from "@/server/actions/overrides";
import { CardImage } from "./CardImage";
import type { DrawerData, DrawerVariant } from "./drawer-data";

const eur = new Intl.NumberFormat("it-IT", { style: "currency", currency: "EUR" });

/**
 * The product detail drawer: a slide-over on desktop, a full-screen sheet on
 * mobile. Opened via the ?product= query param (deep-linkable; back closes it).
 * CRUD lives here: re-sync from KicksDB, per-size manual price locks, and the
 * product's sale-rule choice — all through the existing snapshot-independent
 * override actions, so the Woo sync honors them automatically.
 */
export function ProductDrawer({ data, closeHref }: { data: DrawerData; closeHref: string }) {
  const { t } = useI18n();
  const router = useRouter();
  const [refreshing, startRefresh] = React.useTransition();
  const [savingRule, startRule] = React.useTransition();
  const [error, setError] = React.useState<string | null>(null);
  const [copied, setCopied] = React.useState(false);

  const close = React.useCallback(() => {
    router.push(closeHref, { scroll: false });
  }, [router, closeHref]);

  React.useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") close();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [close]);

  function resync() {
    setError(null);
    startRefresh(async () => {
      const res = await refreshCatalogProduct({ market: data.market, sku: data.sku });
      if (!res.ok) setError(res.error ?? t.drawer.refreshFailed);
      else router.refresh();
    });
  }

  function toggleSaleRule() {
    setError(null);
    startRule(async () => {
      const res = await setProductSaleRule({ sku: data.sku, followSaleRule: !data.followSaleRule });
      if (!res.ok) setError(res.error ?? t.drawer.saveFailed);
      else router.refresh();
    });
  }

  async function copySku() {
    try {
      await navigator.clipboard.writeText(data.sku);
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch {
      /* clipboard blocked — no-op */
    }
  }

  const fetchedAgo = daysAgo(data.fetchedAt);

  return (
    <div className="fixed inset-0 z-40" role="dialog" aria-modal="true" aria-label={data.title || data.sku}>
      {/* Backdrop */}
      <button
        type="button"
        aria-label={t.drawer.close}
        className="absolute inset-0 bg-black/40 backdrop-blur-[2px]"
        onClick={close}
      />

      {/* Panel: full-screen on mobile, right slide-over on ≥sm */}
      <div className="absolute inset-y-0 right-0 flex w-full flex-col overflow-y-auto border-l border-line bg-bg shadow-2xl animate-fade-up sm:max-w-lg">
        {/* Sticky header with close — critical on mobile where the sheet is full-screen. */}
        <div className="sticky top-0 z-10 flex items-center gap-3 border-b border-line bg-bg/90 px-4 py-3 backdrop-blur-md">
          <div className="min-w-0 flex-1">
            <div className="truncate text-sm font-semibold">{data.title || data.sku}</div>
            <div className="flex items-center gap-2 text-[11px] text-faint">
              <span className="uppercase tracking-wide">{data.brand || "—"}</span>
              <span>·</span>
              <button type="button" onClick={copySku} className="font-mono hover:text-ink" title={t.drawer.copySku}>
                {copied ? t.catalog.copied : data.sku}
              </button>
            </div>
          </div>
          <Button type="button" variant="outline" size="sm" onClick={close}>
            {t.drawer.close}
          </Button>
        </div>

        <div className="space-y-4 p-4">
          {/* Product header */}
          <div className="flex gap-4">
            <div className="w-28 shrink-0 overflow-hidden rounded-lg border border-line sm:w-36">
              <CardImage src={data.image} alt={data.title || data.sku} />
            </div>
            <div className="min-w-0 flex-1 space-y-1 text-xs text-muted">
              <div className="flex flex-wrap items-center gap-1.5">
                <span
                  className={`inline-flex items-center gap-1.5 rounded-full px-2 py-0.5 text-[11px] font-medium ${
                    data.fresh ? "bg-up/12 text-up" : "bg-skip/12 text-skip"
                  }`}
                >
                  <span className={`h-1.5 w-1.5 rounded-full ${data.fresh ? "bg-up" : "bg-skip"}`} />
                  {data.fresh ? t.discovery.freshBadge : t.discovery.staleBadge}
                </span>
                <span className="text-faint">{data.market}</span>
                {data.owner === "goldensneakers" && (
                  <span
                    className="inline-flex items-center gap-1 rounded-full bg-warn/15 px-2 py-0.5 text-[11px] font-semibold text-warn"
                    title={t.drawer.gsOwnedHint}
                  >
                    {t.drawer.gsOwned}
                  </span>
                )}
              </div>
              <div>{t.drawer.fetchedAgo(fetchedAgo)}</div>
              <div>{t.drawer.addedOn(new Date(data.addedAt).toLocaleDateString())}</div>
              <div className="truncate font-mono text-[10px] text-faint" title={data.stockxId}>
                {data.stockxId}
              </div>
            </div>
          </div>

          {/* Operations */}
          <div className="flex flex-wrap items-center gap-2 rounded-xl border border-line bg-surface p-3">
            <Button type="button" variant="accent" size="sm" onClick={resync} disabled={refreshing}>
              {refreshing ? (
                <>
                  <span className="spin h-3.5 w-3.5 rounded-full border-2 border-accent-fg/30 border-t-accent-fg" />
                  {t.drawer.refreshing}
                </>
              ) : (
                t.drawer.refresh
              )}
            </Button>
            <label className="flex cursor-pointer items-center gap-2 text-xs font-medium text-muted" title={t.product.saleRuleHint}>
              <input
                type="checkbox"
                className="h-3.5 w-3.5 accent-current"
                checked={data.followSaleRule}
                disabled={savingRule}
                onChange={toggleSaleRule}
              />
              {t.product.saleRule}
            </label>
            <Link
              href={`/sync?skus=${encodeURIComponent(data.sku)}`}
              className="ml-auto text-xs font-semibold text-accent-text underline-offset-2 hover:underline"
            >
              {t.drawer.syncThis} →
            </Link>
          </div>

          {error && <p className="text-sm text-skip">{error}</p>}

          {/* Variant rows (stacked — readable on a phone, no wide table) */}
          <div className="overflow-hidden rounded-xl border border-line bg-surface">
            <div className="grid grid-cols-[1fr_auto_auto_auto] items-center gap-x-3 border-b border-line bg-surface-2 px-3 py-2 text-[11px] font-semibold uppercase tracking-wide text-faint">
              <span>{t.product.headerSize}</span>
              <span className="text-right">{t.drawer.headerAsk}</span>
              <span className="text-right">{t.product.headerProposed}</span>
              <span className="text-right">{t.product.headerManual}</span>
            </div>
            <ul className="divide-y divide-line/60">
              {data.variants.map((v) => (
                <VariantRow key={v.id} data={data} variant={v} onSaved={() => router.refresh()} />
              ))}
            </ul>
          </div>
        </div>
      </div>
    </div>
  );
}

function VariantRow({
  data,
  variant,
  onSaved,
}: {
  data: DrawerData;
  variant: DrawerVariant;
  onSaved: () => void;
}) {
  const { t } = useI18n();
  const [editing, setEditing] = React.useState(false);
  const [value, setValue] = React.useState(variant.manual != null ? String(variant.manual) : "");
  const [saving, startSaving] = React.useTransition();
  const canLock = variant.euSize != null;

  function save(price: number | null) {
    if (!variant.euSize) return;
    startSaving(async () => {
      const res = await setVariationManualPrice({
        parentSku: data.sku,
        euSize: variant.euSize!,
        price,
      });
      if (res.ok) {
        setEditing(false);
        onSaved();
      }
    });
  }

  const sizeLabel = variant.euSize
    ? t.product.eu(variant.euSize)
    : `${variant.sizeLabel} ${variant.sizeType}`;

  return (
    <li className="grid grid-cols-[1fr_auto_auto_auto] items-center gap-x-3 px-3 py-2 text-sm">
      <div className="min-w-0">
        <div className="font-medium tnum">{sizeLabel}</div>
        {variant.upc && (
          <div className="truncate font-mono text-[10px] text-faint" title={variant.upc}>
            {variant.upc}
          </div>
        )}
      </div>

      <div className="text-right tnum">
        {variant.ask != null ? (
          <>
            <div>{eur.format(variant.ask)}</div>
            <div className={`text-[10px] ${data.owner === "goldensneakers" && variant.asks === 0 ? "text-skip" : "text-faint"}`}>
              {data.owner === "goldensneakers" ? t.drawer.qty(variant.asks) : t.drawer.asks(variant.asks)}
            </div>
          </>
        ) : (
          <span className="text-faint">—</span>
        )}
      </div>

      <div className="text-right font-semibold tnum">
        {variant.proposed != null ? eur.format(variant.proposed) : <span className="font-normal text-faint">—</span>}
      </div>

      <div className="flex items-center justify-end gap-1">
        {!canLock ? (
          <span className="text-faint">—</span>
        ) : editing ? (
          <form
            className="flex items-center gap-1"
            onSubmit={(e) => {
              e.preventDefault();
              const n = Number.parseFloat(value.replace(",", "."));
              if (Number.isFinite(n) && n > 0) save(n);
            }}
          >
            <Input
              autoFocus
              inputMode="decimal"
              className="h-7 w-20 text-right text-xs"
              placeholder={t.product.manualPlaceholder}
              value={value}
              onChange={(e) => setValue(e.target.value)}
            />
            <Button type="submit" size="sm" variant="accent" disabled={saving} className="h-7 px-2 text-xs">
              {saving ? t.product.saving : t.product.manualLock}
            </Button>
          </form>
        ) : variant.manual != null ? (
          <button
            type="button"
            className="rounded-md bg-accent/12 px-2 py-0.5 text-xs font-semibold text-accent-text tnum hover:bg-accent/20"
            title={t.product.manualClear}
            onClick={() => (saving ? undefined : save(null))}
          >
            {eur.format(variant.manual)} ✕
          </button>
        ) : (
          <button
            type="button"
            className="text-xs font-medium text-muted underline-offset-2 hover:text-ink hover:underline"
            onClick={() => {
              setValue(variant.proposed != null ? String(variant.proposed) : "");
              setEditing(true);
            }}
          >
            {t.product.manualLock}
          </button>
        )}
      </div>
    </li>
  );
}

function daysAgo(iso: string): number {
  return Math.max(0, Math.floor((Date.now() - new Date(iso).getTime()) / 86_400_000));
}
