import { describe, expect, it } from "vitest";
import {
  FIRST_BATCH,
  MAX_BATCH,
  MIN_BATCH,
  TARGET_BATCH_MS,
  nextBatchSize,
  nextPace,
} from "./publish-batching";

describe("publish batching", () => {
  it("measures the first pace as is, then averages", () => {
    expect(nextPace(null, 30_000, 6)).toBe(5_000);
    expect(nextPace(5_000, 9_000, 3)).toBe(4_000);
  });

  it("sizes a batch to take about the target time", () => {
    // ~3.5 s per product (10.5 s each, three at a time): 12 fit in 45 s.
    expect(nextBatchSize(12, 3_500)).toBe(12);
    expect(nextBatchSize(12, 3_500) * 3_500).toBeLessThanOrEqual(TARGET_BATCH_MS);
  });

  it("grows gradually after a quick batch, up to the ceiling", () => {
    expect(nextBatchSize(FIRST_BATCH, 100)).toBe(9);
    let size = FIRST_BATCH;
    for (let i = 0; i < 10; i++) size = nextBatchSize(size, 100);
    expect(size).toBe(MAX_BATCH);
  });

  it("shrinks right away when the shop is slow — down to the floor", () => {
    // A batch the proxy dropped after 100 s: 6 products, ~16.7 s each.
    const pace = nextPace(null, 100_000, 6);
    expect(nextBatchSize(FIRST_BATCH, pace)).toBe(MIN_BATCH);
    expect(nextBatchSize(10, 9_000)).toBe(5);
  });
});
