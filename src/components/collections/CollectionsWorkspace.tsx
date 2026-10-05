"use client";

import * as React from "react";
import { useI18n } from "@/i18n/provider";
import { describeRule } from "@/lib/collections/describe";
import type { CollectionsState, CollectionsStatus, CollectionView } from "@/lib/collections/types";
import {
  confirmCollection,
  deleteCollection,
  freshenCollections,
  getCollectionsState,
  pauseCollection,
  pollCollections,
  readStoreAgain,
  saveCollectionDraft,
} from "@/server/actions/collections";
import { Button } from "@/components/ui/button";
import { useShopTime } from "@/components/use-shop-time";
import { editorFrom, toDraft, useDraftCheck, type EditorState } from "./editor-model";
import { CategoryField, ConditionsField, MatchField, RuleProblems, type Look } from "./RuleFields";
import { RulePreview, type PreviewLook } from "./RulePreview";

/**
 * The automatic categories, in the Hub: every rule with what it holds, the
 * editor that shows what a rule would do before it is saved, and the log of
 * every product moved. The runs themselves happen on the server; this page
 * starts them and follows them.
 */

const SELECT =
  "h-9 w-full rounded-md border border-line bg-surface px-2 text-sm text-ink shadow-xs outline-none focus-visible:ring-2 focus-visible:ring-accent/40 disabled:opacity-50";

const HUB_LOOK: Look = {
  label: "text-xs font-semibold text-muted",
  hint: "mt-1 block text-[11px] leading-snug text-faint",
  select: SELECT,
  input:
    "h-9 w-full rounded-md border border-line bg-surface-2 px-3 text-sm text-ink shadow-xs outline-none placeholder:text-faint focus-visible:border-accent/50 focus-visible:ring-4 focus-visible:ring-accent/15 disabled:opacity-50",
  problem: "text-xs font-medium text-skip",
  segment: "flex items-center gap-1 rounded-lg border border-line bg-surface p-0.5",
  segmentOn: "rounded-md bg-accent px-2.5 py-1 text-[11px] font-semibold text-accent-fg shadow-xs",
  segmentOff: "rounded-md px-2.5 py-1 text-[11px] font-semibold text-muted hover:text-ink",
  row: "space-y-1.5 rounded-lg border border-line bg-surface-2 p-2.5",
  add: "rounded-md border border-dashed border-line px-3 py-1.5 text-xs font-semibold text-muted hover:text-ink disabled:opacity-50",
  remove: "grid h-7 w-7 place-items-center rounded-md text-xs text-faint hover:bg-surface hover:text-skip",
};

const HUB_PREVIEW: PreviewLook = {
  frame: "space-y-2 rounded-xl border border-accent/40 bg-accent/5 p-4",
  title: "text-sm font-bold",
  numbers: "text-sm font-semibold tnum",
  listTitle: "text-[11px] font-semibold uppercase tracking-wide text-faint",
  item: "truncate text-xs text-muted",
  note: "text-xs text-muted",
  warn: "text-xs font-medium text-warn",
};

type Notice = { tone: "ok" | "error"; text: string } | null;

const active = (s: CollectionsStatus) => s.runner.running != null || s.runner.queued > 0;

