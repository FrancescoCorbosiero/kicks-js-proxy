"use client";

import * as React from "react";
import { FIELD_OPS, type CollectionCondition, type ConditionField } from "@core/collections";
import type { CollectionDraft, CollectionView, DraftCheck, DraftProblem } from "@/lib/collections/types";
import { checkCollectionDraft } from "@/server/actions/collections";

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
 * for an older draft are dropped.
 */
export function useDraftCheck(draft: CollectionDraft | null): {
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
  }, [key]);

  return { check, checking, error };
}
