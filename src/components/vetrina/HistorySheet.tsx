"use client";

import * as React from "react";
import { Sheet } from "react-modal-sheet";
import { Button, Preloader } from "konsta/react";
import { useI18n } from "@/i18n/provider";
import { sameState } from "@/lib/vetrina/order";
import type { RailHistoryState, RailState } from "@/lib/vetrina/types";
import { loadVetrinaHistory } from "@/server/actions/vetrina";
import { formatWhen } from "./format";

/**
 * Earlier versions of a rail, from the page's WordPress revisions. Restoring
 * one puts it in the draft — it still goes through "Pubblica" like any change.
 */
export function HistorySheet({
  open,
  railKey,
  current,
  onClose,
  onRestore,
}: {
  open: boolean;
  railKey: string;
  current: RailState;
  onClose: () => void;
  onRestore: (state: RailState) => void;
}) {
  const { t, locale } = useI18n();
  const h = t.vetrina.editor.history;
  const [states, setStates] = React.useState<RailHistoryState[] | null>(null);
  const [error, setError] = React.useState<string | null>(null);

  React.useEffect(() => {
    if (!open) return;
    let cancelled = false;
    setStates(null);
    setError(null);
    loadVetrinaHistory({ key: railKey }).then((res) => {
      if (cancelled) return;
      if (res.ok) setStates(res.data);
      else setError(t.vetrina.errors[res.code] ?? res.error);
    });
    return () => {
      cancelled = true;
    };
  }, [open, railKey, t]);

  return (
    <Sheet isOpen={open} onClose={onClose} detent="content">
      <Sheet.Container className="!bg-[#f2f2f7] dark:!bg-[#1c1c1e]">
        <Sheet.Header />
        <Sheet.Content>
          <div className="px-4 pb-[calc(env(safe-area-inset-bottom)+20px)]">
            <h2 className="mb-3 text-[20px] font-bold">{h.title}</h2>
            {error && <p className="text-[15px] text-red-600">{error}</p>}
            {!error && states == null && (
              <div className="grid place-items-center py-8">
                <Preloader />
              </div>
            )}
            {states?.length === 0 && <p className="py-4 text-[15px] opacity-60">{h.empty}</p>}
            {states && states.length > 0 && (
              <ul className="overflow-hidden rounded-2xl bg-white dark:bg-black/40">
                {states.map((s) => {
                  const live = sameState(s, current);
                  return (
                    <li
                      key={s.revisionId}
                      className="flex items-center gap-3 border-b border-black/5 px-4 py-3 last:border-0 dark:border-white/10"
                    >
                      <div className="min-w-0 flex-1">
                        <div className="text-[15px] font-medium">
                          {formatWhen(s.dateGmt, locale)} <span className="opacity-50">{h.by(s.author)}</span>
                        </div>
                        <div className="text-[13px] opacity-60">
                          {h.summary(s.pin.length, t.vetrina.editor.fallbacks[s.fallback] ?? s.fallback)}
                        </div>
                      </div>
                      {live ? (
                        <span className="shrink-0 rounded-full bg-black/5 px-2.5 py-1 text-[12px] font-semibold dark:bg-white/10">
                          {h.current}
                        </span>
                      ) : (
                        <Button small rounded tonal inline onClick={() => onRestore({ pin: s.pin, exclude: s.exclude, fallback: s.fallback })}>
                          {h.restore}
                        </Button>
                      )}
                    </li>
                  );
                })}
              </ul>
            )}
          </div>
        </Sheet.Content>
      </Sheet.Container>
      <Sheet.Backdrop onTap={onClose} />
    </Sheet>
  );
}
