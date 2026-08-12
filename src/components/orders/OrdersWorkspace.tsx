"use client";

import * as React from "react";
import {
  pullOrders,
  setOrderNote,
  setOrderStatus,
  setOrderTracking,
  type OrdersState,
} from "@/server/actions/orders";
import type { OrderView } from "@/server/orders/repo";
import {
  CARRIERS,
  NEXT_STATUS,
  ORDER_STATUSES,
  formatAddress,
  needsWooMirror,
  type OrderStatus,
} from "@/server/orders/model";
import { useI18n } from "@/i18n/provider";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";

/**
 * The Orders workspace — built for an operator who will never open wp-admin.
 * One list, newest first; big obvious "advance" button per order; tracking
 * captured the moment an order is marked shipped; everything else one tap
 * away behind the details toggle. All writes go to the LOCAL workflow only —
 * a badge reminds the operator when a state still has to be mirrored to Woo.
 */

const STATUS_STYLE: Record<OrderStatus, { chip: string; dot: string }> = {
  new: { chip: "bg-accent/12 text-accent-text", dot: "bg-accent" },
  processing: { chip: "bg-update/12 text-update", dot: "bg-update" },
  shipped: { chip: "bg-up/12 text-up", dot: "bg-up" },
  completed: { chip: "bg-surface-2 text-muted", dot: "bg-line-strong" },
  cancelled: { chip: "bg-skip/12 text-skip", dot: "bg-skip" },
};

export function OrdersWorkspace({ initialState }: { initialState: OrdersState }) {
  const { t, locale } = useI18n();
  const [state, setState] = React.useState(initialState);
  const [filter, setFilter] = React.useState<OrderStatus | "all">("all");
  const [q, setQ] = React.useState("");
  const [pulling, setPulling] = React.useState(false);
  const [pullMsg, setPullMsg] = React.useState<string | null>(null);
  const [pullError, setPullError] = React.useState<string | null>(null);

  async function refresh() {
    if (pulling) return;
    setPulling(true);
    setPullError(null);
    setPullMsg(null);
    try {
      const res = await pullOrders();
      if (res.ok && res.state) {
        setState(res.state);
        setPullMsg(t.orders.pullDone(res.report?.saved ?? 0));
      } else {
        setPullError(res.error ?? t.orders.pullFailed);
      }
    } finally {
      setPulling(false);
    }
  }

  /** Patch one order in place after a successful local-workflow write. */
  function patch(orderId: number, changes: Partial<OrderView>) {
    setState((s) => ({
      ...s,
      orders: s.orders.map((o) => (o.id === orderId ? { ...o, ...changes } : o)),
    }));
  }

  const counts = React.useMemo(() => {
    const c = new Map<OrderStatus, number>();
    for (const o of state.orders) c.set(o.status, (c.get(o.status) ?? 0) + 1);
    return c;
  }, [state.orders]);

  const shown = React.useMemo(() => {
    const needle = q.trim().toLowerCase();
    return state.orders.filter((o) => {
      if (filter !== "all" && o.status !== filter) return false;
      if (!needle) return true;
      const hay = [
        o.number,
        o.customerName,
        o.customerEmail,
        o.shipping.city,
        o.trackingCode,
        ...o.items.map((i) => i.sku),
        ...o.items.map((i) => i.name),
      ]
        .join(" ")
        .toLowerCase();
      return hay.includes(needle);
    });
  }, [state.orders, filter, q]);

  const dateLocale = locale === "it" ? "it-IT" : "en-GB";

  return (
    <div className="space-y-4">
      {/* Pull bar */}
      <div className="flex flex-wrap items-center gap-3 rounded-xl border border-line bg-surface p-3">
        <Button type="button" variant="accent" onClick={refresh} disabled={pulling || !state.wooConfigured}>
          {pulling ? (
            <>
              <span className="spin h-3.5 w-3.5 rounded-full border-2 border-accent-fg/30 border-t-accent-fg" />
              {t.orders.pulling}
            </>
          ) : (
            t.orders.pull
          )}
        </Button>
        <div className="min-w-0 flex-1 text-xs text-muted">
          {!state.wooConfigured ? (
            <span className="text-skip">{t.orders.notConfigured}</span>
          ) : pullError ? (
            <span className="text-skip">{pullError}</span>
          ) : pullMsg ? (
            <span className="text-up">{pullMsg}</span>
          ) : state.lastPulledAt ? (
            t.orders.lastPulled(new Date(state.lastPulledAt).toLocaleString(dateLocale))
          ) : (
            t.orders.neverPulled
          )}
        </div>
      </div>

      {/* Status filter + search */}
      {state.orders.length > 0 && (
        <div className="space-y-2">
          <div className="-mx-1 flex gap-1.5 overflow-x-auto px-1 pb-1">
            <FilterChip
              active={filter === "all"}
              label={`${t.orders.all} (${state.orders.length})`}
              onClick={() => setFilter("all")}
            />
            {ORDER_STATUSES.map((s) => (
              <FilterChip
                key={s}
                active={filter === s}
                label={`${t.orders.status[s]} (${counts.get(s) ?? 0})`}
                onClick={() => setFilter(s)}
              />
            ))}
          </div>
          <Input
            aria-label={t.orders.searchPlaceholder}
            placeholder={t.orders.searchPlaceholder}
            value={q}
            onChange={(e) => setQ(e.target.value)}
            className="w-full sm:w-80"
          />
        </div>
      )}

      {/* Orders */}
      {shown.length === 0 ? (
        <div className="rounded-xl border border-line bg-surface p-10 text-center text-sm text-muted">
          {state.orders.length === 0 ? t.orders.neverPulled : t.orders.empty}
        </div>
      ) : (
        <ul className="space-y-3">
          {shown.map((o) => (
            <OrderCard key={o.id} order={o} dateLocale={dateLocale} onPatched={patch} />
          ))}
        </ul>
      )}
    </div>
  );
}

