"use client";

import * as React from "react";
import { useRouter } from "next/navigation";
import { AnimatePresence, motion, Reorder, useDragControls } from "motion/react";
import {
  Actions,
  ActionsButton,
  ActionsGroup,
  ActionsLabel,
  Block,
  Button,
  Dialog,
  DialogButton,
  Link as KLink,
  Navbar,
  Page,
  Preloader,
  Segmented,
  SegmentedButton,
} from "konsta/react";
import { toast } from "sonner";
import { useI18n } from "@/i18n/provider";
import { skuKey } from "@/lib/skus";
import {
  buildRows,
  countChanges,
  hide,
  pinToTop,
  pinsAfterPlacing,
  sameState,
  show,
  unpin,
  type EditorRow,
} from "@/lib/vetrina/order";
import type { BlockConfig } from "@/config";
import { describeRule } from "@/lib/collections/describe";
import { railCategory } from "@/lib/collections/rail";
import type { RailCollection } from "@/lib/collections/types";
import { changedFields, editableFields } from "@/lib/vetrina/fields";
import type { HiddenReason, ProductCard, RailDetail, RailFallback, SectionDraft } from "@/lib/vetrina/types";
import type { VetrinaRail, VetrinaResult } from "@/server/vetrina/service";
import { loadVetrinaCards, loadVetrinaRail, publishVetrinaRail } from "@/server/actions/vetrina";
import { CollectionSheet } from "./CollectionSheet";
import { ErrorState } from "./ErrorState";
import { FieldsSheet } from "./FieldsSheet";
import { HistorySheet } from "./HistorySheet";
import { ProductSheet } from "./ProductSheet";
import { formatFromPrice } from "./format";
import { ChevronLeft, ChevronRight, EyeOff, Funnel, Grip, Lock, More, Pin } from "./icons";
import { SEGMENTED_COLORS } from "./segmented";

export interface EditorOptions {
  fallbacks: RailFallback[];
  edit: BlockConfig["edit"];
  maxPins: number;
  maxLimit: number;
  pageSize: number;
}

const RAIL_BLOCK = "golden-hive/shortcode-wrapper";

/**
 * The rail editor: the rail as a list, in the order the site will show it.
 *
 * Pinned products ("fissati") come first, in the customer's order; the rest
 * follow automatically. Drag from the grip — or use the ⋯ sheet — to pin;
 * nothing reaches the site until "Pubblica". The order is recomputed on the
 * phone with the site's own rule (lib/vetrina/order.ts), so what the list
 * shows is what the homepage will render.
 */
export function RailEditor({
  railKey,
  initial,
  options,
}: {
  railKey: string;
  initial: VetrinaResult<VetrinaRail>;
  options: EditorOptions;
}) {
  const { t } = useI18n();
  if (!initial.ok) {
    return (
      <Page>
        <Navbar title={t.vetrina.title} left={<BackLink dirty={false} />} />
        <ErrorState code={initial.code} error={initial.error} />
      </Page>
    );
  }
  return <Editor railKey={railKey} initial={initial.data} options={options} />;
}

function BackLink({ dirty }: { dirty: boolean }) {
  const { t } = useI18n();
  const router = useRouter();
  return (
    <KLink
      onClick={() => {
        if (dirty && !window.confirm(t.vetrina.editor.leaveConfirm)) return;
        router.push("/vetrina");
      }}
      className="gap-0.5"
    >
      <ChevronLeft className="h-5 w-5" />
      {t.vetrina.title}
    </KLink>
  );
}

const stateOf = (rail: RailDetail): SectionDraft => ({
  pin: rail.pin,
  exclude: rail.exclude,
  fallback: rail.fallback,
  fields: rail.fields,
  limit: rail.limit,
});

const trimmed = (fields: Record<string, string>) =>
  Object.fromEntries(Object.entries(fields).map(([field, value]) => [field, value.trim()]));

