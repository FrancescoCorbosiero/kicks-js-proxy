import { describe, it, expect } from "vitest";
import type { StoreProductModel } from "./model";
import { planProductSanitize } from "./sanitize-plan";

/**
 * A REST-pulled product (array-shaped attributes) with the real corruption mix:
 * a clean/corrupt duplicate pair, a zero-stock ghost, a zero-stock size that IS
 * on KicksDB, a misaligned pa_taglia, and a stale parent option list.
 */
function product(): StoreProductModel {
  return {
    id: 304782,
    sku: "IE7002",
    name: "adidas Gazelle Indoor",
    attributes: [
      { id: 3, name: "pa_taglia", variation: true, options: ["stale", "36", "36 2/3"] },
    ],
    variations: [
      // Clean web-app row, real stock, already-correct taglia.
      { id: 333908, sku: "IE7002-EU36", stock_quantity: 1, attributes: [{ id: 3, name: "pa_taglia", option: "36" }] },
      // Stale snapshot twin of size 36 (corrupt encoding, fake stock) -> delete.
      { id: 306619, sku: "IE7002-36", stock_quantity: 80, attributes: [{ id: 3, name: "pa_taglia", option: "36" }] },
      // Zero-stock ghost NOT on KicksDB -> delete.
      { id: 306620, sku: "IE7002-EU37", stock_quantity: 0, attributes: [{ id: 3, name: "pa_taglia", option: "37" }] },
      // Zero-stock but ON KicksDB -> keep + make available.
      { id: 306621, sku: "IE7002-EU38", stock_quantity: 0, stock_status: "outofstock", manage_stock: true, attributes: [{ id: 3, name: "pa_taglia", option: "38" }] },
      // Misaligned taglia (corrupt dash triple) -> rewrite in place.
      { id: 306668, sku: "IE7002-4223", stock_quantity: 80, attributes: [{ id: 3, name: "pa_taglia", option: "42-2-3" }] },
    ],
  };
}

describe("planProductSanitize", () => {
  it("plans deletions for ghosts and stale duplicates", () => {
    const ops = planProductSanitize(product(), new Set([333908, 306621]))!;
    expect(ops).not.toBeNull();
    expect(ops.deleteVariationIds.sort()).toEqual([306619, 306620]);
    expect(ops.counts.ghostsRemoved).toBe(1);
    expect(ops.counts.duplicatesRemoved).toBe(1);
  });

  it("rewrites survivors: made-available stock and realigned pa_taglia", () => {
    const ops = planProductSanitize(product(), new Set([333908, 306621]))!;

    const madeAvailable = ops.variationWrites.find((w) => w.id === 306621)!;
    expect(madeAvailable.stock_status).toBe("instock");
    expect(madeAvailable.manage_stock).toBe(false);

    const realigned = ops.variationWrites.find((w) => w.id === 306668)!;
    expect(realigned.attributes).toEqual([{ id: 3, name: "pa_taglia", option: "42 2/3" }]);

    // The clean row needed nothing — no write for it.
    expect(ops.variationWrites.some((w) => w.id === 333908)).toBe(false);
  });

  it("realigns the parent pa_taglia option list to the surviving sizes", () => {
    const ops = planProductSanitize(product(), new Set([333908, 306621]))!;
    expect(ops.parentAttributes).toEqual([
      { id: 3, name: "pa_taglia", variation: true, options: ["36", "38", "42 2/3"] },
    ]);
  });

  it("never mutates the input and exposes the desired end state", () => {
    const input = product();
    const ops = planProductSanitize(input, new Set([333908, 306621]))!;
    expect(input.variations).toHaveLength(5); // untouched
    expect(ops.sanitized.variations.map((v) => v.id).sort()).toEqual([306621, 306668, 333908]);
  });

  it("returns null for an already-aligned product", () => {
    const clean: StoreProductModel = {
      id: 1,
      sku: "AA-1",
      attributes: [{ id: 3, name: "pa_taglia", variation: true, options: ["36"] }],
      variations: [
        { id: 11, sku: "AA-1-EU36", stock_quantity: 2, attributes: [{ id: 3, name: "pa_taglia", option: "36" }] },
      ],
    };
    expect(planProductSanitize(clean)).toBeNull();
  });
});