function FilterChip({
  active,
  label,
  onClick,
}: {
  active: boolean;
  label: string;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={`shrink-0 rounded-full border px-3 py-1 text-xs font-medium transition-colors ${
        active
          ? "border-accent bg-accent/12 text-accent-text"
          : "border-line bg-surface text-muted hover:text-ink"
      }`}
    >
      {label}
    </button>
  );
}

function OrderCard({
  order: o,
  dateLocale,
  onPatched,
}: {
  order: OrderView;
  dateLocale: string;
  onPatched: (orderId: number, changes: Partial<OrderView>) => void;
}) {
  const { t } = useI18n();
  const [open, setOpen] = React.useState(false);
  const [trackingOpen, setTrackingOpen] = React.useState(false);
  /** When set, saving the tracking form also advances the order to shipped. */
  const [shipAfterTracking, setShipAfterTracking] = React.useState(false);
  const [saving, setSaving] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);
  const [copied, setCopied] = React.useState<"address" | "tracking" | null>(null);

  const eur = React.useMemo(
    () => new Intl.NumberFormat(dateLocale, { style: "currency", currency: o.currency || "EUR" }),
    [dateLocale, o.currency],
  );
  const style = STATUS_STYLE[o.status];
  const next = NEXT_STATUS[o.status];
  const mirror = needsWooMirror(o.status, o.wooStatus);

  async function changeStatus(status: OrderStatus) {
    setSaving(true);
    setError(null);
    const res = await setOrderStatus({ orderId: o.id, status });
    setSaving(false);
    if (res.ok) onPatched(o.id, { status, statusChangedAt: new Date().toISOString() });
    else setError(res.error ?? t.orders.saveFailed);
  }

  function advance() {
    if (!next) return;
    // Marking shipped without tracking is almost always a mistake — capture
    // the tracking first, with an explicit "no tracking" escape hatch.
    if (next === "shipped" && !o.trackingCode) {
      setOpen(true);
      setTrackingOpen(true);
      setShipAfterTracking(true);
      return;
    }
    void changeStatus(next);
  }

  async function copy(text: string, what: "address" | "tracking") {
    try {
      await navigator.clipboard.writeText(text);
      setCopied(what);
      setTimeout(() => setCopied(null), 1500);
    } catch {
      /* clipboard blocked — no-op */
    }
  }

  const itemsSummary =
    o.items.length === 0
      ? "—"
      : o.items
          .map((it) => `${it.name}${it.size ? ` · ${t.orders.size(it.size)}` : ""}${it.quantity > 1 ? ` ${t.orders.qty(it.quantity)}` : ""}`)
          .join("  ·  ");

  return (
    <li className="overflow-hidden rounded-xl border border-line bg-surface shadow-xs">
      {/* Summary row */}
      <div className="flex flex-wrap items-center gap-x-3 gap-y-2 px-4 py-3">
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-2">
            <span className="text-sm font-bold tnum">#{o.number}</span>
            <span className="text-xs text-faint tnum">
              {new Date(o.createdAt).toLocaleDateString(dateLocale)}
            </span>
            <span className={`inline-flex items-center gap-1.5 rounded-full px-2 py-0.5 text-[11px] font-semibold ${style.chip}`}>
              <span className={`h-1.5 w-1.5 rounded-full ${style.dot}`} />
              {t.orders.status[o.status]}
            </span>
            <span className="rounded border border-line bg-surface-2 px-1.5 py-px text-[10px] font-medium uppercase tracking-wide text-faint">
              {t.orders.wooChip(o.wooStatus || "—")}
            </span>
            {mirror && (
              <span
                className="rounded bg-update/15 px-1.5 py-px text-[10px] font-bold text-update"
                title={t.orders.mirrorHint}
              >
                {t.orders.mirrorBadge}
              </span>
            )}
          </div>
          <div className="mt-1 truncate text-sm">
            <span className="font-medium">{o.customerName || o.customerEmail || "—"}</span>
            {o.shipping.city && <span className="text-muted"> · {o.shipping.city}</span>}
          </div>
          <div className="mt-0.5 truncate text-xs text-muted" title={itemsSummary}>
            {itemsSummary}
          </div>
        </div>

        <div className="flex shrink-0 items-center gap-2">
          <span className="text-sm font-bold tnum">
            {o.total != null ? eur.format(o.total) : "—"}
          </span>
          {next && (
            <Button type="button" variant="accent" size="sm" disabled={saving} onClick={advance}>
              {t.orders.advance[o.status as keyof typeof t.orders.advance]}
            </Button>
          )}
          <Button type="button" variant="outline" size="sm" onClick={() => setOpen((v) => !v)}>
            {open ? t.orders.hideDetails : t.orders.details}
          </Button>
        </div>
      </div>

      {/* Tracking teaser when present (visible without expanding) */}
      {o.trackingCode && !open && (
        <div className="flex flex-wrap items-center gap-2 border-t border-line/60 bg-surface-2/50 px-4 py-1.5 text-xs">
          <span className="font-semibold text-muted">{t.orders.tracking}:</span>
          <span className="text-muted">{o.carrier || "—"}</span>
          <span className="font-mono">{o.trackingCode}</span>
          <button
            type="button"
            className="font-medium text-accent-text underline-offset-2 hover:underline"
            onClick={() => copy(o.trackingCode, "tracking")}
          >
            {copied === "tracking" ? t.orders.copied : t.orders.copyTracking}
          </button>
          {o.trackingUrl && (
            <a
              href={o.trackingUrl}
              target="_blank"
              rel="noreferrer"
              className="ml-auto font-medium text-accent-text underline-offset-2 hover:underline"
            >
              {t.orders.trackingUrl.replace(/ \(.*\)$/, "")} →
            </a>
          )}
        </div>
      )}

      {error && <p className="px-4 pb-2 text-xs text-skip">{error}</p>}

      {/* Details */}
      {open && (
        <div className="space-y-4 border-t border-line px-4 py-4">
          {/* Items */}
          <ul className="divide-y divide-line/60 overflow-hidden rounded-lg border border-line">
            {o.items.map((it, i) => (
              <li key={i} className="flex items-center gap-3 bg-bg px-3 py-2 text-sm">
                {it.image ? (
                  // eslint-disable-next-line @next/next/no-img-element -- store media host is unknown ahead of time
                  <img src={it.image} alt="" className="h-10 w-10 shrink-0 rounded border border-line bg-white object-contain" />
                ) : (
                  <span className="h-10 w-10 shrink-0 rounded border border-line bg-surface-2" />
                )}
                <div className="min-w-0 flex-1">
                  <div className="truncate font-medium">{it.name}</div>
                  <div className="truncate font-mono text-[11px] text-faint">{it.sku || "—"}</div>
                </div>
                <div className="shrink-0 text-right text-xs text-muted">
                  {it.size && <div>{t.orders.size(it.size)}</div>}
                  <div className="tnum">
                    {t.orders.qty(it.quantity)}
                    {it.total != null && <span className="ml-2 font-semibold text-ink">{eur.format(it.total)}</span>}
                  </div>
                </div>
              </li>
            ))}
          </ul>

          <div className="grid gap-4 sm:grid-cols-2">
            {/* Shipping address */}
            <div className="rounded-lg border border-line bg-bg p-3">
              <div className="mb-1.5 flex items-center justify-between text-xs font-semibold">
                {t.orders.address}
                <button
                  type="button"
                  className="font-medium text-accent-text underline-offset-2 hover:underline"
                  onClick={() => copy(formatAddress(o.shipping), "address")}
                >
                  {copied === "address" ? t.orders.copied : t.orders.copyAddress}
                </button>
              </div>
              <pre className="whitespace-pre-wrap font-sans text-xs leading-relaxed text-muted">
                {formatAddress(o.shipping) || "—"}
              </pre>
              {o.paymentMethod && (
                <p className="mt-2 text-[11px] text-faint">{t.orders.paidWith(o.paymentMethod)}</p>
              )}
              {o.customerNote && (
                <p className="mt-2 rounded bg-update/10 p-2 text-[11px] leading-snug text-update">
                  <span className="font-semibold">{t.orders.customerNote}:</span> {o.customerNote}
                </p>
              )}
            </div>

            {/* Tracking */}
            <div className="rounded-lg border border-line bg-bg p-3">
              <div className="mb-1.5 flex items-center justify-between text-xs font-semibold">
                {t.orders.tracking}
                {!trackingOpen && (
                  <button
                    type="button"
                    className="font-medium text-accent-text underline-offset-2 hover:underline"
                    onClick={() => setTrackingOpen(true)}
                  >
                    {o.trackingCode ? t.orders.trackingEdit : t.orders.trackingAdd}
                  </button>
                )}
              </div>
              {trackingOpen ? (
                <TrackingForm
                  order={o}
                  shipAfter={shipAfterTracking}
                  onDone={(changes, shipped) => {
                    setTrackingOpen(false);
                    setShipAfterTracking(false);
                    onPatched(o.id, changes);
                    if (shipped) void changeStatus("shipped");
                  }}
                  onError={setError}
                  onCancel={() => {
                    setTrackingOpen(false);
                    setShipAfterTracking(false);
                  }}
                />
              ) : o.trackingCode ? (
                <div className="space-y-1 text-xs text-muted">
                  <div>{o.carrier || "—"}</div>
                  <div className="flex items-center gap-2">
                    <span className="font-mono text-sm text-ink">{o.trackingCode}</span>
                    <button
                      type="button"
                      className="font-medium text-accent-text underline-offset-2 hover:underline"
                      onClick={() => copy(o.trackingCode, "tracking")}
                    >
                      {copied === "tracking" ? t.orders.copied : t.orders.copyTracking}
                    </button>
                  </div>
                  {o.trackingUrl && (
                    <a href={o.trackingUrl} target="_blank" rel="noreferrer" className="inline-block font-medium text-accent-text underline-offset-2 hover:underline">
                      {o.trackingUrl}
                    </a>
                  )}
                </div>
              ) : (
                <p className="text-xs text-faint">—</p>
              )}
            </div>
          </div>

          {/* Note + granular status */}
          <NoteEditor order={o} onPatched={onPatched} onError={setError} />
          <div className="flex flex-wrap items-center gap-2 text-xs">
            <label className="font-semibold" htmlFor={`status-${o.id}`}>
              {t.orders.statusLabel}
            </label>
            <select
              id={`status-${o.id}`}
              className="h-8 rounded-md border border-line bg-surface px-2 text-xs text-ink shadow-xs"
              value={o.status}
              disabled={saving}
              onChange={(e) => void changeStatus(e.target.value as OrderStatus)}
            >
              {ORDER_STATUSES.map((s) => (
                <option key={s} value={s}>
                  {t.orders.status[s]}
                </option>
              ))}
            </select>
            {o.status !== "cancelled" ? (
              <Button
                type="button"
                variant="ghost"
                size="sm"
                className="text-skip"
                disabled={saving}
                onClick={() => void changeStatus("cancelled")}
              >
                {t.orders.cancelOrder}
              </Button>
            ) : (
              <Button type="button" variant="ghost" size="sm" disabled={saving} onClick={() => void changeStatus("new")}>
                {t.orders.reopen}
              </Button>
            )}
          </div>
        </div>
      )}
    </li>
  );
}

