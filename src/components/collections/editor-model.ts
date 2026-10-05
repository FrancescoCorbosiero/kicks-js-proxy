"use client";

import * as React from "react";
import { FIELD_OPS, type CollectionCondition, type ConditionField } from "@core/collections";
import type {
  CollectionDraft,
  CollectionsStatus,
  CollectionView,
  DraftCheck,
  DraftProblem,
} from "@/lib/collections/types";
import { checkCollectionDraft, pollCollections } from "@/server/actions/collections";

/**
 * The rule editor's state, shared by the Hub's page and the Vetrina's sheet:
 * the same draft, the same checks, the same preview — only the look differs.
 */

export interface EditorCondition extends CollectionCondition {
  /** A stable React key: conditions have no id of their own. */
  key: string;
}

export interface EditorState {
  id?: string;
  /** An existing category, or a new one created on save. */
  categoryMode: "existing" | "new";
  termId: number | null;
  newName: string;
  newParent: number;
  match: "all" | "any";
  conditions: EditorCondition[];
  enabled: boolean;
}

let sequence = 0;
const nextKey = () => `condition-${++sequence}`;

export function blankCondition(field: ConditionField = "tag"): EditorCondition {
  return { key: nextKey(), field, op: FIELD_OPS[field][0], value: "" };
}

/** A condition switched to another field: what it said about the old one no longer applies. */
export function withField(c: EditorCondition, field: ConditionField): EditorCondition {
  return { key: c.key, field, op: FIELD_OPS[field][0], value: "" };
}

/** The editor opened on a saved collection, or on a new one (for a given category, when known). */
export function editorFrom(view?: CollectionView | null, termId?: number | null): EditorState {
  if (view) {
    return {
      id: view.id,
      categoryMode: "existing",
      termId: view.termId,
      newName: "",
      newParent: 0,
      match: view.match,
      conditions: view.conditions.map((c) => ({ ...c, key: nextKey() })),
      enabled: view.enabled,
    };
  }
  return {
    categoryMode: "existing",
    termId: termId ?? null,
    newName: "",
    newParent: 0,
    match: "all",
    conditions: [blankCondition()],
    enabled: true,
  };
}

export function toDraft(state: EditorState): CollectionDraft {
  const fresh = state.categoryMode === "new";
  return {
    ...(state.id ? { id: state.id } : {}),
    ...(!fresh && state.termId ? { termId: state.termId } : {}),
    ...(fresh && state.newName.trim() ? { newCategory: { name: state.newName.trim(), parent: state.newParent } } : {}),
    match: state.match,
    conditions: state.conditions.map(({ key: _key, ...c }) => c),
    enabled: state.enabled,
  };
}

/** The problem pointing at one condition, if any. */
export function conditionProblem(problems: DraftProblem[], index: number): DraftProblem | undefined {
  return problems.find((p) => "index" in p && p.index === index);
}

/**
 * Check the draft against the store index shortly after the last edit: the
 * problems to point at, and what saving would do. Answers that arrive late
 * for an older draft are dropped. `indexProducts` checks again when the
 * index grows — the first read of the store lands while the editor is open.
 */
export function useDraftCheck(
  draft: CollectionDraft | null,
  indexProducts = 0,
): {
  check: DraftCheck | null;
  checking: boolean;
  error: string | null;
} {
  const [check, setCheck] = React.useState<DraftCheck | null>(null);
  const [checking, setChecking] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);
  const latest = React.useRef(0);
  const key = draft ? JSON.stringify(draft) : "";

  React.useEffect(() => {
    if (!key) return;
    const ticket = ++latest.current;
    setChecking(true);
    const timer = setTimeout(async () => {
      const res = await checkCollectionDraft(JSON.parse(key));
      if (ticket !== latest.current) return;
      setChecking(false);
      if (res.ok) {
        setCheck(res.data);
        setError(null);
      } else {
        setError(res.error);
      }
    }, 350);
    return () => clearTimeout(timer);
  }, [key, indexProducts]);

  return { check, checking, error };
}

/**
 * Follow the runs a save started until they are done (or `timeoutMs` passes):
 * the last status seen — what the run moved, or why it failed — or null when
 * the server could not be asked.
 */
export async function waitForRuns(timeoutMs = 60_000): Promise<{ status: CollectionsStatus | null; done: boolean }> {
  const deadline = Date.now() + timeoutMs;
  let status: CollectionsStatus | null = null;
  for (;;) {
    const res = await pollCollections();
    if (res.ok) {
      status = res.data;
      if (status.runner.running == null && status.runner.queued === 0) return { status, done: true };
    }
    if (Date.now() > deadline) return { status, done: false };
    await new Promise((resolve) => setTimeout(resolve, 1000));
  }
}
