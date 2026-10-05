"use client";

import * as React from "react";
import { Sheet } from "react-modal-sheet";
import { Button, Preloader } from "konsta/react";
import { toast } from "sonner";
import { useI18n } from "@/i18n/provider";
import type { TermEditor } from "@/lib/collections/types";
import {
  confirmCollection,
  deleteCollection,
  loadCollectionForTerm,
  saveCollectionDraft,
} from "@/server/actions/collections";
import {
  editorFrom,
  toDraft,
  useDraftCheck,
  waitForRuns,
  type EditorState,
} from "@/components/collections/editor-model";
import { ConditionsField, MatchField, RuleProblems, type Look } from "@/components/collections/RuleFields";
import { RulePreview, type PreviewLook } from "@/components/collections/RulePreview";
import { useSheetMount } from "./sheet-mount";

/**
 * A rail's category made automatic, from the phone: the rule that decides
 * which products the category holds — and so what the section shows — with
 * the same checks and the same preview as the Hub's page. Saving applies it
 * at once; the section reloads when the products have moved.
 */

const field = "w-full rounded-xl border border-black/10 bg-white px-3 py-2.5 text-[16px] outline-none dark:border-white/15 dark:bg-white/10";

const PHONE_LOOK: Look = {
  label: "text-[13px] font-semibold uppercase tracking-wide opacity-60",
  hint: "mt-1 block text-[13px] leading-snug opacity-60",
  select: `${field} appearance-none`,
  input: `${field} placeholder:opacity-40 focus:border-black/30 dark:focus:border-white/40 disabled:opacity-40`,
  problem: "text-[13px] text-red-600 dark:text-red-400",
  segment: "flex w-full rounded-xl bg-black/[0.06] p-0.5 dark:bg-white/10",
  segmentOn: "flex-1 rounded-[10px] bg-white px-3 py-1.5 text-[14px] font-semibold shadow-sm dark:bg-white/25",
  segmentOff: "flex-1 rounded-[10px] px-3 py-1.5 text-[14px] opacity-70",
  row: "space-y-2 rounded-2xl bg-white p-3 shadow-sm dark:bg-black/40",
  add: "w-full rounded-2xl border border-dashed border-black/15 py-3 text-[15px] font-semibold text-primary disabled:opacity-40 dark:border-white/20",
  remove: "grid h-9 w-9 place-items-center rounded-full text-[15px] opacity-50 active:opacity-30",
};

const PHONE_PREVIEW: PreviewLook = {
  frame: "space-y-2 rounded-2xl bg-white p-4 shadow-sm dark:bg-black/40",
  title: "text-[15px] font-bold",
  numbers: "text-[15px] font-semibold tabular-nums",
  listTitle: "text-[12px] font-semibold uppercase tracking-wide opacity-50",
  item: "truncate text-[14px] opacity-70",
  note: "text-[13px] opacity-60",
  warn: "text-[13px] font-medium text-amber-700 dark:text-amber-400",
};

