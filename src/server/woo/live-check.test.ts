import { describe, it, expect } from "vitest";
import { decideLiveWrites } from "./live-check";
import type { ApplyChange } from "./apply";

const change = (over: Partial<ApplyChange> = {}): ApplyChange => ({
  sku: "DD1391-100",
  sizeLabel: "42",
  stockxVariantId: "v42",
  storeProductId: 7,
  storeVariationId: 71,
  currentPrice: 120,
  newPrice: 110,
  newStock: null,
  newGtin: null,
  euSize: "42",
  ...over,
});

const live = (id: number, price: string | null, gtin: string | null = null, qty: number | null = null) => ({
  id,
  regular_price: price,
  global_unique_id: gtin,
  manage_stock: qty != null,
  stock_quantity: qty,
});

describe("decideLiveWrites — the last look before an unattended write", () => {
  it("writes as planned while the store is where the plan left it", () => {
    const d = decideLiveWrites([change()], [live(71, "120.00")]);
    expect(d.write).toEqual([change()]);
    expect(d.kept).toEqual([]);
    expect(d.gone).toEqual([]);
  });

  it("keeps a price changed on the store since the plan was made", () => {
    const d = decideLiveWrites([change()], [live(71, "149.99")]);
    expect(d.write).toEqual([]); // nothing else to write on that size
    expect(d.kept).toEqual([{ change: change(), storePrice: 149.99 }]);
  });

  it("still writes the stock of a size whose price it keeps", () => {
    const d = decideLiveWrites([change({ newStock: 2 })], [live(71, "149.99", null, 5)]);
    expect(d.write).toEqual([change({ newStock: 2, newPrice: null })]);
    expect(d.kept).toHaveLength(1);
  });

  it("…but not a quantity the store already shows: nothing is left to write", () => {
    const d = decideLiveWrites([change({ newStock: 2 })], [live(71, "149.99", null, 2)]);
    expect(d.write).toEqual([]);
    expect(d.kept).toHaveLength(1);
  });

  it("someone set exactly the price the Hub wanted: written, nothing to keep", () => {
    const d = decideLiveWrites([change()], [live(71, "110.00")]);
    expect(d.write).toEqual([change()]);
    expect(d.kept).toEqual([]);
  });

  it("a size gone from the store is not written to", () => {
    const d = decideLiveWrites([change(), change({ storeVariationId: 72, stockxVariantId: "v43" })], [live(71, "120")]);
    expect(d.write.map((c) => c.storeVariationId)).toEqual([71]);
    expect(d.gone.map((c) => c.storeVariationId)).toEqual([72]);
  });

  it("a price taken off the store is not written over, and there is nothing to keep", () => {
    const d = decideLiveWrites([change()], [live(71, "")]);
    expect(d.write).toEqual([]);
    expect(d.kept).toEqual([]);
  });

  it("a size the snapshot knew without a price is written when it still has none", () => {
    const d = decideLiveWrites([change({ currentPrice: null })], [live(71, null)]);
    expect(d.write).toEqual([change({ currentPrice: null })]);
  });

  it("an identifier that appeared meanwhile is never overwritten", () => {
    const d = decideLiveWrites([change({ newGtin: "0195866123456", newPrice: null, newStock: 1 })], [live(71, "120", "0195866999999")]);
    expect(d.write).toEqual([change({ newGtin: null, newPrice: null, newStock: 1 })]);
  });

  it("stock-only changes go through whatever the store's price is", () => {
    const d = decideLiveWrites([change({ newPrice: null, newStock: 0 })], [live(71, "999")]);
    expect(d.write).toEqual([change({ newPrice: null, newStock: 0 })]);
    expect(d.kept).toEqual([]);
  });
});
