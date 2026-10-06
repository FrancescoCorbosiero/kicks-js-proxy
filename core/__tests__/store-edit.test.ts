import { describe, it, expect } from "vitest";
import { buildPlan, samePrice, storeEditOf } from "../core-spine";
import type { SourceProduct, SourceVariant, VariantMapping } from "../core-spine";
import { makeConfig, makeProduct, makeVariant, rule } from "./helpers";

/**
 * A price changed on the store — in WordPress, by hand or by another plugin —
 * after the Hub last wrote it is KEPT: the plan never writes over it. The
 * ledger's last written price (`hubPrice`) is what tells such an edit apart
 * from the store's own history.
 */

// markup 0, no VAT, no rounding -> proposed price == lowestAsk.
const cfg = (extra: Partial<Parameters<typeof rule>[0]> = {}) =>
  makeConfig([rule({ id: "g", scope: {}, markupPercent: 0, rounding: { mode: "none" }, ...extra })]);

const mapping = (over: Partial<VariantMapping> = {}): [string, VariantMapping] => [
  "v1",
  { stockxVariantId: "v1", storeProductId: 100, storeVariationId: 11, currentPrice: 100, ...over },
];

const plan = (ask: number, over: Partial<VariantMapping>, config = cfg()) =>
  buildPlan(makeProduct([makeVariant("v1", ask)]), config, new Map([mapping(over)])).items[0];

describe("storeEditOf", () => {
  it("is null without a ledger record — a variation the Hub never wrote", () => {
    expect(storeEditOf({ currentPrice: 120, hubPrice: null })).toBeNull();
    expect(storeEditOf({ currentPrice: 120 })).toBeNull();
  });

  it("is null when the store shows what the Hub wrote, to the cent", () => {
    expect(storeEditOf({ currentPrice: 135.99, hubPrice: 135.99 })).toBeNull();
    // "135.99" read back from the store against a float that went through arithmetic
    expect(storeEditOf({ currentPrice: 135.99, hubPrice: 135.99000000001 })).toBeNull();
    expect(samePrice(135.99, 135.994)).toBe(true);
  });

  it("names both prices when the store moved", () => {
    expect(storeEditOf({ currentPrice: 149.99, hubPrice: 135.99 })).toEqual({ storePrice: 149.99, hubPrice: 135.99 });
    expect(samePrice(135.99, 136)).toBe(false);
  });

  it("is null when the store has no price to compare", () => {
    expect(storeEditOf({ currentPrice: null, hubPrice: 100 })).toBeNull();
  });
});

describe("buildPlan keeps a price changed on the store", () => {
  it("never writes over it: the row is held with both prices", () => {
    // Hub wrote 100, someone set 120 in WordPress, the rules now say 110.
    const item = plan(110, { currentPrice: 120, hubPrice: 100 });
    expect(item.action).toBe("skip");
    expect(item.proposedPrice).toBe(110); // what the Hub would write — shown, not written
    expect(item.storeEdit).toEqual({ storePrice: 120, hubPrice: 100 });
    expect(item.reason).toContain("changed on the store");
  });

  it("plans as before when the Hub has no record of the variation", () => {
    const item = plan(110, { currentPrice: 120 });
    expect(item).toMatchObject({ action: "update", proposedPrice: 110 });
    expect(item.storeEdit).toBeUndefined();
  });

  it("plans as before when the store still shows the Hub's price", () => {
    const item = plan(110, { currentPrice: 100, hubPrice: 100 });
    expect(item).toMatchObject({ action: "update", currentPrice: 100, proposedPrice: 110 });
    expect(item.storeEdit).toBeUndefined();
  });

  it("an edit the Hub agrees with is simply in step", () => {
    const item = plan(120, { currentPrice: 120, hubPrice: 100 });
    expect(item.action).toBe("noop");
    expect(item.storeEdit).toBeUndefined();
  });

  it("an edit within the anti-churn threshold is left alone without being flagged", () => {
    const item = plan(100, { currentPrice: 101, hubPrice: 100 }, cfg({ minDeltaPercent: 3 }));
    expect(item.action).toBe("noop");
    expect(item.storeEdit).toBeUndefined();
  });

  it("a sale price set on the store is the sale rule's business, not a held edit", () => {
    const item = plan(110, { currentPrice: 120, hubPrice: 100, saleActive: true });
    expect(item.action).toBe("skip");
    expect(item.reason).toContain("discounted");
    expect(item.storeEdit).toBeUndefined();
  });
});

describe("buildPlan keeps a store-edited price over a lock too", () => {
  it("a lock is not written over a later edit on the store", () => {
    // Locked at 150 and written; then set to 160 in WordPress.
    const item = plan(110, { currentPrice: 160, hubPrice: 150, manualPrice: 150 });
    expect(item.action).toBe("skip");
    expect(item.locked).toBe(true);
    expect(item.proposedPrice).toBe(150);
    expect(item.storeEdit).toEqual({ storePrice: 160, hubPrice: 150 });
  });

  it("a new lock is written as usual: the store still shows the Hub's last price", () => {
    const item = plan(110, { currentPrice: 100, hubPrice: 100, manualPrice: 150 });
    expect(item).toMatchObject({ action: "update", proposedPrice: 150, locked: true });
    expect(item.storeEdit).toBeUndefined();
  });

  it("a lock the store already shows is a noop, whatever the ledger says", () => {
    const item = plan(110, { currentPrice: 150, hubPrice: 140, manualPrice: 150 });
    expect(item.action).toBe("noop");
    expect(item.storeEdit).toBeUndefined();
  });
});

describe("a held price on a feed product still syncs its stock", () => {
  const feed = (variants: SourceVariant[]): SourceProduct => ({ ...makeProduct(variants), source: "goldensneakers" });

  it("stock drift becomes a stock-only update that carries the edit", () => {
    const p = buildPlan(
      feed([makeVariant("v1", 110, 3)]),
      cfg(),
      new Map([mapping({ currentPrice: 120, hubPrice: 100, currentStock: 1 })]),
      { manageStockFromSource: true },
    );
    const item = p.items[0];
    expect(item.action).toBe("update");
    expect(item.proposedPrice).toBeNull(); // the price is not touched…
    expect(item.stockQuantity).toBe(3); // …the quantity is
    expect(item.storeEdit).toEqual({ storePrice: 120, hubPrice: 100 });
    expect(item.reason).toContain("stock only");
  });

  it("no stock drift: the row is held like any other", () => {
    const p = buildPlan(
      feed([makeVariant("v1", 110, 3)]),
      cfg(),
      new Map([mapping({ currentPrice: 120, hubPrice: 100, currentStock: 3 })]),
      { manageStockFromSource: true },
    );
    expect(p.items[0].action).toBe("skip");
    expect(p.items[0].storeEdit).toBeDefined();
  });
});
