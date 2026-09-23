import { describe, it, expect } from "vitest";
import { compareSites, siteKey } from "./site";

describe("siteKey", () => {
  it("ignores scheme, case, www, trailing slash and the REST suffix", () => {
    expect(siteKey("https://www.ShoesClothingStore.com/")).toBe("shoesclothingstore.com");
    expect(siteKey("http://shoesclothingstore.com/wp-json/wc/v3")).toBe("shoesclothingstore.com");
    expect(siteKey("shoesclothingstore.com")).toBe("shoesclothingstore.com");
  });
  it("keeps a sub-directory install distinct", () => {
    expect(siteKey("https://host.com/shop/")).toBe("host.com/shop");
  });
  it("is null for nothing", () => {
    expect(siteKey("")).toBeNull();
    expect(siteKey(null)).toBeNull();
  });
});

describe("compareSites", () => {
  it("matches the same shop spelled differently", () => {
    expect(compareSites("https://shoesclothingstore.com", "https://www.shoesclothingstore.com/").status).toBe("match");
  });
  it("names both sides of a mismatch", () => {
    expect(compareSites("https://shoesclothingstore.com", "https://othershop.it")).toEqual({
      status: "mismatch",
      snapshot: "shoesclothingstore.com",
      connected: "othershop.it",
    });
  });
  it("is unknown — not a mismatch — when a side is missing", () => {
    expect(compareSites(null, "https://othershop.it").status).toBe("unknown");
    expect(compareSites("https://shoesclothingstore.com", "").status).toBe("unknown");
  });
});
