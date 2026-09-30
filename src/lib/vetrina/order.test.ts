import { describe, expect, it } from "vitest";
import {
  buildRows,
  countChanges,
  hide,
  moveRow,
  orderIds,
  paramToRailKey,
  pinToTop,
  pinsAfterPlacing,
  pinsFromRows,
  railKeyToParam,
  sameState,
  show,
  unpin,
} from "./order";

describe("orderIds — the site's rule", () => {
  it("puts visible pins first in pin order, then the rest, never exclusions", () => {
    expect(orderIds([10, 20, 30, 40, 50], [40, 99, 10], [20])).toEqual([40, 10, 30, 50]);
  });
  it("counts a duplicate pin once", () => {
    expect(orderIds([1, 2], [2, 2, 1], [])).toEqual([2, 1]);
  });
  it("is empty when everything is excluded", () => {
    expect(orderIds([1, 2], [], [1, 2])).toEqual([]);
  });
});

describe("editor rows", () => {
  const visible = [1, 2, 3, 4, 5];

  it("lists pins (ghosts included) before the automatic rest", () => {
    expect(buildRows(visible, { pin: [3, 9, 1], exclude: [5] })).toEqual([
      { id: 3, kind: "pinned" },
      { id: 9, kind: "ghost" },
      { id: 1, kind: "pinned" },
      { id: 2, kind: "auto" },
      { id: 4, kind: "auto" },
    ]);
  });

  it("an excluded pin is not a row", () => {
    expect(buildRows(visible, { pin: [2], exclude: [2] }).map((r) => r.id)).toEqual([1, 3, 4, 5]);
  });

  it("dropping an automatic product pins it and everything above it", () => {
    const rows = buildRows(visible, { pin: [3], exclude: [] }); // 3 | 1 2 4 5
    // Drag 5 to index 2 → 3 1 5 2 4: 3 stays pinned, 1 is above 5 so it becomes pinned too.
    expect(pinsAfterPlacing(rows, 5, 2)).toEqual([3, 1, 5]);
  });

  it("reordering inside the pins keeps the same pins", () => {
    const rows = buildRows(visible, { pin: [3, 1, 2], exclude: [] });
    expect(pinsAfterPlacing(rows, 3, 2)).toEqual([1, 2, 3]);
  });

  it("dragging a pinned product into the automatic zone keeps it pinned there", () => {
    const rows = buildRows(visible, { pin: [3, 1], exclude: [] }); // 3 1 | 2 4 5
    expect(pinsAfterPlacing(rows, 3, 3)).toEqual([1, 2, 4, 3]);
  });

  it("a ghost keeps its place among the pins", () => {
    const rows = buildRows(visible, { pin: [9, 1], exclude: [] }); // 9(ghost) 1 | 2 3 4 5
    expect(pinsFromRows(moveRow(rows, 1, 0), 1)).toEqual([1, 9]);
  });

  it("with no pins and no drop, nothing is pinned", () => {
    expect(pinsFromRows(buildRows(visible, { pin: [], exclude: [] }))).toEqual([]);
  });
});

describe("row actions", () => {
  const base = { pin: [3, 1], exclude: [7], fallback: "menu_order" as const };

  it("pins to the top", () => {
    expect(pinToTop([3, 1], 5)).toEqual([5, 3, 1]);
    expect(pinToTop([3, 1], 1)).toEqual([1, 3]);
  });
  it("unpins", () => {
    expect(unpin([3, 1], 3)).toEqual([1]);
  });
  it("hiding unpins and excludes", () => {
    expect(hide(base, 3)).toEqual({ pin: [1], exclude: [7, 3], fallback: "menu_order" });
  });
  it("showing again removes the exclusion", () => {
    expect(show(base, 7).exclude).toEqual([]);
  });
});

describe("changes", () => {
  const before = { pin: [3, 1], exclude: [7], fallback: "menu_order" as const };

  it("recognises the same state, exclusions in any order", () => {
    expect(sameState(before, { pin: [3, 1], exclude: [7], fallback: "menu_order" })).toBe(true);
    expect(sameState({ ...before, exclude: [7, 8] }, { ...before, exclude: [8, 7] })).toBe(true);
    expect(sameState(before, { ...before, pin: [1, 3] })).toBe(false);
  });

  it("counts what a publish changes", () => {
    const after = { pin: [5, 3], exclude: [], fallback: "date" as const };
    expect(countChanges(before, after)).toEqual({
      placed: 2, // 5 is new; 3 moved from first to second
      unpinned: 1, // 1
      hidden: 0,
      shown: 1, // 7
      fallback: true,
      total: 5,
    });
  });
});

describe("rail keys in URLs", () => {
  it.each([
    ["category:saldi-sneakers-outlet#0", "category.saldi-sneakers-outlet.0"],
    ["brand:nike-off-white#1", "brand.nike-off-white.1"],
    ["type:recent#0", "type.recent.0"],
    ["ids#0", "ids..0"],
  ])("%s ⇄ %s", (key, param) => {
    expect(railKeyToParam(key)).toBe(param);
    expect(paramToRailKey(param)).toBe(key);
  });

  it("rejects what is not a key", () => {
    expect(paramToRailKey("nonsense")).toBeNull();
    expect(paramToRailKey("category.x.y")).toBeNull();
  });
});
