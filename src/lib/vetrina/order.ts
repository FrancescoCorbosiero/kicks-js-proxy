/**
 * How a Vetrina rail orders its products — the same rule the site applies
 * (golden-hive-blocks, ghb_hub_order_ids), so the phone can reorder
 * instantly and still show exactly what the homepage will render.
 *
 *   pinned products first, in pin order, only those the site can show;
 *   then every other visible product in the automatic order;
 *   excluded products never.
 *
 * Pure module: used by the editor (client) and the demo source (server).
 */

import type { RailState } from "./types";

/** The rail's order: see the module comment. */
export function orderIds(visible: number[], pin: number[], exclude: number[]): number[] {
  const visibleSet = new Set(visible);
  const excluded = new Set(exclude);
  const out: number[] = [];
  const seen = new Set<number>();
  for (const id of pin) {
    if (visibleSet.has(id) && !excluded.has(id) && !seen.has(id)) {
      out.push(id);
      seen.add(id);
    }
  }
  for (const id of visible) {
    if (!excluded.has(id) && !seen.has(id)) {
      out.push(id);
      seen.add(id);
    }
  }
  return out;
}

/**
 * One row of the editor list:
 *  - "pinned": a position the customer chose;
 *  - "ghost": a pinned product the site cannot show right now (sold out,
 *    hidden) — it keeps its place and comes back when it can;
 *  - "auto": everything after the pins, in the automatic order.
 */
export interface EditorRow {
  id: number;
  kind: "pinned" | "ghost" | "auto";
}

/** The editor's list for a state: pins (visible or ghost) first, then the automatic rest. */
export function buildRows(visible: number[], state: Pick<RailState, "pin" | "exclude">): EditorRow[] {
  const visibleSet = new Set(visible);
  const excluded = new Set(state.exclude);
  const rows: EditorRow[] = [];
  const pinned = new Set<number>();
  for (const id of state.pin) {
    if (excluded.has(id) || pinned.has(id)) continue;
    pinned.add(id);
    rows.push({ id, kind: visibleSet.has(id) ? "pinned" : "ghost" });
  }
  for (const id of visible) {
    if (!excluded.has(id) && !pinned.has(id)) rows.push({ id, kind: "auto" });
  }
  return rows;
}

/**
 * The pins a reordered list implies. Pins are always a prefix of the list:
 * every row above the lowest pinned one (or the one just dropped) becomes
 * pinned too — "what you placed stays placed, and so does what is above it".
 */
export function pinsFromRows(rows: EditorRow[], dropped?: number): number[] {
  let last = -1;
  rows.forEach((row, i) => {
    if (row.kind !== "auto" || row.id === dropped) last = i;
  });
  return rows.slice(0, last + 1).map((r) => r.id);
}

/** Move one row (array semantics: remove at `from`, insert at `to`). */
export function moveRow<T>(rows: T[], from: number, to: number): T[] {
  if (from === to || from < 0 || from >= rows.length) return rows;
  const next = rows.slice();
  const [item] = next.splice(from, 1);
  next.splice(Math.max(0, Math.min(to, next.length)), 0, item);
  return next;
}

/** Pins after dragging/placing `id` at a 0-based row index. */
export function pinsAfterPlacing(rows: EditorRow[], id: number, index: number): number[] {
  const from = rows.findIndex((r) => r.id === id);
  if (from < 0) return rows.filter((r) => r.kind !== "auto").map((r) => r.id);
  return pinsFromRows(moveRow(rows, from, index), id);
}

/** "In cima": first place, everything else keeps its order. */
export function pinToTop(pin: number[], id: number): number[] {
  return [id, ...pin.filter((p) => p !== id)];
}

/** "Togli posizione fissa": back to the automatic order. */
export function unpin(pin: number[], id: number): number[] {
  return pin.filter((p) => p !== id);
}

/** "Nascondi da questa sezione": never shown here, and no longer pinned. */
export function hide(state: RailState, id: number): RailState {
  return {
    ...state,
    pin: unpin(state.pin, id),
    exclude: state.exclude.includes(id) ? state.exclude : [...state.exclude, id],
  };
}

/** "Mostra di nuovo". */
export function show(state: RailState, id: number): RailState {
  return { ...state, exclude: state.exclude.filter((e) => e !== id) };
}

export function sameState(a: RailState, b: RailState): boolean {
  return (
    a.fallback === b.fallback &&
    a.pin.length === b.pin.length &&
    a.pin.every((id, i) => b.pin[i] === id) &&
    a.exclude.length === b.exclude.length &&
    [...a.exclude].sort((x, y) => x - y).every((id, i) => [...b.exclude].sort((x, y) => x - y)[i] === id)
  );
}

/** What a publish will change, counted for the publish bar ("3 modifiche"). */
export interface StateChanges {
  /** Pinned products whose position is new (added, moved or reordered). */
  placed: number;
  /** Products that went back to the automatic order. */
  unpinned: number;
  hidden: number;
  shown: number;
  fallback: boolean;
  total: number;
}

export function countChanges(before: RailState, after: RailState): StateChanges {
  const beforePos = new Map(before.pin.map((id, i) => [id, i]));
  const afterSet = new Set(after.pin);
  let placed = 0;
  after.pin.forEach((id, i) => {
    if (beforePos.get(id) !== i) placed += 1;
  });
  const unpinned = before.pin.filter((id) => !afterSet.has(id) && !after.exclude.includes(id)).length;
  const beforeEx = new Set(before.exclude);
  const afterEx = new Set(after.exclude);
  const hidden = after.exclude.filter((id) => !beforeEx.has(id)).length;
  const shown = before.exclude.filter((id) => !afterEx.has(id)).length;
  const fallback = before.fallback !== after.fallback;
  return { placed, unpinned, hidden, shown, fallback, total: placed + unpinned + hidden + shown + (fallback ? 1 : 0) };
}

/**
 * Rail keys in URLs: "category:saldi-sneakers-outlet#0" ⇄
 * "category.saldi-sneakers-outlet.0". Slugs never contain dots, and the
 * dotted form survives every router and share sheet unescaped.
 */
export function railKeyToParam(key: string): string {
  const hash = key.lastIndexOf("#");
  const base = hash < 0 ? key : key.slice(0, hash);
  const n = hash < 0 ? "0" : key.slice(hash + 1);
  const colon = base.indexOf(":");
  const kind = colon < 0 ? base : base.slice(0, colon);
  const value = colon < 0 ? "" : base.slice(colon + 1);
  return `${kind}.${value}.${n}`;
}

export function paramToRailKey(param: string): string | null {
  const first = param.indexOf(".");
  const last = param.lastIndexOf(".");
  if (first < 0 || last === first) return null;
  const kind = param.slice(0, first);
  const value = param.slice(first + 1, last);
  const n = param.slice(last + 1);
  if (!/^[a-z_]+$/.test(kind) || !/^\d+$/.test(n)) return null;
  return value === "" ? `${kind}#${n}` : `${kind}:${value}#${n}`;
}