export function CollectionsWorkspace({ initial }: { initial: CollectionsState }) {
  const { t } = useI18n();
  const c = t.collections;
  const [state, setState] = React.useState<CollectionsState>(initial);
  const [editing, setEditing] = React.useState<EditorState | null>(null);
  const [notice, setNotice] = React.useState<Notice>(null);
  const [busy, setBusy] = React.useState(false);
  const when = useShopTime(state.runner.timeZone);

  const absorb = React.useCallback((status: CollectionsStatus) => setState((prev) => ({ ...prev, ...status })), []);

  // Opening the page brings the store index up to date (in the background).
  React.useEffect(() => {
    void freshenCollections().then(async () => {
      const res = await pollCollections();
      if (res.ok) absorb(res.data);
    });
  }, [absorb]);

  // Follow a run while it goes; when it ends, reload the options (a new
  // category may exist now) and — when this page asked for the run — say
  // what it did. The quiet catch-up on opening the page says nothing.
  const running = active(state);
  const wasRunning = React.useRef(running);
  const announce = React.useRef(false);
  React.useEffect(() => {
    if (running) {
      wasRunning.current = true;
      const timer = setTimeout(async () => {
        const res = await pollCollections();
        if (res.ok) absorb(res.data);
      }, 1500);
      return () => clearTimeout(timer);
    }
    if (wasRunning.current) {
      wasRunning.current = false;
      if (announce.current) {
        announce.current = false;
        if (state.runner.lastError) setNotice({ tone: "error", text: `${c.status.failed} ${state.runner.lastError}` });
        else if (state.runner.lastMoved != null) setNotice({ tone: "ok", text: c.toasts.done(state.runner.lastMoved) });
      }
      void getCollectionsState().then((res) => res.ok && setState(res.data));
    }
  }, [running, state, absorb, c]);

  /**
   * Run an action and say how it went. One that starts a run (`startsRun`)
   * is followed to its end, which says what it moved — straight away when
   * the run was over before the page even looked (a small change, the demo).
   */
  async function act(run: () => Promise<{ ok: boolean; error?: string }>, success: string, startsRun: boolean) {
    setBusy(true);
    setNotice(null);
    announce.current = startsRun;
    try {
      const res = await run();
      if (!res.ok) {
        announce.current = false;
        setNotice({ tone: "error", text: `${c.toasts.failed}: ${res.error}` });
        return false;
      }
      setNotice({ tone: "ok", text: success });
      const fresh = await pollCollections();
      if (fresh.ok) {
        absorb(fresh.data);
        if (startsRun && !active(fresh.data)) {
          announce.current = false;
          const r = fresh.data.runner;
          setNotice(
            r.lastError
              ? { tone: "error", text: `${c.status.failed} ${r.lastError}` }
              : { tone: "ok", text: c.toasts.done(r.lastMoved ?? 0) },
          );
          void getCollectionsState().then((res2) => res2.ok && setState(res2.data));
        }
      }
      return true;
    } finally {
      setBusy(false);
    }
  }

  if (!state.configured) {
    return <p className="rounded-xl border border-line bg-surface p-4 text-sm text-muted">{c.notConfigured}</p>;
  }

  const categoryPath = (view: CollectionView) =>
    state.options?.categories.find((x) => x.id === view.termId)?.path ?? view.name;

  return (
    <div className="space-y-5">
      {state.demo && (
        <p className="rounded-xl border border-accent/40 bg-accent/5 p-3 text-sm text-ink">{c.demo}</p>
      )}
      <StatusPanel
        state={state}
        busy={busy}
        when={when}
        onReadAll={() => void act(readStoreAgain, c.toasts.reading, true)}
      />

      {notice && (
        <p className={`text-sm font-medium ${notice.tone === "ok" ? "text-create" : "text-skip"}`} role="status">
          {notice.text}
        </p>
      )}

      {state.optionsError && (
        <p className="rounded-xl border border-skip/40 bg-skip/5 p-3 text-sm text-skip">
          {c.status.failed} {state.optionsError}
        </p>
      )}

      {editing && state.options ? (
        <Editor
          key={editing.id ?? "new"}
          initial={editing}
          state={state}
          busy={busy}
          onCancel={() => setEditing(null)}
          onSave={async (draft, enabled) => {
            const ok = await act(
              () => saveCollectionDraft({ ...draft, enabled }),
              enabled ? c.toasts.saved : c.toasts.savedPaused,
              enabled,
            );
            if (ok) setEditing(null);
          }}
          onDelete={async (view) => {
            if (!window.confirm(c.editor.deleteConfirm(view.name))) return;
            const ok = await act(() => deleteCollection({ id: view.id }), c.toasts.deleted, false);
            if (ok) setEditing(null);
          }}
        />
      ) : (
        <section className="space-y-3 rounded-xl border border-line bg-surface p-4 shadow-xs">
          <div className="flex flex-wrap items-center gap-3">
            <div className="text-sm font-bold">{c.list.title}</div>
            <Button
              type="button"
              variant="accent"
              size="sm"
              className="ml-auto"
              disabled={!state.options}
              onClick={() => setEditing(editorFrom())}
            >
              + {c.list.add}
            </Button>
          </div>
          {state.collections.length === 0 ? (
            <p className="text-sm text-muted">{c.list.empty}</p>
          ) : (
            <ul className="space-y-2">
              {state.collections.map((view) => (
                <CollectionCard
                  key={view.id}
                  view={view}
                  path={categoryPath(view)}
                  maxChanges={state.runner.maxChanges}
                  when={when}
                  busy={busy}
                  canEdit={!!state.options}
                  onEdit={() => setEditing(editorFrom(view))}
                  onPause={(paused) =>
                    void act(
                      () => pauseCollection({ id: view.id, paused }),
                      paused ? c.toasts.paused : c.toasts.resumed,
                      !paused,
                    )
                  }
                  onConfirm={() => void act(() => confirmCollection({ id: view.id }), c.toasts.confirmed, true)}
                />
              ))}
            </ul>
          )}
        </section>
      )}

      <ChangeLog state={state} when={when} />
    </div>
  );
}