function Editor({ railKey, initial, options }: { railKey: string; initial: VetrinaRail; options: EditorOptions }) {
  const { t } = useI18n();
  const v = t.vetrina.editor;
  const demo = initial.source === "fixture";

  // The rail as the server last described it, and the customer's draft over it.
  const [base, setBase] = React.useState<RailDetail>(initial.rail);
  const [draft, setDraft] = React.useState<SectionDraft>(() => stateOf(initial.rail));
  const saved = React.useMemo(() => stateOf(base), [base]);
  // The order, plus the section's texts and size: one draft, one publish.
  const fieldsChanged = changedFields(saved.fields, draft.fields);
  const resized = saved.limit !== draft.limit;
  const dirty = !sameState(saved, draft) || fieldsChanged.length > 0 || resized;
  const orderChanges = countChanges(saved, draft);
  const changes = { ...orderChanges, total: orderChanges.total + fieldsChanged.length + (resized ? 1 : 0) };

  // Automatic order per fallback: the server computes it once, the phone reuses it.
  const [visibleByFallback, setVisibleByFallback] = React.useState<Record<string, number[]>>({
    [initial.rail.previewFallback]: initial.rail.visible,
  });
  const visible = visibleByFallback[draft.fallback] ?? base.visible;
  const loadingFallback = visibleByFallback[draft.fallback] == null;

  const [cards, setCards] = React.useState(
    () => new Map<number, ProductCard>([...initial.rail.items, ...initial.rail.hidden].map((c) => [c.id, c])),
  );
  const [locks, setLocks] = React.useState<Record<string, number>>(initial.locks);
  // The rule filling the rail's category, when it is automatic.
  const [collection, setCollection] = React.useState<RailCollection | null>(initial.collection);
  const [reasons, setReasons] = React.useState(
    () => new Map<number, HiddenReason>(initial.rail.hidden.map((h) => [h.id, h.reason])),
  );

  const absorb = React.useCallback((more: ProductCard[], moreLocks: Record<string, number>) => {
    setCards((prev) => {
      const next = new Map(prev);
      for (const c of more) next.set(c.id, c);
      return next;
    });
    setLocks((prev) => ({ ...prev, ...moreLocks }));
  }, []);

  const adoptRail = React.useCallback(
    (data: VetrinaRail) => {
      setBase(data.rail);
      setVisibleByFallback((prev) => ({ ...prev, [data.rail.previewFallback]: data.rail.visible }));
      setReasons(new Map(data.rail.hidden.map((h) => [h.id, h.reason])));
      setCollection(data.collection);
      absorb([...data.rail.items, ...data.rail.hidden], data.locks);
    },
    [absorb],
  );

  /**
   * The category's members moved (its rule changed, a product's tags did):
   * read the rail again. The draft stays — pins and hides are the
   * customer's — but every automatic order cached so far is stale.
   */
  const reloadMembers = React.useCallback(async () => {
    const fresh = await loadVetrinaRail({ key: railKey, fallback: draft.fallback });
    if (!fresh.ok) {
      toast.error(t.vetrina.errors[fresh.code] ?? fresh.error);
      return;
    }
    setVisibleByFallback({ [fresh.data.rail.previewFallback]: fresh.data.rail.visible });
    adoptRail(fresh.data);
  }, [railKey, draft.fallback, adoptRail, t]);

  // A fallback we have no automatic order for yet: ask the site (nothing is saved).
  React.useEffect(() => {
    if (!loadingFallback) return;
    let cancelled = false;
    loadVetrinaRail({ key: railKey, fallback: draft.fallback }).then((res) => {
      if (cancelled) return;
      if (!res.ok) {
        toast.error(t.vetrina.errors[res.code] ?? res.error);
        return;
      }
      setVisibleByFallback((prev) => ({ ...prev, [draft.fallback]: res.data.rail.visible }));
      absorb([...res.data.rail.items, ...res.data.rail.hidden], res.data.locks);
    });
    return () => {
      cancelled = true;
    };
  }, [loadingFallback, draft.fallback, railKey, absorb, t]);

  const rows = React.useMemo(() => buildRows(visible, draft), [visible, draft]);
  const rowById = React.useMemo(() => new Map(rows.map((r) => [r.id, r])), [rows]);

  // Drag: the list moves freely while dragging; the pins are decided on drop,
  // against the list as it was when the drag began — so a drag that ends
  // where it started changes nothing.
  const [dragIds, setDragIds] = React.useState<number[] | null>(null);
  const drag = React.useRef<{ rows: EditorRow[]; id: number; ids: number[] } | null>(null);

  const [shown, setShown] = React.useState(options.pageSize);
  const orderIds = dragIds ?? rows.map((r) => r.id);
  const renderIds = orderIds.slice(0, shown);

  // Cards scrolled into view (or brought in by a change) that we do not hold
  // yet — each asked for once, so a failing request cannot loop.
  const requested = React.useRef(new Set<number>());
  const wantedKey = [...new Set([...renderIds, ...draft.exclude])]
    .filter((id) => !cards.has(id) && !requested.current.has(id))
    .slice(0, 100)
    .join(",");
  React.useEffect(() => {
    if (!wantedKey) return;
    const ids = wantedKey.split(",").map(Number);
    for (const id of ids) requested.current.add(id);
    loadVetrinaCards({ ids }).then((res) => {
      if (res.ok) absorb(res.data.cards, res.data.locks);
    });
  }, [wantedKey, absorb]);

  // Leaving with unpublished changes asks first.
  React.useEffect(() => {
    if (!dirty) return;
    const warn = (e: BeforeUnloadEvent) => e.preventDefault();
    window.addEventListener("beforeunload", warn);
    return () => window.removeEventListener("beforeunload", warn);
  }, [dirty]);

  function commit(next: SectionDraft, message: string) {
    if (next.pin.length > options.maxPins) {
      toast.error(v.limitReached(options.maxPins));
      return;
    }
    const before = draft;
    setDraft(next);
    toast.dismiss();
    toast(message, { action: { label: v.undo, onClick: () => setDraft(before) }, duration: 4000 });
  }

  function onDragStart(id: number) {
    drag.current = { rows, id, ids: rows.map((r) => r.id) };
    setDragIds(drag.current.ids);
  }
  function onReorder(subset: number[]) {
    const d = drag.current;
    if (!d) return;
    d.ids = [...subset, ...d.ids.slice(subset.length)];
    setDragIds(d.ids);
  }
  function onDragEnd() {
    const d = drag.current;
    drag.current = null;
    setDragIds(null);
    if (!d) return;
    const from = d.rows.findIndex((r) => r.id === d.id);
    const to = d.ids.indexOf(d.id);
    if (to < 0 || from === to) return;
    commit({ ...draft, pin: pinsAfterPlacing(d.rows, d.id, to) }, v.moved.dragged);
  }

  // Positions and the fold, over the order being shown (ghosts take no place).
  const positions = new Map<number, number>();
  let visibleCount = 0;
  let foldAfter: number | null = null;
  for (const id of orderIds) {
    if (rowById.get(id)?.kind === "ghost") continue;
    visibleCount += 1;
    positions.set(id, visibleCount);
    if (visibleCount === draft.limit) foldAfter = id;
  }

  // Menus and sheets.
  const [menuFor, setMenuFor] = React.useState<number | null>(null);
  const [sectionMenu, setSectionMenu] = React.useState(false);
  const [positionFor, setPositionFor] = React.useState<number | null>(null);
  const [positionValue, setPositionValue] = React.useState("");
  const [historyOpen, setHistoryOpen] = React.useState(false);
  const [looksOpen, setLooksOpen] = React.useState(false);
  const [productFor, setProductFor] = React.useState<number | null>(null);
  const [ruleOpen, setRuleOpen] = React.useState(false);
  const [publishing, setPublishing] = React.useState(false);
  const [stale, setStale] = React.useState(false);

  const menuCard = menuFor != null ? cards.get(menuFor) : undefined;
  const menuRow = menuFor != null ? rowById.get(menuFor) : undefined;

  function placeAt(id: number, position: number) {
    // Position N = the N-th product the site shows; ghosts are skipped.
    let seen = 0;
    let index = rows.length - 1;
    for (let i = 0; i < rows.length; i++) {
      if (rows[i].kind === "ghost") continue;
      seen += 1;
      if (seen === position) {
        index = i;
        break;
      }
    }
    commit({ ...draft, pin: pinsAfterPlacing(rows, id, index) }, v.moved.position(position));
  }

  async function publish() {
    setPublishing(true);
    try {
      const res = await publishVetrinaRail({
        key: railKey,
        expectedModifiedGmt: base.modifiedGmt,
        expectedAttrsHash: base.attrsHash,
        ...draft,
      });
      if (res.ok) {
        const fresh = await loadVetrinaRail({ key: railKey });
        if (fresh.ok) {
          adoptRail(fresh.data);
          setDraft(stateOf(fresh.data.rail));
        }
        toast.dismiss();
        toast.success(demo ? v.publishedDemo : v.published, {
          action: base.pageLink
            ? { label: t.vetrina.viewSite, onClick: () => window.open(base.pageLink, "_blank", "noreferrer") }
            : undefined,
        });
        return;
      }
      if (res.code === "stale") {
        // Someone changed the page: take the new version, keep the draft.
        const fresh = await loadVetrinaRail({ key: railKey, fallback: draft.fallback });
        if (fresh.ok) adoptRail(fresh.data);
        setStale(true);
        return;
      }
      toast.error(t.vetrina.errors[res.code] ?? res.error);
    } finally {
      setPublishing(false);
    }
  }

  // Texts and size: what the config allows and the site's plugin supports.
  const s = t.vetrina.section;
  const fieldKeys = editableFields(RAIL_BLOCK, options.edit.fields, base.fields);
  const canResize = options.edit.limit && base.editable && Object.keys(base.fields).length > 0;
  const canEditLooks = fieldKeys.length > 0 || canResize;
  const shownTitle = "title" in draft.fields ? draft.fields.title : base.title;
  const shownEyebrow = "eyebrow" in draft.fields ? draft.fields.eyebrow : base.eyebrow;

  const hiddenIds = draft.exclude;
  const termName = base.terms.map((term) => term.name).join(", ");
  // Only a rail showing exactly one category can be filled by a rule.
  const categoryId = railCategory(base);
  const auto = t.vetrina.auto;
  const termLabel = base.taxonomy === "product_cat" ? v.termCategory : v.termBrand;
  const fallbackChoices = options.fallbacks.includes(draft.fallback) ? options.fallbacks : [...options.fallbacks, draft.fallback];

  return (
    <Page>
      <Navbar
        title={shownTitle || base.key}
        subtitle={shownEyebrow || undefined}
        left={<BackLink dirty={dirty} />}
        right={
          <KLink onClick={() => setSectionMenu(true)} aria-label={v.menu.title}>
            <More className="h-6 w-6" />
          </KLink>
        }
      />

      <div className="px-4 pb-2 pt-3">
        <p className="text-[14px] leading-snug opacity-60">
          {termName && (
            <>
              {termLabel}: <span className="font-medium">{termName}</span> ·{" "}
            </>
          )}
          {v.visibleCount(visibleCount)}
        </p>
        {!base.editable && <p className="mt-2 text-[15px]">{v.readOnly}</p>}
      </div>

      {categoryId != null && (
        <div className="px-4 pb-3">
          <button
            type="button"
            onClick={() => setRuleOpen(true)}
            className="flex w-full items-center gap-3 rounded-2xl bg-white px-4 py-3 text-left shadow-sm transition-opacity active:opacity-60 dark:bg-[#1c1c1e]"
          >
            <Funnel className={`h-5 w-5 shrink-0 ${collection?.enabled ? "text-[#b8860b]" : "opacity-40"}`} />
            <span className="min-w-0 flex-1">
              <span className="block text-[12px] font-semibold uppercase tracking-wide opacity-50">
                {collection ? (collection.enabled ? auto.card : auto.paused) : auto.make}
              </span>
              <span className="block text-[15px] font-medium leading-snug">
                {collection ? describeRule(collection, t.collections.words) : auto.makeHint}
              </span>
              {collection && (
                <span
                  className={`mt-0.5 block text-[13px] leading-snug ${
                    collection.enabled && (collection.held || collection.lastError) ? "text-amber-700 dark:text-amber-400" : "opacity-60"
                  }`}
                >
                  {!collection.enabled
                    ? auto.cardPaused
                    : collection.held
                      ? auto.heldHint
                      : collection.lastError
                        ? auto.problem
                        : collection.members != null
                          ? `${auto.members(collection.members)} · ${auto.cardHint}`
                          : auto.cardHint}
                </span>
              )}
            </span>
            <ChevronRight className="h-5 w-5 shrink-0 opacity-30" />
          </button>
        </div>
      )}

      {canEditLooks && (
        <div className="px-4 pb-3">
          <button
            type="button"
            onClick={() => setLooksOpen(true)}
            className="flex w-full items-center gap-3 rounded-2xl bg-white px-4 py-3 text-left shadow-sm transition-opacity active:opacity-60 dark:bg-[#1c1c1e]"
          >
            <span className="min-w-0 flex-1">
              <span className="block text-[12px] font-semibold uppercase tracking-wide opacity-50">{s.open}</span>
              <span className="block truncate text-[15px] font-medium">
                {[shownEyebrow, shownTitle].filter(Boolean).join(" · ") || base.key}
              </span>
            </span>
            {(fieldsChanged.length > 0 || resized) && <span className="h-2 w-2 shrink-0 rounded-full bg-[#d4a017]" aria-hidden />}
            <ChevronRight className="h-5 w-5 shrink-0 opacity-30" />
          </button>
        </div>
      )}

      {options.edit.fallback && base.editable && (
        <div className="px-4 pb-3">
          <div className="mb-1.5 flex items-center gap-2 text-[13px] opacity-60">
            {v.autoLabel}
            {loadingFallback && <Preloader className="!h-4 !w-4" />}
          </div>
          <Segmented strong rounded colors={SEGMENTED_COLORS}>
            {fallbackChoices.map((f) => (
              <SegmentedButton
                key={f}
                active={draft.fallback === f}
                onClick={() => draft.fallback !== f && commit({ ...draft, fallback: f }, v.moved.fallback)}
              >
                {v.fallbacks[f] ?? f}
              </SegmentedButton>
            ))}
          </Segmented>
        </div>
      )}

      <Reorder.Group
        as="ul"
        axis="y"
        values={renderIds}
        onReorder={onReorder}
        className="mx-4 overflow-hidden rounded-2xl bg-white shadow-sm dark:bg-[#1c1c1e]"
      >
        {renderIds.map((id) => (
          <RailRow
            key={id}
            id={id}
            card={cards.get(id)}
            kind={rowById.get(id)?.kind ?? "auto"}
            position={positions.get(id) ?? null}
            reason={reasons.get(id)}
            locked={(locks[skuKey(cards.get(id)?.sku ?? "")] ?? 0) > 0}
            fold={foldAfter === id ? v.fold(base.limit) : null}
            draggable={options.edit.pins && base.editable}
            onDragStart={onDragStart}
            onDragEnd={onDragEnd}
            onOpen={setMenuFor}
          />
        ))}
      </Reorder.Group>

      {orderIds.length > shown && (
        <Block className="!my-3">
          <Button clear large onClick={() => setShown((s) => s + options.pageSize)}>
            {v.loadMore}
          </Button>
        </Block>
      )}

      {hiddenIds.length > 0 && (
        <>
          <div className="px-5 pb-1.5 pt-6 text-[13px] font-semibold uppercase tracking-wide opacity-50">
            {v.hiddenTitle}
          </div>
          <ul className="mx-4 overflow-hidden rounded-2xl bg-white shadow-sm dark:bg-[#1c1c1e]">
            {hiddenIds.map((id) => {
              const card = cards.get(id);
              return (
                <li key={id} className="flex items-center gap-3 border-b border-black/5 px-3 py-2.5 last:border-0 dark:border-white/10">
                  <Thumb card={card} dim />
                  <div className="min-w-0 flex-1">
                    <div className="line-clamp-2 text-[15px] leading-snug opacity-60">{card?.name ?? `#${id}`}</div>
                    <div className="mt-0.5 flex items-center gap-1 text-[13px] opacity-50">
                      <EyeOff className="h-3.5 w-3.5" />
                      {v.reasons.excluded}
                    </div>
                  </div>
                  {options.edit.exclude && (
                    <Button small rounded tonal inline onClick={() => commit(show(draft, id), v.moved.shown)}>
                      {v.showAgain}
                    </Button>
                  )}
                </li>
              );
            })}
          </ul>
        </>
      )}

      {/* Room for the publish bar. */}
      <div className="h-[calc(env(safe-area-inset-bottom)+120px)]" />

      <AnimatePresence>
        {dirty && (
          <motion.div
            initial={{ y: 120 }}
            animate={{ y: 0 }}
            exit={{ y: 120 }}
            transition={{ type: "spring", damping: 26, stiffness: 320 }}
            className="fixed inset-x-0 bottom-0 z-30 border-t border-black/10 bg-white/85 px-4 pb-[calc(env(safe-area-inset-bottom)+12px)] pt-3 backdrop-blur-xl dark:border-white/10 dark:bg-black/80"
          >
            <div className="mx-auto flex max-w-xl items-center gap-3">
              <span className="min-w-0 flex-1 text-[15px] font-medium">{v.changes(changes.total || 1)}</span>
              <Button
                clear
                inline
                rounded
                disabled={publishing}
                onClick={() => window.confirm(v.discardConfirm) && setDraft(saved)}
              >
                {v.discard}
              </Button>
              <Button
                rounded
                inline
                large
                disabled={publishing}
                onClick={publish}
                colors={{ fillTextIos: "text-white dark:text-black", fillTextMaterial: "text-white dark:text-black" }}
                className="min-w-32"
              >
                {publishing ? v.publishing : v.publish}
              </Button>
            </div>
          </motion.div>
        )}
      </AnimatePresence>

      {/* Row actions. */}
      <Actions opened={menuFor != null} onBackdropClick={() => setMenuFor(null)}>
        <ActionsGroup>
          <ActionsLabel>{menuCard?.name ?? ""}</ActionsLabel>
          {options.edit.pins && base.editable && menuFor != null && (
            <>
              <ActionsButton
                onClick={() => {
                  commit({ ...draft, pin: pinToTop(draft.pin, menuFor) }, v.moved.top);
                  setMenuFor(null);
                }}
              >
                {v.actions.top}
              </ActionsButton>
              <ActionsButton
                onClick={() => {
                  setPositionValue(String(positions.get(menuFor) ?? 1));
                  setPositionFor(menuFor);
                  setMenuFor(null);
                }}
              >
                {v.actions.position}
              </ActionsButton>
              {menuRow && menuRow.kind !== "auto" && (
                <ActionsButton
                  onClick={() => {
                    commit({ ...draft, pin: unpin(draft.pin, menuFor) }, v.moved.unpinned);
                    setMenuFor(null);
                  }}
                >
                  {v.actions.unpin}
                </ActionsButton>
              )}
            </>
          )}
          {options.edit.exclude && base.editable && menuFor != null && (
            <ActionsButton
              onClick={() => {
                commit(hide(draft, menuFor), v.moved.hidden);
                setMenuFor(null);
              }}
            >
              {v.actions.hide}
            </ActionsButton>
          )}
          {menuFor != null && (
            <ActionsButton
              onClick={() => {
                setProductFor(menuFor);
                setMenuFor(null);
              }}
            >
              {v.actions.prices}
            </ActionsButton>
          )}
          {menuCard?.permalink && (
            <ActionsButton
              onClick={() => {
                window.open(menuCard.permalink, "_blank", "noreferrer");
                setMenuFor(null);
              }}
            >
              {v.actions.openSite}
            </ActionsButton>
          )}
        </ActionsGroup>
        <ActionsGroup>
          <ActionsButton bold onClick={() => setMenuFor(null)}>
            {v.actions.cancel}
          </ActionsButton>
        </ActionsGroup>
      </Actions>

      {/* Section menu. */}
      <Actions opened={sectionMenu} onBackdropClick={() => setSectionMenu(false)}>
        <ActionsGroup>
          <ActionsLabel>{shownTitle || base.key}</ActionsLabel>
          {canEditLooks && (
            <ActionsButton
              onClick={() => {
                setSectionMenu(false);
                setLooksOpen(true);
              }}
            >
              {s.open}
            </ActionsButton>
          )}
          {categoryId != null && (
            <ActionsButton
              onClick={() => {
                setSectionMenu(false);
                setRuleOpen(true);
              }}
            >
              {auto.menu}
            </ActionsButton>
          )}
          <ActionsButton
            onClick={() => {
              setSectionMenu(false);
              setHistoryOpen(true);
            }}
          >
            {v.menu.history}
          </ActionsButton>
          {options.edit.pins && base.editable && draft.pin.length > 0 && (
            <ActionsButton
              onClick={() => {
                setSectionMenu(false);
                commit({ ...draft, pin: [] }, v.moved.reset);
              }}
            >
              {v.menu.reset}
            </ActionsButton>
          )}
          {base.pageLink && (
            <ActionsButton
              onClick={() => {
                window.open(base.pageLink, "_blank", "noreferrer");
                setSectionMenu(false);
              }}
            >
              {v.menu.viewSite}
            </ActionsButton>
          )}
          {base.terms[0]?.link && (
            <ActionsButton
              onClick={() => {
                window.open(base.terms[0].link ?? "", "_blank", "noreferrer");
                setSectionMenu(false);
              }}
            >
              {v.menu.category}
            </ActionsButton>
          )}
        </ActionsGroup>
        <ActionsGroup>
          <ActionsButton bold onClick={() => setSectionMenu(false)}>
            {v.actions.cancel}
          </ActionsButton>
        </ActionsGroup>
      </Actions>

      {/* Move to position N. */}
      <Dialog
        opened={positionFor != null}
        onBackdropClick={() => setPositionFor(null)}
        title={v.positionTitle}
        content={
          <input
            type="number"
            inputMode="numeric"
            enterKeyHint="done"
            min={1}
            max={visibleCount}
            value={positionValue}
            onChange={(e) => setPositionValue(e.target.value)}
            aria-label={v.positionHint(visibleCount)}
            placeholder={v.positionHint(visibleCount)}
            className="mt-2 w-full rounded-xl border border-black/10 bg-black/[0.03] px-3 py-2.5 text-center text-[20px] font-semibold tabular-nums outline-none dark:border-white/15 dark:bg-white/10"
          />
        }
        buttons={
          <>
            <DialogButton onClick={() => setPositionFor(null)}>{v.actions.cancel}</DialogButton>
            <DialogButton
              strong
              onClick={() => {
                const n = Math.round(Number(positionValue));
                if (positionFor != null && n >= 1) placeAt(positionFor, Math.min(n, visibleCount));
                setPositionFor(null);
              }}
            >
              {v.positionConfirm}
            </DialogButton>
          </>
        }
      />

      {/* The page changed under us: publish again over the new version? */}
      <Dialog
        opened={stale}
        onBackdropClick={() => setStale(false)}
        title={v.stale.title}
        content={v.stale.body}
        buttons={
          <>
            <DialogButton onClick={() => setStale(false)}>{v.stale.close}</DialogButton>
            <DialogButton
              strong
              onClick={() => {
                setStale(false);
                void publish();
              }}
            >
              {v.stale.retry}
            </DialogButton>
          </>
        }
      />

      <HistorySheet
        open={historyOpen}
        railKey={railKey}
        current={saved}
        onClose={() => setHistoryOpen(false)}
        onRestore={(state) => {
          setHistoryOpen(false);
          commit({ ...draft, ...state }, v.moved.restored);
        }}
      />

      <FieldsSheet
        open={looksOpen}
        title={s.sheetTitle}
        blockName={RAIL_BLOCK}
        fieldKeys={fieldKeys}
        values={draft.fields}
        limit={canResize ? { value: draft.limit, max: Math.max(options.maxLimit, draft.limit) } : undefined}
        preview
        submitLabel={s.apply}
        onSubmit={(fields, limit) => {
          const next = { ...draft, fields: { ...draft.fields, ...trimmed(fields) }, limit: limit ?? draft.limit };
          const texts = changedFields(draft.fields, next.fields).length > 0;
          if (texts || next.limit !== draft.limit) {
            commit(next, texts ? s.applied : s.resized(next.limit));
          }
          return true;
        }}
        onClose={() => setLooksOpen(false)}
      />

      <ProductSheet
        card={productFor != null ? cards.get(productFor) ?? null : null}
        onClose={() => setProductFor(null)}
        onLocksChanged={(sku, count) => setLocks((prev) => ({ ...prev, [skuKey(sku)]: count }))}
        onPricesChanged={(id) => {
          void loadVetrinaCards({ ids: [id] }).then((res) => {
            if (res.ok) absorb(res.data.cards, res.data.locks);
          });
        }}
        onTagsChanged={() => void reloadMembers()}
        demo={demo}
      />

      <CollectionSheet
        termId={ruleOpen ? categoryId : null}
        termName={termName}
        onClose={() => setRuleOpen(false)}
        onChanged={() => void reloadMembers()}
      />
    </Page>
  );
}

