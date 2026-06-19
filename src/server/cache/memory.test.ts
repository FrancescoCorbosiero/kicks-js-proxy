import { describe, it, expect } from "vitest";
import { MemoryCache, getOrSet } from "./memory";

describe("MemoryCache", () => {
  it("stores and returns a value before expiry", async () => {
    let now = 1000;
    const cache = new MemoryCache(() => now);
    await cache.set("k", { a: 1 }, 10); // expires at 11000
    now = 5000;
    expect(await cache.get<{ a: number }>("k")).toEqual({ a: 1 });
  });

  it("returns null after TTL elapses", async () => {
    let now = 1000;
    const cache = new MemoryCache(() => now);
    await cache.set("k", "v", 10);
    now = 12000; // past 11000
    expect(await cache.get("k")).toBeNull();
  });

  it("returns null for unknown keys", async () => {
    const cache = new MemoryCache();
    expect(await cache.get("nope")).toBeNull();
  });
});

describe("getOrSet", () => {
  it("computes and caches on miss, then serves from cache", async () => {
    const cache = new MemoryCache();
    let calls = 0;
    const compute = async () => {
      calls += 1;
      return "value";
    };

    const first = await getOrSet(cache, "k", 60, compute);
    expect(first).toEqual({ value: "value", hit: false });

    const second = await getOrSet(cache, "k", 60, compute);
    expect(second).toEqual({ value: "value", hit: true });
    expect(calls).toBe(1);
  });
});
