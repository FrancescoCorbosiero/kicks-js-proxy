import { describe, it, expect } from "vitest";
import { duplicateGtins, normalizeGtin, toGtin } from "./gtin";

describe("normalizeGtin", () => {
  it("accepts a real EAN-13 from the GoldenSneakers feed", () => {
    expect(normalizeGtin("4067907638411")).toEqual({ gtin: "4067907638411", rejection: null });
    expect(toGtin(4067898487401)).toBe("4067898487401"); // arrives as a JSON number
  });

  it("pads a UPC-A to 13 without touching the check digit", () => {
    // 12-digit UPC-A: the pad shifts the alternating weights onto the same
    // digits, so the check digit stays valid — a normalization, not a rewrite.
    expect(toGtin("036000291452")).toBe("0036000291452");
    expect(normalizeGtin("0036000291452").rejection).toBeNull();
  });

  it("cleans what export tools add", () => {
    expect(toGtin("'4067907638411")).toBe("4067907638411"); // Excel quote
    expect(toGtin(" 4067907638411 ")).toBe("4067907638411");
    expect(toGtin("4067-9076-38411")).toBe("4067907638411");
    expect(toGtin("00004067907638411")).toBe("4067907638411"); // fixed-width padding
  });

  it("refuses what a channel would reject, with the reason", () => {
    expect(normalizeGtin("4067907638410")).toEqual({ gtin: null, rejection: "badCheckDigit" });
    expect(normalizeGtin("40679076384")).toEqual({ gtin: null, rejection: "badLength" });
    expect(normalizeGtin("40679O7638411")).toEqual({ gtin: null, rejection: "nonNumeric" });
    expect(normalizeGtin("")).toEqual({ gtin: null, rejection: "empty" });
    expect(normalizeGtin(null)).toEqual({ gtin: null, rejection: "empty" });
  });

  it("accepts the other GS1 widths", () => {
    expect(normalizeGtin("96385074").rejection).toBeNull(); // GTIN-8
    expect(normalizeGtin("00012345600012").rejection).toBeNull(); // GTIN-14
  });
});

describe("duplicateGtins", () => {
  it("names every barcode claimed by more than one size", () => {
    const dupes = duplicateGtins(["4067907638411", "4067898487401", "4067907638411", null]);
    expect([...dupes]).toEqual(["4067907638411"]);
  });

  it("is empty for a clean per-size set", () => {
    expect(duplicateGtins(["4067907638411", "4067898487401"]).size).toBe(0);
  });
});
