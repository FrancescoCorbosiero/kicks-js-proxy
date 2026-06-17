import { describe, it, expect } from "vitest";
import { euSize } from "./sizes";
import { isExactMatch } from "./match";

describe("euSize", () => {
  it("returns the EU size when present", () => {
    expect(euSize([{ system: "us m", size: "9" }, { system: "eu", size: "42.5" }])).toBe("42.5");
  });
  it("matches systems like 'eu m'", () => {
    expect(euSize([{ system: "eu m", size: "43" }])).toBe("43");
  });
  it("returns null when no EU conversion exists", () => {
    expect(euSize([{ system: "us m", size: "9" }, { system: "uk", size: "8" }])).toBeNull();
  });
  it("returns null for missing/empty input", () => {
    expect(euSize(undefined)).toBeNull();
    expect(euSize([])).toBeNull();
  });
});

describe("isExactMatch", () => {
  it("matches SKU case-insensitively", () => {
    expect(isExactMatch("ct8012-047", "CT8012-047", "Air Jordan 1")).toBe(true);
  });
  it("matches an exact title", () => {
    expect(isExactMatch("Air Jordan 1", "X", "air jordan 1")).toBe(true);
  });
  it("matches a title that contains the full query phrase", () => {
    expect(isExactMatch("Bred Toe", "X", "Air Jordan 1 Retro High OG Bred Toe")).toBe(true);
  });
  it("does not match unrelated text", () => {
    expect(isExactMatch("Yeezy", "CT8012-047", "Air Jordan 1")).toBe(false);
  });
  it("is false for an empty term", () => {
    expect(isExactMatch("  ", "X", "Y")).toBe(false);
  });
});