function Thumb({ card, dim }: { card?: ProductCard; dim?: boolean }) {
  return (
    // eslint-disable-next-line @next/next/no-img-element -- the shop's own thumbnail sizes
    <img
      src={card?.image || undefined}
      alt=""
      loading="lazy"
      draggable={false}
      className={`h-14 w-14 shrink-0 overflow-hidden rounded-xl bg-black/[0.04] object-contain text-[0px] dark:bg-white/10 ${dim ? "opacity-50" : ""}`}
    />
  );
}

function RailRow({
  id,
  card,
  kind,
  position,
  reason,
  locked,
  fold,
  draggable,
  onDragStart,
  onDragEnd,
  onOpen,
}: {
  id: number;
  card?: ProductCard;
  kind: EditorRow["kind"];
  position: number | null;
  reason?: HiddenReason;
  locked: boolean;
  fold: string | null;
  draggable: boolean;
  onDragStart: (id: number) => void;
  onDragEnd: () => void;
  onOpen: (id: number) => void;
}) {
  const { t } = useI18n();
  const v = t.vetrina.editor;
  const controls = useDragControls();
  const ghost = kind === "ghost";

  return (
    <Reorder.Item
      as="li"
      value={id}
      dragListener={false}
      dragControls={controls}
      onDragStart={() => onDragStart(id)}
      onDragEnd={onDragEnd}
      whileDrag={{ scale: 1.02, boxShadow: "0 12px 32px -12px rgba(0,0,0,0.35)" }}
      className="relative select-none border-b border-black/5 bg-white last:border-0 dark:border-white/10 dark:bg-[#1c1c1e]"
    >
      <div className="flex items-center gap-3 py-2 pl-3 pr-1">
        <span className="w-6 shrink-0 text-right text-[13px] font-medium tabular-nums opacity-50">
          {position ?? "–"}
        </span>
        <button
          type="button"
          onClick={() => onOpen(id)}
          className="flex min-w-0 flex-1 items-center gap-3 text-left active:opacity-60"
        >
          <Thumb card={card} dim={ghost} />
          <span className="min-w-0 flex-1">
            <span className={`line-clamp-2 text-[15px] font-medium leading-snug ${ghost ? "opacity-50" : ""}`}>
              {card?.name ?? "…"}
            </span>
            <span className="mt-0.5 flex flex-wrap items-center gap-x-2 gap-y-0.5 text-[13px]">
              {card && <span className="tabular-nums opacity-60">{formatFromPrice(card, v.from)}</span>}
              {kind !== "auto" && (
                <span className="inline-flex items-center gap-0.5 font-semibold text-amber-700 dark:text-amber-400">
                  <Pin className="h-3 w-3" />
                  {v.pinned}
                </span>
              )}
              {locked && <Lock className="h-3.5 w-3.5 opacity-60" />}
            </span>
            {ghost && (
              <span className="mt-0.5 block text-[13px] text-orange-600 dark:text-orange-400">
                {v.reasons[reason ?? "unknown"] ?? v.reasons.unknown}
              </span>
            )}
          </span>
        </button>
        <button
          type="button"
          aria-label={v.rowMenu}
          onClick={() => onOpen(id)}
          className="grid h-11 w-9 shrink-0 place-items-center opacity-40 active:opacity-20"
        >
          <More className="h-5 w-5" />
        </button>
        {draggable && (
          <div
            role="button"
            aria-label={v.dragHandle}
            onPointerDown={(e) => {
              e.preventDefault();
              controls.start(e);
            }}
            style={{ touchAction: "none" }}
            className="grid h-12 w-10 shrink-0 cursor-grab place-items-center opacity-35 active:cursor-grabbing"
          >
            <Grip className="h-5 w-5" />
          </div>
        )}
      </div>
      {fold && (
        <div className="flex items-center gap-2 px-4 pb-2 pt-1 text-[12px] font-semibold uppercase tracking-wide text-amber-700 dark:text-amber-400">
          <span className="h-px flex-1 bg-current opacity-40" />
          {fold}
          <span className="h-px flex-1 bg-current opacity-40" />
        </div>
      )}
    </Reorder.Item>
  );
}