function TrackingForm({
  order: o,
  shipAfter,
  onDone,
  onError,
  onCancel,
}: {
  order: OrderView;
  shipAfter: boolean;
  onDone: (changes: Partial<OrderView>, shipped: boolean) => void;
  onError: (message: string) => void;
  onCancel: () => void;
}) {
  const { t } = useI18n();
  const OTHER = "__other__";
  const presetCarrier = (CARRIERS as readonly string[]).includes(o.carrier) ? o.carrier : o.carrier ? OTHER : "";
  const [carrierSel, setCarrierSel] = React.useState(presetCarrier);
  const [carrierFree, setCarrierFree] = React.useState(presetCarrier === OTHER ? o.carrier : "");
  const [code, setCode] = React.useState(o.trackingCode);
  const [url, setUrl] = React.useState(o.trackingUrl);
  const [saving, setSaving] = React.useState(false);

  async function save(markShipped: boolean) {
    const carrier = carrierSel === OTHER ? carrierFree : carrierSel;
    setSaving(true);
    const res = await setOrderTracking({
      orderId: o.id,
      carrier: carrier.trim(),
      trackingCode: code.trim(),
      trackingUrl: url.trim(),
    });
    setSaving(false);
    if (res.ok) {
      onDone(
        { carrier: carrier.trim(), trackingCode: code.trim(), trackingUrl: url.trim() },
        markShipped,
      );
    } else {
      onError(res.error ?? t.orders.saveFailed);
    }
  }

  return (
    <form
      className="space-y-2"
      onSubmit={(e) => {
        e.preventDefault();
        void save(shipAfter);
      }}
    >
      <div className="flex flex-wrap gap-2">
        <select
          aria-label={t.orders.trackingCarrier}
          className="h-8 rounded-md border border-line bg-surface px-2 text-xs text-ink shadow-xs"
          value={carrierSel}
          onChange={(e) => setCarrierSel(e.target.value)}
        >
          <option value="">{t.orders.trackingCarrier}</option>
          {CARRIERS.map((c) => (
            <option key={c} value={c}>
              {c}
            </option>
          ))}
          <option value={OTHER}>{t.orders.trackingCarrierOther}</option>
        </select>
        {carrierSel === OTHER && (
          <Input
            aria-label={t.orders.trackingCarrier}
            placeholder={t.orders.trackingCarrier}
            className="h-8 w-32 text-xs"
            value={carrierFree}
            onChange={(e) => setCarrierFree(e.target.value)}
          />
        )}
      </div>
      <Input
        aria-label={t.orders.trackingCode}
        placeholder={t.orders.trackingCode}
        className="h-8 font-mono text-xs"
        value={code}
        onChange={(e) => setCode(e.target.value)}
        autoFocus
      />
      <Input
        aria-label={t.orders.trackingUrl}
        placeholder={t.orders.trackingUrl}
        inputMode="url"
        className="h-8 text-xs"
        value={url}
        onChange={(e) => setUrl(e.target.value)}
      />
      <div className="flex flex-wrap items-center gap-2">
        <Button type="submit" variant="accent" size="sm" disabled={saving}>
          {shipAfter ? t.orders.trackingSaveAndShip : t.orders.trackingSave}
        </Button>
        {shipAfter && (
          <Button type="button" variant="outline" size="sm" disabled={saving} onClick={() => void save(true)}>
            {t.orders.trackingSkip}
          </Button>
        )}
        <button type="button" className="rounded p-1 text-faint hover:text-ink" onClick={onCancel} aria-label={t.product.manualCancel}>
          ✕
        </button>
      </div>
    </form>
  );
}

