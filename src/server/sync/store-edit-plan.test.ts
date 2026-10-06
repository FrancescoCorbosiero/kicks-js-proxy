import { describe, it, expect } from "vitest";
import type { PlanItem } from "@core/core-spine";
import { ledgerUpdatesFor, type LedgerEntry, type PlannedRow } from "./store-edit-plan";

const item = (over: Partial<PlanItem> = {}): PlanItem => ({
  stockxVariantId: "v42",
  sizeLabel: "42",
  storeProductId: 7,
  storeVariationId: 71,
  currentPrice: 120,
  proposedPrice: 110,
  action: "update",
  euSize: "42",
  ...over,
});

const row = (over: Partial<PlanItem> = {}): PlannedRow => ({
  item: item(over),
  sku: "DD1391-100",
  title: "Dunk Low Panda",
  sizeLabel: "42",
});

const ledger = (entries: [number, LedgerEntry][]) => new Map(entries);

describe("ledgerUpdatesFor — what a plan tells the price ledger", () => {
  it("notes every kept row, with what names it", () => {
    const { notes, settles } = ledgerUpdatesFor(
      [row({ action: "skip", currentPrice: 149.99, storeEdit: { storePrice: 149.99, hubPrice: 120 } })],
      ledger([[71, { price: 120, storePrice: null }]]),
    );
    expect(notes).toEqual([
      {
        variationId: 71,
        productId: 7,
        sku: "DD1391-100",
        euSize: "42",
        storePrice: 149.99,
        hubPrice: 120,
        title: "Dunk Low Panda",
        sizeLabel: "42",
      },
    ]);
    expect(settles).toEqual([]);
  });

  it("closes an edit the store undid: it shows the Hub's price again", () => {
    const { notes, settles } = ledgerUpdatesFor([row({ currentPrice: 120 })], ledger([[71, { price: 120, storePrice: 149.99 }]]));
    expect(notes).toEqual([]);
    expect(settles).toEqual([{ variationId: 71 }]);
  });

  it("adopts a store price the rules ask for too: it is the Hub's own from now on", () => {
    const { settles } = ledgerUpdatesFor(
      [row({ action: "noop", currentPrice: 110, proposedPrice: 110 })],
      ledger([[71, { price: 120, storePrice: null }]]),
    );
    expect(settles).toEqual([{ variationId: 71, price: 110 }]);
  });

  it("leaves a kept edit listed while the Hub has nothing to write there", () => {
    // A sale price on the store today: the Hub writes nothing, the edit is still the store's.
    const { notes, settles } = ledgerUpdatesFor(
      [row({ action: "skip", currentPrice: 149.99, proposedPrice: 110, reason: "discounted — sale price preserved" })],
      ledger([[71, { price: 120, storePrice: 149.99 }]]),
    );
    expect(notes).toEqual([]);
    expect(settles).toEqual([]);
  });

  it("says nothing about a variation the Hub never wrote", () => {
    const { notes, settles } = ledgerUpdatesFor([row({ currentPrice: 120 })], ledger([]));
    expect(notes).toEqual([]);
    expect(settles).toEqual([]);
  });

  it("an in-step variation with nothing open stays untouched", () => {
    const { settles } = ledgerUpdatesFor([row({ currentPrice: 120 })], ledger([[71, { price: 120, storePrice: null }]]));
    expect(settles).toEqual([]);
  });

  it("adopts a size it has never seen whose price is already in step", () => {
    const { adopt, notes, settles } = ledgerUpdatesFor(
      [row({ action: "noop", currentPrice: 110, proposedPrice: 110 })],
      ledger([]),
    );
    expect(adopt).toEqual([
      { variationId: 71, productId: 7, sku: "DD1391-100", euSize: "42", price: 110, title: "Dunk Low Panda", sizeLabel: "42" },
    ]);
    expect(notes).toEqual([]);
    expect(settles).toEqual([]);
  });

  it("adopts the store's price under the anti-churn threshold too: the Hub is content with it", () => {
    const { adopt } = ledgerUpdatesFor(
      [row({ action: "noop", currentPrice: 101, proposedPrice: 100, reason: "within minDeltaPercent (3%)" })],
      ledger([]),
    );
    expect(adopt.map((a) => a.price)).toEqual([101]);
  });

  it("adopts a stock-only write next to the same price", () => {
    const { adopt } = ledgerUpdatesFor(
      [row({ action: "update", currentPrice: 110, proposedPrice: 110, stockQuantity: 3, reason: "stock change" })],
      ledger([]),
    );
    expect(adopt.map((a) => a.price)).toEqual([110]);
  });

  it("does not adopt a size about to be written: the write records it", () => {
    const { adopt } = ledgerUpdatesFor([row({ currentPrice: 120, proposedPrice: 110 })], ledger([]));
    expect(adopt).toEqual([]);
  });

  it("never adopts over the ledger's own word", () => {
    const { adopt } = ledgerUpdatesFor(
      [row({ action: "noop", currentPrice: 110, proposedPrice: 110 })],
      ledger([[71, { price: 110, storePrice: null }]]),
    );
    expect(adopt).toEqual([]);
  });

  it("ignores rows that are not on the store", () => {
    const { notes, settles } = ledgerUpdatesFor(
      [row({ storeVariationId: null, storeProductId: null, action: "create" })],
      ledger([[71, { price: 120, storePrice: 149.99 }]]),
    );
    expect(notes).toEqual([]);
    expect(settles).toEqual([]);
  });
});