function StatusPanel({
  state,
  busy,
  when,
  onReadAll,
}: {
  state: CollectionsState;
  busy: boolean;
  when: ReturnType<typeof useShopTime>;
  onReadAll: () => void;
}) {
  const { t } = useI18n();
  const s = t.collections.status;
  const { runner, index } = state;
  const progress = runner.progress;
  const working =
    runner.running === "full"
      ? s.reading(progress?.done ?? 0, progress?.total ?? null)
      : runner.running === "check"
        ? progress
          ? s.applying(progress.done, progress.total)
          : s.checking
        : runner.running === "apply" || runner.running === "product"
          ? s.applying(progress?.done ?? 0, progress?.total ?? null)
          : null;
  const cadence = !runner.scheduled ? s.off : runner.everyMinutes > 0 ? s.every(runner.everyMinutes) : s.daily;
  return (
    <section className="space-y-2 rounded-xl border border-line bg-surface p-4 shadow-xs">
      <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
        <span className="text-sm font-semibold tnum">
          {index.products > 0 ? s.products(index.products) : s.empty}
        </span>
        {index.lastSeen && <span className="text-xs text-faint">{s.lastSeen(when.dateTime(index.lastSeen))}</span>}
        <Button
          type="button"
          variant={index.products > 0 ? "outline" : "accent"}
          size="sm"
          className="ml-auto"
          disabled={busy || runner.running === "full"}
          onClick={onReadAll}
        >
          {index.products > 0 ? s.readAll : s.readFirst}
        </Button>
      </div>
      {working && (
        <p className="flex items-center gap-2 text-xs font-medium text-muted">
          <span className="spin h-3.5 w-3.5 rounded-full border-2 border-accent/30 border-t-accent" />
          {working}
        </p>
      )}
      <p className="text-xs text-muted">{cadence}</p>
      <p className="text-[11px] text-faint">{s.guard(runner.maxChanges)}</p>
      {runner.incremental === false && <p className="text-xs text-warn">{s.noIncremental}</p>}
      {runner.lastError && !working && (
        <p className="text-xs font-medium text-skip">
          {s.failed} {runner.lastError}
        </p>
      )}
    </section>
  );
}

function CollectionCard({
  view,
  path,
  maxChanges,
  when,
  busy,
  canEdit,
  onEdit,
  onPause,
  onConfirm,
}: {
  view: CollectionView;
  path: string;
  maxChanges: number;
  when: ReturnType<typeof useShopTime>;
  busy: boolean;
  canEdit: boolean;
  onEdit: () => void;
  onPause: (paused: boolean) => void;
  onConfirm: () => void;
}) {
  const { t } = useI18n();
  const l = t.collections.list;
  const knownError = view.lastError ? l.errors[view.lastError] : undefined;
  const status = !view.enabled
    ? { text: l.paused, tone: "bg-surface-2 text-faint" }
    : view.held
      ? { text: l.held, tone: "bg-warn/12 text-warn" }
      : view.lastError
        ? { text: l.problem, tone: "bg-skip/12 text-skip" }
        : { text: l.on, tone: "bg-create/12 text-create" };
  return (
    <li className={`rounded-xl border border-line bg-surface-2 p-3 ${view.enabled ? "" : "opacity-70"}`}>
      <div className="flex flex-wrap items-center gap-2">
        <span className="text-sm font-semibold">{path}</span>
        <span className={`rounded-full px-2 py-0.5 text-[10px] font-semibold uppercase tracking-wide ${status.tone}`}>
          {status.text}
        </span>
        <span className="text-xs text-muted tnum">
          {view.members != null ? l.members(view.members) : l.notCounted}
        </span>
        {view.lastRunAt && <span className="text-[11px] text-faint">{l.updated(when.dateTime(view.lastRunAt))}</span>}
        <div className="ml-auto flex items-center gap-1">
          <Button type="button" variant="ghost" size="sm" disabled={busy} onClick={() => onPause(view.enabled)}>
            {view.enabled ? l.pause : l.resume}
          </Button>
          <Button type="button" variant="outline" size="sm" disabled={busy || !canEdit} onClick={onEdit}>
            {l.edit}
          </Button>
        </div>
      </div>
      <p className="mt-1 text-xs text-muted">{describeRule(view, t.collections.words)}</p>
      {view.enabled && view.held && (
        <div className="mt-2 flex flex-wrap items-center gap-3 rounded-lg border border-warn/40 bg-warn/5 p-2.5">
          <p className="min-w-0 flex-1 text-xs text-ink">
            {view.held.reason === "empties"
              ? l.heldEmpties(view.held.leaving)
              : l.heldTooMany(view.held.joining, view.held.leaving, maxChanges)}
          </p>
          <Button type="button" variant="accent" size="sm" disabled={busy} onClick={onConfirm}>
            {l.confirm}
          </Button>
        </div>
      )}
      {view.enabled && view.lastError && (
        <p className="mt-2 text-xs font-medium text-skip">{knownError ?? l.refused(view.lastError)}</p>
      )}
    </li>
  );
}

