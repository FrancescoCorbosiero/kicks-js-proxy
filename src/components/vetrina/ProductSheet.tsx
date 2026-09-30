"use client";

import * as React from "react";
import { Sheet } from "react-modal-sheet";
import { Button, Preloader } from "konsta/react";
import { toast } from "sonner";
import { useI18n } from "@/i18n/provider";
import type { DrawerData } from "@/components/catalog/drawer-data";
import type { ProductCard } from "@/lib/vetrina/types";
import { loadProductPrices, publishProductPrices } from "@/server/actions/vetrina-prices";
import { setProductManualPrices } from "@/server/actions/overrides";
import { updateStoreVariation } from "@/server/actions/store-edit";
import { formatCardPrice, formatEuro, parsePrice } from "./format";
import { External, Lock } from "./icons";

const toInput = (n: number | null | undefined) => (n == null ? "" : n.toFixed(2).replace(".", ","));

/**
 * A product's prices, from the rail editor. Each size shows the market ask
 * and the price the Hub computes; typing a price locks it, clearing it
 * unlocks. "Salva e pubblica" saves the locks in the Hub and pushes this one
 * product's prices to the site. Store-only products have no source price:
 * their shelf price is edited directly.
 */
export function ProductSheet({
  card,
  onClose,
  onLocksChanged,
  onPricesChanged,
  demo,
}: {
  card: ProductCard | null;
  onClose: () => void;
  onLocksChanged: (sku: string, count: number) => void;
  /** Prices reached the site: the list re-reads this product's card. */
  onPricesChanged: (id: number) => void;
  demo: boolean;
}) {
  const { t } = useI18n();
  const p = t.vetrina.product;
  const [data, setData] = React.useState<DrawerData | null | undefined>(undefined);
  const [error, setError] = React.useState<string | null>(null);
  const [edits, setEdits] = React.useState<Record<string, string>>({});
  const [saving, setSaving] = React.useState(false);

  const load = React.useCallback(async (sku: string) => {
    setData(undefined);
    setError(null);
    const res = await loadProductPrices({ sku });
    if (!res.ok) {
      setError(res.error);
      setData(null);
      return;
    }
    setData(res.data);
    const next: Record<string, string> = {};
    if (res.data?.store) {
      for (const v of res.data.store.variants) next[String(v.variationId)] = toInput(v.price);
    } else if (res.data) {
      for (const v of res.data.variants) if (v.euSize) next[v.euSize] = toInput(v.manual);
    }
    setEdits(next);
  }, []);

  // Keyed on the SKU, not the card: a card refreshed after a publish must not
  // reload the sheet under the operator's fingers.
  const sku = card?.sku ?? "";
  React.useEffect(() => {
    if (!sku || demo) return;
    void load(sku);
  }, [sku, demo, load]);

  async function saveCatalog(d: DrawerData) {
    const prices: { euSize: string; price: number | null }[] = [];
    for (const v of d.variants) {
      if (!v.euSize) continue;
      const text = (edits[v.euSize] ?? "").trim();
      const next = text === "" ? null : parsePrice(text);
      if (text !== "" && next == null) {
        toast.error(`${p.invalidPrice}: ${v.euSize}`);
        return;
      }
      if (next !== v.manual) prices.push({ euSize: v.euSize, price: next });
    }
    if (prices.length === 0) {
      toast(p.nothingToSave);
      return;
    }
    setSaving(true);
    try {
      const locked = await setProductManualPrices({ parentSku: d.sku, prices });
      if (!locked.ok) {
        toast.error(locked.error ?? t.vetrina.errors.failed);
        return;
      }
      const lockedCount = d.variants.filter((v) => v.euSize && (edits[v.euSize] ?? "").trim() !== "").length;
      onLocksChanged(d.sku, lockedCount);
      const published = await publishProductPrices({ sku: d.sku });
      if (!published.ok) toast.error(`${p.savedLocked}. ${published.noSnapshot ? p.noSnapshot : published.error}`);
      else if (published.failed > 0) toast.error(p.someFailed(published.failed));
      else if (published.updated > 0) toast.success(p.saved(published.updated));
      else if (published.unpriced) toast.warning(p.notPriced);
      else toast(p.upToDate);
      if (published.ok && published.updated > 0 && card) onPricesChanged(card.id);
      await load(d.sku);
    } finally {
      setSaving(false);
    }
  }

  async function saveStore(d: DrawerData) {
    const store = d.store!;
    const writes: { variationId: number; price: number }[] = [];
    for (const v of store.variants) {
      const text = (edits[String(v.variationId)] ?? "").trim();
      const next = parsePrice(text);
      if (next == null) {
        if (text !== "") toast.error(`${p.invalidPrice}: ${v.sizeLabel}`);
        if (text !== "") return;
        continue;
      }
      if (next !== v.price) writes.push({ variationId: v.variationId, price: next });
    }
    if (writes.length === 0) {
      toast(p.nothingToSave);
      return;
    }
    setSaving(true);
    try {
      let done = 0;
      for (const w of writes) {
        const res = await updateStoreVariation({ storeProductId: store.productId, ...w });
        if (!res.ok) {
          toast.error(res.error ?? t.vetrina.errors.failed);
          break;
        }
        done += 1;
      }
      if (done > 0) {
        toast.success(p.saved(done));
        if (card) onPricesChanged(card.id);
      }
      await load(d.sku);
    } finally {
      setSaving(false);
    }
  }

  const ruleLabel = (d: DrawerData) => {
    const r = d.appliedRule;
    if (!r) return null;
    const scope = r.isGeneral ? p.generalRule : r.scopeLabel;
    const amount =
      r.kind === "percent" && r.markupPercent != null
        ? ` · ${r.markupPercent}%`
        : r.kind === "fixed" && r.markupFixed != null
          ? ` · +${formatEuro(r.markupFixed)}`
          : "";
    return p.rule(`${scope}${amount}`);
  };

  return (
    <Sheet isOpen={card != null} onClose={onClose} detent="content" avoidKeyboard>
      <Sheet.Container className="!bg-[#f2f2f7] dark:!bg-[#1c1c1e]">
        <Sheet.Header />
        <Sheet.Content>
          {card && (
            <div className="px-4 pb-[calc(env(safe-area-inset-bottom)+24px)]">
              <div className="flex items-center gap-3">
                {/* eslint-disable-next-line @next/next/no-img-element -- the shop's own thumbnail sizes */}
                <img src={card.image} alt="" className="h-20 w-20 shrink-0 rounded-2xl bg-white object-contain dark:bg-white/10" />
                <div className="min-w-0 flex-1">
                  <h2 className="line-clamp-2 text-[18px] font-bold leading-snug">{card.name}</h2>
                  <div className="mt-0.5 font-mono text-[12px] opacity-50">{card.sku}</div>
                  <div className="mt-1 text-[14px]">
                    <span className="opacity-60">{p.priceOnSite}:</span>{" "}
                    <span className="font-semibold tabular-nums">{formatCardPrice(card)}</span>
                  </div>
                </div>
              </div>

              <div className="mt-5">
                {demo ? (
                  <p className="rounded-2xl bg-white p-4 text-[15px] opacity-70 dark:bg-black/40">{t.vetrina.demo}</p>
                ) : !card.sku ? (
                  <p className="rounded-2xl bg-white p-4 text-[15px] dark:bg-black/40">{p.notInHub}</p>
                ) : data === undefined ? (
                  <div className="grid place-items-center gap-2 py-8 text-[14px] opacity-60">
                    <Preloader />
                    {p.loading}
                  </div>
                ) : data === null ? (
                  <p className="rounded-2xl bg-white p-4 text-[15px] dark:bg-black/40">{error ?? p.notInHub}</p>
                ) : data.store ? (
                  <>
                    <p className="mb-2 px-1 text-[13px] opacity-60">{p.storeOnly}</p>
                    <ul className="overflow-hidden rounded-2xl bg-white dark:bg-black/40">
                      {data.store.variants.map((v) => (
                        <li key={v.variationId} className="flex items-center gap-3 border-b border-black/5 px-4 py-2.5 last:border-0 dark:border-white/10">
                          <span className="w-16 text-[17px] font-semibold">{v.sizeLabel}</span>
                          <span className="flex-1 text-[13px] opacity-50">{v.stock != null ? `stock ${v.stock}` : ""}</span>
                          <PriceInput
                            value={edits[String(v.variationId)] ?? ""}
                            placeholder={toInput(v.price)}
                            onChange={(text) => setEdits((e) => ({ ...e, [String(v.variationId)]: text }))}
                          />
                        </li>
                      ))}
                    </ul>
                    <Button large rounded className="mt-4" disabled={saving} onClick={() => saveStore(data)}
                      colors={{ fillTextIos: "text-white dark:text-black", fillTextMaterial: "text-white dark:text-black" }}>
                      {saving ? p.saving : p.save}
                    </Button>
                  </>
                ) : (
                  <>
                    <div className="mb-2 space-y-0.5 px-1 text-[13px] opacity-60">
                      <div>{p.source[data.owner] ?? ""}</div>
                      {ruleLabel(data) && <div>{ruleLabel(data)}</div>}
                    </div>
                    <div className="mb-1 flex items-center justify-between px-1">
                      <span className="text-[13px] font-semibold uppercase tracking-wide opacity-50">{p.sizes}</span>
                      <span className="flex gap-1">
                        <Button small clear inline onClick={() =>
                          setEdits((e) => {
                            const next = { ...e };
                            for (const v of data.variants) {
                              if (v.euSize && !(next[v.euSize] ?? "").trim() && v.proposed != null) next[v.euSize] = toInput(v.proposed);
                            }
                            return next;
                          })
                        }>
                          {p.lockAll}
                        </Button>
                        <Button small clear inline onClick={() =>
                          setEdits((e) => Object.fromEntries(Object.keys(e).map((k) => [k, ""])))
                        }>
                          {p.unlockAll}
                        </Button>
                      </span>
                    </div>
                    <ul className="overflow-hidden rounded-2xl bg-white dark:bg-black/40">
                      {data.variants.map((v) => {
                        const text = v.euSize ? edits[v.euSize] ?? "" : "";
                        const typed = text.trim() === "" ? null : parsePrice(text);
                        const below = typed != null && v.ask != null && typed < v.ask;
                        return (
                          <li key={v.id} className="flex items-center gap-3 border-b border-black/5 px-4 py-2.5 last:border-0 dark:border-white/10">
                            <span className="w-14 shrink-0 text-[17px] font-semibold">{v.euSize ?? v.sizeLabel}</span>
                            <span className="min-w-0 flex-1 text-[12px] leading-tight">
                              <span className="block opacity-50">
                                {p.market} {formatEuro(v.ask)}
                              </span>
                              <span className="block opacity-50">
                                {p.computed} {formatEuro(v.proposed)}
                              </span>
                              {below && <span className="block text-amber-700 dark:text-amber-400">{p.belowMarket(formatEuro(v.ask))}</span>}
                            </span>
                            {v.euSize ? (
                              <>
                                <PriceInput
                                  value={text}
                                  placeholder={toInput(v.proposed)}
                                  onChange={(next) => setEdits((e) => ({ ...e, [v.euSize!]: next }))}
                                />
                                <Lock className={`h-4 w-4 shrink-0 ${text.trim() ? "opacity-80" : "opacity-15"}`} />
                              </>
                            ) : null}
                          </li>
                        );
                      })}
                    </ul>
                    <p className="mt-2 px-1 text-[12px] opacity-50">{p.lockHint}</p>
                    <Button large rounded className="mt-4" disabled={saving} onClick={() => saveCatalog(data)}
                      colors={{ fillTextIos: "text-white dark:text-black", fillTextMaterial: "text-white dark:text-black" }}>
                      {saving ? p.saving : p.save}
                    </Button>
                  </>
                )}
              </div>

              <div className="mt-5 flex flex-col gap-2 text-[15px]">
                {card.permalink && (
                  <a href={card.permalink} target="_blank" rel="noreferrer" className="flex items-center gap-1.5 text-primary">
                    {p.openSite}
                    <External className="h-4 w-4" />
                  </a>
                )}
                {card.editLink && (
                  <a href={card.editLink} target="_blank" rel="noreferrer" className="flex items-center gap-1.5 text-primary">
                    {p.editWp}
                    <External className="h-4 w-4" />
                  </a>
                )}
                {card.sku && !demo && (
                  <a href={`/catalog?product=${encodeURIComponent(card.sku)}`} className="text-primary">
                    {p.openHub}
                  </a>
                )}
              </div>
            </div>
          )}
        </Sheet.Content>
      </Sheet.Container>
      <Sheet.Backdrop onTap={onClose} />
    </Sheet>
  );
}

function PriceInput({
  value,
  placeholder,
  onChange,
}: {
  value: string;
  placeholder: string;
  onChange: (text: string) => void;
}) {
  return (
    <span className="relative w-28 shrink-0">
      <span className="pointer-events-none absolute left-2.5 top-1/2 -translate-y-1/2 text-[15px] opacity-40">€</span>
      <input
        type="text"
        inputMode="decimal"
        enterKeyHint="done"
        value={value}
        placeholder={placeholder}
        onChange={(e) => onChange(e.target.value)}
        className="w-full rounded-xl border border-black/10 bg-black/[0.03] py-2 pl-7 pr-2 text-right text-[16px] font-semibold tabular-nums outline-none placeholder:font-normal placeholder:opacity-40 focus:border-black/30 dark:border-white/15 dark:bg-white/10"
      />
    </span>
  );
}