function NoteEditor({
  order: o,
  onPatched,
  onError,
}: {
  order: OrderView;
  onPatched: (orderId: number, changes: Partial<OrderView>) => void;
  onError: (message: string) => void;
}) {
  const { t } = useI18n();
  const [note, setNote] = React.useState(o.note);
  const [saving, setSaving] = React.useState(false);
  const dirty = note.trim() !== o.note;

  async function save() {
    setSaving(true);
    const res = await setOrderNote({ orderId: o.id, note: note.trim() });
    setSaving(false);
    if (res.ok) onPatched(o.id, { note: note.trim() });
    else onError(res.error ?? t.orders.saveFailed);
  }

  return (
    <div>
      <label className="mb-1 block text-xs font-semibold" htmlFor={`note-${o.id}`}>
        {t.orders.note}
      </label>
      <div className="flex items-start gap-2">
        <Textarea
          id={`note-${o.id}`}
          placeholder={t.orders.notePlaceholder}
          className="min-h-16 flex-1 text-xs"
          value={note}
          onChange={(e) => setNote(e.target.value)}
        />
        {dirty && (
          <Button type="button" variant="outline" size="sm" disabled={saving} onClick={save}>
            {t.orders.noteSave}
          </Button>
        )}
      </div>
    </div>
  );
}