function Editor({
  initial,
  state,
  busy,
  onCancel,
  onSave,
  onDelete,
}: {
  initial: EditorState;
  state: CollectionsState;
  busy: boolean;
  onCancel: () => void;
  onSave: (draft: ReturnType<typeof toDraft>, enabled: boolean) => void | Promise<void>;
  onDelete: (view: CollectionView) => void | Promise<void>;
}) {
  const { t } = useI18n();
  const e = t.collections.editor;
  const [draftState, setDraftState] = React.useState<EditorState>(initial);
  const draft = React.useMemo(() => toDraft(draftState), [draftState]);
  const { check, checking, error } = useDraftCheck(draft, state.index.products);
  const problems = check?.problems ?? [];
  const saved = initial.id ? state.collections.find((x) => x.id === initial.id) : undefined;
  const dirty = JSON.stringify(draft) !== JSON.stringify(toDraft(initial));
  const blocked = busy || !check || checking || problems.length > 0;
  const options = state.options!;
  const patch = (next: Partial<EditorState>) => setDraftState((prev) => ({ ...prev, ...next }));

  return (
    <section className="space-y-4 rounded-xl border border-line bg-surface p-4 shadow-xs">
      <div className="text-sm font-bold">{saved ? e.editTitle(saved.name) : e.newTitle}</div>

      <CategoryField state={draftState} onChange={patch} options={options} look={HUB_LOOK} />
      <MatchField value={draftState.match} onChange={(match) => patch({ match })} look={HUB_LOOK} />
      <ConditionsField
        conditions={draftState.conditions}
        onChange={(conditions) => patch({ conditions })}
        options={options}
        problems={problems}
        look={HUB_LOOK}
      />
      <RuleProblems problems={problems} look={HUB_LOOK} />

      <RulePreview
        preview={check?.preview ?? null}
        checking={checking}
        error={error}
        indexProducts={state.index.products}
        isNew={!initial.id}
        look={HUB_PREVIEW}
      />

      <div className="flex flex-wrap items-center gap-2">
        <Button type="button" variant="accent" disabled={blocked} onClick={() => void onSave(draft, true)}>
          {busy ? e.saving : draftState.categoryMode === "new" ? e.saveNew : e.save}
        </Button>
        <Button type="button" variant="outline" disabled={blocked} onClick={() => void onSave(draft, false)}>
          {e.savePaused}
        </Button>
        <Button
          type="button"
          variant="ghost"
          disabled={busy}
          onClick={() => (!dirty || window.confirm(e.unsavedConfirm)) && onCancel()}
        >
          {e.cancel}
        </Button>
        {saved && (
          <Button
            type="button"
            variant="ghost"
            className="ml-auto text-skip"
            disabled={busy}
            onClick={() => void onDelete(saved)}
          >
            {e.delete}
          </Button>
        )}
      </div>
    </section>
  );
}

function ChangeLog({ state, when }: { state: CollectionsState; when: ReturnType<typeof useShopTime> }) {
  const { t } = useI18n();
  const g = t.collections.log;
  return (
    <section className="rounded-xl border border-line bg-surface p-4 shadow-xs">
      <div className="text-sm font-bold">{g.title}</div>
      <p className="mt-0.5 text-xs text-muted">{g.hint}</p>
      {state.changes.length === 0 ? (
        <p className="mt-3 text-sm text-muted">{g.empty}</p>
      ) : (
        <ul className="mt-3 divide-y divide-line">
          {state.changes.map((row) => (
            <li key={row.id} className="flex flex-wrap items-baseline gap-x-3 gap-y-0.5 py-1.5 text-xs">
              <span className="w-28 shrink-0 text-faint tnum">{when.dateTime(row.at)}</span>
              <span className="min-w-0 flex-1 truncate font-medium" title={row.sku}>
                {row.productName || row.sku || `#${row.productId}`}
              </span>
              <span className={row.error ? "text-faint line-through" : row.action === "add" ? "text-create" : "text-skip"}>
                {row.action === "add" ? g.joined(row.categoryName) : g.left(row.categoryName)}
              </span>
              <span className="text-faint">{g.trigger[row.trigger] ?? row.trigger}</span>
              {row.error && <span className="w-full text-skip">{g.refused(row.error)}</span>}
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}