export function CollectionSheet({
  termId,
  termName,
  onClose,
  onChanged,
}: {
  /** The category of the rail the sheet is open on; null = closed. */
  termId: number | null;
  termName: string;
  onClose: () => void;
  /** The rule changed (saved, paused, removed, confirmed): the section reloads. */
  onChanged: () => void;
}) {
  const { t } = useI18n();
  const a = t.vetrina.auto;
  const mountPoint = useSheetMount();
  const [data, setData] = React.useState<TermEditor | null | undefined>(undefined);
  const [error, setError] = React.useState<string | null>(null);
  const [state, setState] = React.useState<EditorState | null>(null);
  const [busy, setBusy] = React.useState(false);
  const open = termId != null;

  // Every opening starts from the rule as it is now. The very first one also
  // starts the first read of the store: the preview waits for it.
  React.useEffect(() => {
    if (termId == null) return;
    let cancelled = false;
    setData(undefined);
    setState(null);
    setError(null);
    void loadCollectionForTerm({ termId }).then(async (res) => {
      if (cancelled) return;
      if (!res.ok) {
        setError(res.error);
        setData(null);
        return;
      }
      setData(res.data);
      setState(editorFrom(res.data.view, termId));
      if (res.data.indexProducts > 0) return;
      await waitForRuns(120_000);
      const again = await loadCollectionForTerm({ termId });
      if (!cancelled && again.ok) setData(again.data);
    });
    return () => {
      cancelled = true;
    };
  }, [termId]);

  const draft = React.useMemo(() => (open && state ? toDraft(state) : null), [open, state]);
  const { check, checking, error: checkError } = useDraftCheck(draft, data?.indexProducts ?? 0);
  const problems = check?.problems ?? [];
  const view = data?.view ?? null;
  const patch = (next: Partial<EditorState>) => setState((prev) => (prev ? { ...prev, ...next } : prev));

  /** After a save or a confirmation: wait for the products to move, say how it went. */
  async function follow() {
    const id = toast.loading(a.applying);
    const { status, done } = await waitForRuns(45_000);
    if (!done) toast(a.slow, { id });
    else if (status?.runner.lastError) toast.error(`${a.failed}: ${status.runner.lastError}`, { id });
    else toast.success(a.applied(status?.runner.lastMoved ?? 0), { id });
    onChanged();
  }

  async function save() {
    if (!draft || busy) return;
    setBusy(true);
    try {
      const res = await saveCollectionDraft(draft);
      if (!res.ok) {
        toast.error(`${a.failed}: ${res.error}`);
        return;
      }
      onClose();
      if (draft.enabled) await follow();
      else {
        toast(a.savedPaused);
        onChanged();
      }
    } finally {
      setBusy(false);
    }
  }

  async function remove() {
    if (!view || busy || !window.confirm(a.deleteConfirm)) return;
    setBusy(true);
    try {
      const res = await deleteCollection({ id: view.id });
      if (!res.ok) {
        toast.error(`${a.failed}: ${res.error}`);
        return;
      }
      toast(a.deleted);
      onClose();
      onChanged();
    } finally {
      setBusy(false);
    }
  }

  async function confirmHeld() {
    if (!view || busy) return;
    setBusy(true);
    try {
      const res = await confirmCollection({ id: view.id });
      if (!res.ok) {
        toast.error(`${a.failed}: ${res.error}`);
        return;
      }
      onClose();
      await follow();
    } finally {
      setBusy(false);
    }
  }

  return (
    <Sheet isOpen={open} onClose={onClose} detent="content" avoidKeyboard mountPoint={mountPoint}>
      <Sheet.Container className="!bg-[#f2f2f7] dark:!bg-[#1c1c1e]">
        <Sheet.Header />
        <Sheet.Content>
          <div className="space-y-4 px-4 pb-[calc(env(safe-area-inset-bottom)+24px)]">
            <div>
              <h2 className="text-[20px] font-bold leading-tight">{view ? a.sheetEdit(termName) : a.sheetNew(termName)}</h2>
              <p className="mt-1 text-[14px] leading-snug opacity-60">{a.intro}</p>
            </div>

            {data === undefined ? (
              <div className="grid place-items-center gap-2 py-8 text-[14px] opacity-60">
                <Preloader />
                {a.loading}
              </div>
            ) : data === null || !state ? (
              <p className="rounded-2xl bg-white p-4 text-[15px] dark:bg-black/40">{error}</p>
            ) : (
              <>
                {data.demo && <p className="text-[13px] opacity-60">{t.vetrina.demo}</p>}

                {view?.enabled && view.held && (
                  <div className="space-y-2 rounded-2xl bg-amber-50 p-3 text-[14px] dark:bg-amber-950/40">
                    <p>{a.heldHint}</p>
                    <Button small rounded tonal inline disabled={busy} onClick={() => void confirmHeld()}>
                      {a.confirm}
                    </Button>
                  </div>
                )}

                <div className={PHONE_LOOK.segment} role="group">
                  {([true, false] as const).map((on) => (
                    <button
                      key={String(on)}
                      type="button"
                      onClick={() => patch({ enabled: on })}
                      className={state.enabled === on ? PHONE_LOOK.segmentOn : PHONE_LOOK.segmentOff}
                    >
                      {on ? a.on : a.off}
                    </button>
                  ))}
                </div>

                <MatchField value={state.match} onChange={(match) => patch({ match })} look={PHONE_LOOK} />
                <ConditionsField
                  conditions={state.conditions}
                  onChange={(conditions) => patch({ conditions })}
                  options={data.options}
                  problems={problems}
                  look={PHONE_LOOK}
                />
                <RuleProblems problems={problems} look={PHONE_LOOK} />

                <RulePreview
                  preview={check?.preview ?? null}
                  checking={checking}
                  error={checkError}
                  indexProducts={data.indexProducts}
                  isNew={!view}
                  look={PHONE_PREVIEW}
                />

                <div className="flex gap-3">
                  <Button large rounded clear className="flex-1" onClick={onClose}>
                    {a.cancel}
                  </Button>
                  <Button
                    large
                    rounded
                    className="flex-[2]"
                    disabled={busy || !check || checking || problems.length > 0}
                    onClick={() => void save()}
                    colors={{ fillTextIos: "text-white dark:text-black", fillTextMaterial: "text-white dark:text-black" }}
                  >
                    {busy ? a.saving : a.save}
                  </Button>
                </div>
                {view && (
                  <button
                    type="button"
                    disabled={busy}
                    onClick={() => void remove()}
                    className="w-full py-2 text-center text-[15px] text-red-600 active:opacity-60 dark:text-red-400"
                  >
                    {a.delete}
                  </button>
                )}
              </>
            )}
          </div>
        </Sheet.Content>
      </Sheet.Container>
      <Sheet.Backdrop onTap={onClose} />
    </Sheet>
  );
}
