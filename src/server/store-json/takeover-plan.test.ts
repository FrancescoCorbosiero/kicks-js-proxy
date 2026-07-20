import { describe, it, expect } from "vitest";
import type { StoreProductModel } from "./model";
import { planFeedTakeover } from "./takeover-plan";

/**
 * A store product mid-takeover: KicksDB-era sizes (38, 44), unparseable junk,
 * a corrupt duplicate of a feed size, and two feed-known sizes. GS knows
 * 36 (active), 36 2/3 (active) and 37 (deactivated).
 */
function product(): StoreProductModel {
  return {
    id: 900,
    sku: "JS3801",
    name: "adidas Gazelle Indoor J",
    attributes: [
      { id: 1, name: "pa_brand", options: ["Adidas"], visible: true },
      { id: 3, name: "pa_taglia", variation: true, options: ["36", "38", "44"] },
    ],
    variations: [
      // Feed-known, clean.
      { id: 1, sku: "JS3801-EU36", stock_quantity: 1, attributes: [{ id: 3, name: "pa_taglia", option: "36" }] },
      // Feed-known via corrupt label -> kept + realigned.
      { id: 2, sku: "JS3801-3623", stock_quantity: 9, attributes: [{ id: 3, name: "pa_taglia", option: "36-2-3" }] },
      // Same size clean twin -> best kept, corrupt one deleted as duplicate.
      { id: 3, sku: "JS3801-EU36 2/3", stock_quantity: 1, attributes: [{ id: 3, name: "pa_taglia", option: "36 2/3" }] },
      // Feed-known but DEACTIVATED size -> kept (stock sync zeroes it).
      { id: 4, sku: "JS3801-EU37", stock_quantity: 2, attributes: [{ id: 3, name: "pa_taglia", option: "37" }] },
      // KicksDB-era sizes the feed never listed -> deleted.
      { id: 5, sku: "JS3801-EU38", stock_quantity: 3, attributes: [{ id: 3, name: "pa_taglia", option: "38" }] },
      { id: 6, sku: "JS3801-EU44", stock_quantity: 1, attributes: [{ id: 3, name: "pa_taglia", option: "44" }] },
      // Unparseable junk -> deleted.
      { id: 7, sku: "JS3801-XXL", attributes: [] },
    ],
  };
}

const KNOWN = new Set(["36", "36.67", "37"]);

describe("planFeedTakeover", () => {
  const ops = planFeedTakeover(product(), KNOWN, 3)!;

  it("deletes out-of-feed sizes, junk, and same-size losers — keeps feed sizes", () => {
    expect(ops).not.toBeNull();
    expect(ops.takeover).toBe(true);
    expect(ops.deleteVariationIds.sort()).toEqual([2, 5, 6, 7]);
    expect(ops.sanitized.variations.map((v) => v.id)).toEqual([1, 3, 4]);
    expect(ops.counts.duplicatesRemoved).toBe(1); // the corrupt 36 2/3 twin
    expect(ops.counts.ghostsRemoved).toBe(3); // out-of-feed trims (38, 44, junk)
  });

  it("keeps deactivated feed sizes — zeroing is the stock sync's job, not deletion", () => {
    expect(ops.sanitized.variations.some((v) => v.id === 4)).toBe(true);
  });

  it("realigns the parent pa_taglia to exactly the surviving feed sizes", () => {
    expect(ops.parentAttributes).toEqual([
      { id: 1, name: "pa_brand", options: ["Adidas"], visible: true },
      { id: 3, name: "pa_taglia", variation: true, visible: true, options: ["36", "36 2/3", "37"] },
    ]);
  });

  it("returns null for an already-pure feed product", () => {
    const clean: StoreProductModel = {
      id: 901,
      sku: "JS3801",
      attributes: [{ id: 3, name: "pa_taglia", variation: true, visible: true, options: ["36"] }],
      variations: [
        { id: 1, sku: "JS3801-EU36", attributes: [{ id: 3, name: "pa_taglia", option: "36" }] },
      ],
    };
    expect(planFeedTakeover(clean, new Set(["36"]), 3)).toBeNull();
  });

  it("refuses to trim against an empty feed truth", () => {
    expect(planFeedTakeover(product(), new Set())).toBeNull();
  });
});
