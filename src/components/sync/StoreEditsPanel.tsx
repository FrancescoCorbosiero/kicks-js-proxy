"use client";

import * as React from "react";
import { getStoreEdits, keepStoreEdits, repriceStoreEdits } from "@/server/actions/store-edits";
import type { StoreEditsState, StoreEditView } from "@/server/sync/store-edits";
import { useI18n } from "@/i18n/provider";
import { useShopTime } from "@/components/use-shop-time";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";

const eur = new Intl.NumberFormat("it-IT", { style: "currency", currency: "EUR" });

/** Rows rendered; the badge counts them all. */
const ROW_LIMIT = 30;

/**
 * Prices changed on WordPress: the sizes whose store price someone changed
 * after the Hub last wrote it. The sync keeps them — the automatic one too —
 * and they wait here for a person: keep the store's price (a lock), or hand it
 * back to the Hub (written now). Absent when there is nothing to decide.
 */
export function StoreEditsPanel({
  initial,
  siteUrl,
  timeZone,
  refreshKey,
  disabled,
  onResolved,
}: {
  initial: StoreEditsState | null;
  siteUrl: string;
  timeZone: string;
  /** Changes when a preview ran: it may have found new ones. */
  refreshKey: string | null;
  disabled: boolean;
  /** Prices were locked or written: the preview on the page is stale. */
  onResolved: () => void;
}) {
  const { t } = useI18n();
  const s = t.sync.storeEdits;
  const when = useShopTime(timeZone);
  const [state, setState] = React.useState<StoreEditsState | null>(initial);
  const [busy, setBusy] = React.useState<string | null>(null);
  const [armed, setArmed] = React.useState(false);
  const [message, setMessage] = React.useState<{ text: string; tone: "ok" | "warn" | "error" } | null>(null);

  // A preview notes the edits it finds: read the list again once it is done.
  React.useEffect(() => {
    if (refreshKey == null) return;
    let live = true;
    void getStoreEdits().then((res) => {
      if (live && res.ok) setState(res.data);
    });
    return () => {
      live = false;
    };
  }, [refreshKey]);

  if (!state || state.total === 0) return null;

  async function keep(ids: number[] | "all", key: string) {
    setBusy(key);
    setMessage(null);
    try {
      const res = await keepStoreEdits({ ids });
      if (!res.ok) {
        setMessage({ text: `${s.failed}: ${res.error}`, tone: "error" });
        return;
      }
      setState(res.data.state);
      setMessage(
        res.data.notLockable > 0 && res.data.kept === 0
          ? { text: s.notLockable, tone: "warn" }
          : { text: s.kept(res.data.kept), tone: "ok" },
      );
      if (res.data.kept > 0) onResolved();
    } finally {
      setBusy(null);
    }
  }

  async function reprice(ids: number[] | "all", key: string) {
    setBusy(key);
    setMessage(null);
    setArmed(false);
    try {
      const res = await repriceStoreEdits({ ids });
      if (!res.ok) {
        setMessage({ text: `${s.failed}: ${res.error}`, tone: "error" });
        return;
      }
      setState(res.data.state);
      const { handed, updated, error } = res.data;
      setMessage(
        error
          ? { text: `${s.repriceLater(handed)} (${error})`, tone: "warn" }
          : { text: s.repriced(handed, updated), tone: "ok" },
      );
      if (handed > 0) onResolved();
    } finally {
      setBusy(null);
    }
  }

  const editUrl = (id: number) => `${siteUrl.replace(/\/+$/, "")}/wp-admin/post.php?post=${id}&action=edit`;
  const locked = disabled || busy != null;

  return (
    <section className="space-y-2 rounded-xl border border-warn/30 bg-warn/[0.06] px-4 py-3">
      <div className="flex flex-wrap items-center gap-2">
        <span className="text-sm font-semibold">{s.title}</span>
        <Badge variant="warn">{s.count(state.total)}</Badge>
      </div>
      <p className="max-w-3xl text-xs leading-relaxed text-muted">{s.desc}</p>

      <ul className="space-y-1">
        {state.rows.slice(0, ROW_LIMIT).map((row: StoreEditView) => (
          <li
            key={row.variationId}
            className="flex flex-wrap items-center gap-x-3 gap-y-1 border-t border-line/60 pt-1.5 text-xs first:border-0 first:pt-0"
          >
            <span className="font-mono text-[11px] text-faint">{row.sku}</span>
            <span className="min-w-0 max-w-64 truncate text-muted" title={row.title}>
              {row.title || row.sku}
            </span>
            <span className="font-semibold">{t.product.eu(row.sizeLabel)}</span>
            <span className="font-semibold tnum text-ink">{s.store(eur.format(row.storePrice))}</span>
            <span className="tnum text-faint line-through decoration-faint/60">{s.hub(eur.format(row.hubPrice))}</span>
            {row.seenAt && <span className="text-[11px] text-faint">{s.since(when.dateTime(row.seenAt))}</span>}
            <span className="ml-auto flex flex-wrap items-center gap-1.5">
              {siteUrl && (
                <a
                  href={editUrl(row.productId)}
                  target="_blank"
                  rel="noreferrer"
                  className="text-[11px] font-semibold text-accent-text underline-offset-2 hover:underline"
                >
                  {s.open} →
                </a>
              )}
              <Button
                size="sm"
                variant="outline"
                title={row.lockable ? s.keepHint : s.notLockable}
                disabled={locked || !row.lockable}
                onClick={() => void keep([row.variationId], `keep:${row.variationId}`)}
              >
                {busy === `keep:${row.variationId}` ? "…" : s.keep}
              </Button>
              <Button
                size="sm"
                variant="ghost"
                title={s.repriceHint}
                disabled={locked}
                onClick={() => void reprice([row.variationId], `reprice:${row.variationId}`)}
              >
                {busy === `reprice:${row.variationId}` ? "…" : s.reprice}
              </Button>
            </span>
          </li>
        ))}
      </ul>
      {state.total > ROW_LIMIT && <p className="text-[11px] text-faint">{s.more(state.total - ROW_LIMIT)}</p>}

      {state.total > 1 && (
        <div className="flex flex-wrap items-center gap-2 pt-1">
          <Button size="sm" variant="outline" disabled={locked} onClick={() => void keep("all", "keep:all")}>
            {busy === "keep:all" ? "…" : s.keepAll(state.total)}
          </Button>
          <Button
            size="sm"
            variant="ghost"
            disabled={locked}
            className={armed ? "text-skip" : undefined}
            onClick={() => (armed ? void reprice("all", "reprice:all") : setArmed(true))}
          >
            {busy === "reprice:all" ? "…" : armed ? s.confirm : s.repriceAll(state.total)}
          </Button>
        </div>
      )}
      {message && (
        <p
          className={`text-xs ${
            message.tone === "ok" ? "text-up" : message.tone === "warn" ? "text-warn" : "text-skip"
          }`}
        >
          {message.text}
        </p>
      )}
    </section>
  );
}
