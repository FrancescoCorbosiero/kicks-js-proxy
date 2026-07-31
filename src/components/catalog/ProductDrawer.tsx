"use client";

import * as React from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { useI18n } from "@/i18n/provider";
import { refreshCatalogProduct } from "@/server/actions/catalog";
import {
  setProductManualPrices,
  setProductOwnerPin,
  setProductSaleRule,
  setVariationManualPrice,
} from "@/server/actions/overrides";
import { updateStoreVariation } from "@/server/actions/store-edit";
import { LockIcon, UnlockIcon } from "@/components/icons";
import { CardImage } from "./CardImage";
import type { DrawerData, DrawerVariant, StoreDrawerVariant } from "./drawer-data";

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
  const [bulkSaving, startBulk] = React.useTransition();
  const [error, setError] = React.useState<string | null>(null);
  const [copied, setCopied] = React.useState(false);

  // Bulk lock targets: sizes with a stable EU key and a COMPUTED price to lock
  // at. Never fall back to the raw ask — that's the source cost, not a shelf
  // price, and locking it would silently sell at no markup.
  const lockable = data.variants.filter(
    (v) => v.euSize != null && v.manual == null && v.proposed != null,
  );
  const locked = data.variants.filter((v) => v.euSize != null && v.manual != null);

  function lockAll() {
    if (lockable.length === 0) return;
    setError(null);
    startBulk(async () => {
      const res = await setProductManualPrices({
        parentSku: data.sku,
        prices: lockable.map((v) => ({ euSize: v.euSize!, price: v.proposed! })),
      });
      if (!res.ok) setError(res.error ?? t.drawer.saveFailed);
      else router.refresh();
    });
  }

  function unlockAll() {
    if (locked.length === 0) return;
    setError(null);
    startBulk(async () => {
      const res = await setProductManualPrices({
        parentSku: data.sku,
        prices: locked.map((v) => ({ euSize: v.euSize!, price: null })),
      });
      if (!res.ok) setError(res.error ?? t.drawer.saveFailed);
      else router.refresh();
    });
  }

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

  const [pinSaving, startPin] = React.useTransition();

  function savePin(owner: "kicksdb" | null) {
    setError(null);
    startPin(async () => {
      const res = await setProductOwnerPin({ sku: data.sku, owner });
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
              <CardImage src={data.image} alt={data.title || data.sku} eager />
            </div>
            <div className="min-w-0 flex-1 space-y-1 text-xs text-muted">
              <div className="flex flex-wrap items-center gap-1.5">
                {data.owner !== "woo" && (
                  <span
                    className={`inline-flex items-center gap-1.5 rounded-full px-2 py-0.5 text-[11px] font-medium ${
                      data.fresh ? "bg-up/12 text-up" : "bg-skip/12 text-skip"
                    }`}
                  >
                    <span className={`h-1.5 w-1.5 rounded-full ${data.fresh ? "bg-up" : "bg-skip"}`} />
                    {data.fresh ? t.discovery.freshBadge : t.discovery.staleBadge}
                  </span>
                )}
                <span className="text-faint">{data.market}</span>
                {data.owner === "woo" && (
                  <span
                    className="inline-flex items-center gap-1 rounded-full border border-line bg-surface-2 px-2 py-0.5 text-[11px] font-semibold text-muted"
                    title={t.drawer.wooOwnedHint}
                  >
                    {t.drawer.wooOwned}
                  </span>
                )}
                {data.owner === "goldensneakers" && (
                  <span
                    className="inline-flex items-center gap-1 rounded-full border border-line bg-surface-2 px-2 py-0.5 text-[11px] font-semibold text-muted"
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

          {/* Operations — meaningless for store-only products (nothing to
              re-sync, no sale rule, no plan-based sync). */}
          {data.owner !== "woo" && (
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
          )}

          {/* Price source: who decides this product's prices. Only shown when
              the supplier feed actually covers the SKU, so the choice is real. */}
          {data.gsCovered && (
            <div className="flex flex-wrap items-center gap-2 rounded-xl border border-line bg-surface p-3">
              <div className="min-w-0 flex-1">
                <div className="text-xs font-semibold">{t.drawer.sourceTitle}</div>
                <p className="mt-0.5 text-[11px] leading-snug text-muted">
                  {data.pinnedToKicksdb ? t.drawer.sourceKicksdbHint : t.drawer.sourceGsHint}
                </p>
              </div>
              <div className="flex shrink-0 items-center gap-1 rounded-lg border border-line bg-surface-2 p-0.5">
                <button
                  type="button"
                  disabled={pinSaving}
                  onClick={() => data.pinnedToKicksdb && savePin(null)}
                  className={`rounded-md px-2.5 py-1 text-[11px] font-semibold transition-colors ${
                    !data.pinnedToKicksdb ? "bg-accent text-accent-fg shadow-xs" : "text-muted hover:text-ink"
                  }`}
                >
                  {t.drawer.sourceGs}
                </button>
                <button
                  type="button"
                  disabled={pinSaving}
                  onClick={() => !data.pinnedToKicksdb && savePin("kicksdb")}
                  className={`rounded-md px-2.5 py-1 text-[11px] font-semibold transition-colors ${
                    data.pinnedToKicksdb ? "bg-accent text-accent-fg shadow-xs" : "text-muted hover:text-ink"
                  }`}
                >
                  {t.drawer.sourceKicksdb}
                </button>
              </div>
            </div>
          )}

          {error && <p className="text-sm text-skip">{error}</p>}

          {/* Store-only products: the live store view, directly editable. */}
          {data.owner === "woo" && (
            <StorePanel data={data} onSaved={() => router.refresh()} onError={setError} />
          )}

          {/* Prices: per-size manual locks. The one panel a non-technical
              operator must understand, so it explains itself. */}
          {data.owner !== "woo" && (
          <div className="overflow-hidden rounded-xl border border-line bg-surface">
            <div className="flex flex-wrap items-center gap-2 border-b border-line px-3 py-2.5">
              <div className="min-w-0 flex-1">
                <div className="flex items-center gap-1.5 text-xs font-semibold">
                  <LockIcon className="h-3.5 w-3.5 text-accent-text" />
                  {t.drawer.pricesTitle}
                </div>
                <p className="mt-0.5 text-[11px] leading-snug text-muted">{t.drawer.lockExplain}</p>
              </div>
              <div className="flex shrink-0 items-center gap-1.5">
                <Button
                  type="button"
                  variant="outline"
                  size="sm"
                  className="h-7 gap-1 px-2 text-[11px]"
                  onClick={lockAll}
                  disabled={bulkSaving || lockable.length === 0}
                >
                  <LockIcon className="h-3 w-3" />
                  {t.drawer.lockAll(lockable.length)}
                </Button>
                {locked.length > 0 && (
                  <Button
                    type="button"
                    variant="ghost"
                    size="sm"
                    className="h-7 gap-1 px-2 text-[11px]"
                    onClick={unlockAll}
                    disabled={bulkSaving}
                  >
                    <UnlockIcon className="h-3 w-3" />
                    {t.drawer.unlockAll(locked.length)}
                  </Button>
                )}
              </div>
            </div>
            <div className="grid grid-cols-[1fr_auto_auto_auto] items-center gap-x-3 border-b border-line bg-surface-2 px-3 py-2 text-[11px] font-semibold uppercase tracking-wide text-faint">
              <span>{t.product.headerSize}</span>
              <span className="text-right">{t.drawer.headerAsk}</span>
              <span className="text-right">{t.product.headerProposed}</span>
              <span className="text-right">{t.product.headerManual}</span>
            </div>
            <ul className="divide-y divide-line/60">
              {data.variants.map((v) => (
                <VariantRow
                  key={v.id}
                  data={data}
                  variant={v}
                  onSaved={() => router.refresh()}
                  onError={(msg) => setError(msg)}
                />
              ))}
            </ul>
          </div>
          )}
        </div>
      </div>
    </div>
  );
}

/**
 * Store-only product panel: per-size shelf price + real stock from the live
 * snapshot, edited in place and written straight to WooCommerce.
 */
function StorePanel({
  data,
  onSaved,
  onError,
}: {
  data: DrawerData;
  onSaved: () => void;
  onError: (message: string) => void;
}) {
  const { t } = useI18n();

  if (!data.store) {
    return (
      <div className="rounded-xl border border-line bg-surface p-4 text-sm text-muted">
        {t.drawer.storeNoSnapshot}
      </div>
    );
  }

  return (
    <div className="overflow-hidden rounded-xl border border-line bg-surface">
      <div className="border-b border-line px-3 py-2.5">
        <div className="text-xs font-semibold">{t.drawer.storeTitle}</div>
        <p className="mt-0.5 text-[11px] leading-snug text-muted">{t.drawer.storeExplain}</p>
      </div>
      <div className="grid grid-cols-[1fr_auto_auto_auto] items-center gap-x-3 border-b border-line bg-surface-2 px-3 py-2 text-[11px] font-semibold uppercase tracking-wide text-faint">
        <span>{t.product.headerSize}</span>
        <span className="text-right">{t.drawer.storeHeaderPrice}</span>
        <span className="text-right">{t.drawer.storeHeaderStock}</span>
        <span />
      </div>
      <ul className="divide-y divide-line/60">
        {data.store.variants.map((v) => (
          <StoreVariantRow
            key={v.variationId}
            productId={data.store!.productId}
            variant={v}
            onSaved={onSaved}
            onError={onError}
          />
        ))}
      </ul>
    </div>
  );
}

function StoreVariantRow({
  productId,
  variant,
  onSaved,
  onError,
}: {
  productId: number;
  variant: StoreDrawerVariant;
  onSaved: () => void;
  onError: (message: string) => void;
}) {
  const { t } = useI18n();
  const [editing, setEditing] = React.useState(false);
  const [price, setPrice] = React.useState(variant.price != null ? String(variant.price) : "");
  const [stock, setStock] = React.useState(variant.stock != null ? String(variant.stock) : "");
  const [saving, startSaving] = React.useTransition();

  function save() {
    const p = price.trim() === "" ? undefined : Number.parseFloat(price.replace(",", "."));
    const s = stock.trim() === "" ? undefined : Number.parseInt(stock, 10);
    if (p !== undefined && (!Number.isFinite(p) || p <= 0)) return;
    if (s !== undefined && (!Number.isInteger(s) || s < 0)) return;
    if (p === undefined && s === undefined) {
      setEditing(false);
      return;
    }
    startSaving(async () => {
      const res = await updateStoreVariation({
        storeProductId: productId,
        variationId: variant.variationId,
        price: p,
        stock: s,
      });
      if (res.ok) {
        setEditing(false);
        onSaved();
      } else {
        onError(res.error ?? t.drawer.saveFailed);
      }
    });
  }

  if (editing) {
    return (
      <li className="flex flex-wrap items-center gap-2 px-3 py-2 text-sm">
        <span className="min-w-16 font-medium tnum">{variant.sizeLabel}</span>
        <form
          className="flex flex-1 flex-wrap items-center justify-end gap-1.5"
          onSubmit={(e) => {
            e.preventDefault();
            save();
          }}
        >
          <Input
            autoFocus
            inputMode="decimal"
            aria-label={t.drawer.storeHeaderPrice}
            className="h-7 w-24 text-right text-xs"
            placeholder={t.drawer.storeHeaderPrice}
            value={price}
            onChange={(e) => setPrice(e.target.value)}
          />
          <Input
            inputMode="numeric"
            aria-label={t.drawer.storeHeaderStock}
            className="h-7 w-16 text-right text-xs"
            placeholder={t.drawer.storeHeaderStock}
            value={stock}
            onChange={(e) => setStock(e.target.value)}
          />
          <Button type="submit" size="sm" variant="accent" disabled={saving} className="h-7 px-2 text-xs">
            {saving ? t.product.saving : t.drawer.storeSave}
          </Button>
          <button
            type="button"
            aria-label={t.product.manualCancel}
            className="rounded p-1 text-faint hover:text-ink"
            onClick={() => setEditing(false)}
          >
            ✕
          </button>
        </form>
      </li>
    );
  }

  return (
    <li className="grid grid-cols-[1fr_auto_auto_auto] items-center gap-x-3 px-3 py-2 text-sm">
      <span className="font-medium tnum">{variant.sizeLabel}</span>
      <span className="text-right tnum">
        {variant.price != null ? eur.format(variant.price) : <span className="text-faint">—</span>}
        {variant.saleActive && (
          <span className="ml-1 text-[10px] font-medium text-update">{t.drawer.storeSale}</span>
        )}
      </span>
      <span
        className={`text-right text-xs tnum ${variant.stock === 0 ? "text-skip" : "text-muted"}`}
        title={variant.stock == null ? t.drawer.storeUnmanagedHint : undefined}
      >
        {variant.stock != null ? t.drawer.qty(variant.stock) : "—"}
      </span>
      <div className="flex justify-end">
        <Button
          type="button"
          variant="outline"
          size="sm"
          className="h-7 px-2 text-[11px]"
          onClick={() => {
            setPrice(variant.price != null ? String(variant.price) : "");
            setStock(variant.stock != null ? String(variant.stock) : "");
            setEditing(true);
          }}
        >
          {t.drawer.storeEdit}
        </Button>
      </div>
    </li>
  );
}

function VariantRow({
  data,
  variant,
  onSaved,
  onError,
}: {
  data: DrawerData;
  variant: DrawerVariant;
  onSaved: () => void;
  onError: (message: string) => void;
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
      } else {
        onError(res.error ?? t.drawer.saveFailed);
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
              onKeyDown={(e) => {
                if (e.key === "Escape") {
                  // Stop it from reaching the drawer's window listener, which
                  // would close the whole drawer instead of just this edit.
                  e.stopPropagation();
                  setEditing(false);
                }
              }}
            />
            <Button type="submit" size="sm" variant="accent" disabled={saving} className="h-7 gap-1 px-2 text-xs">
              <LockIcon className="h-3 w-3" />
              {saving ? t.product.saving : t.product.manualConfirm}
            </Button>
            <button
              type="button"
              aria-label={t.product.manualCancel}
              className="rounded p-1 text-faint hover:text-ink"
              onClick={() => setEditing(false)}
            >
              ✕
            </button>
          </form>
        ) : variant.manual != null ? (
          <>
            <button
              type="button"
              className="inline-flex items-center gap-1 rounded-md bg-accent/15 px-2 py-1 text-xs font-semibold text-accent-text tnum hover:bg-accent/25"
              title={t.product.manualEditHint}
              onClick={() => {
                setValue(String(variant.manual));
                setEditing(true);
              }}
            >
              <LockIcon className="h-3 w-3" />
              {eur.format(variant.manual)}
            </button>
            <button
              type="button"
              aria-label={t.product.manualClear}
              title={t.product.manualClearHint}
              className="rounded p-1 text-faint hover:text-skip"
              onClick={() => (saving ? undefined : save(null))}
            >
              ✕
            </button>
          </>
        ) : (
          <Button
            type="button"
            variant="outline"
            size="sm"
            className="h-7 gap-1 px-2 text-[11px]"
            title={t.product.manualLockHint}
            onClick={() => {
              setValue(variant.proposed != null ? String(variant.proposed) : "");
              setEditing(true);
            }}
          >
            <LockIcon className="h-3 w-3" />
            {t.product.manualLock}
          </Button>
        )}
      </div>
    </li>
  );
}

function daysAgo(iso: string): number {
  return Math.max(0, Math.floor((Date.now() - new Date(iso).getTime()) / 86_400_000));
}
