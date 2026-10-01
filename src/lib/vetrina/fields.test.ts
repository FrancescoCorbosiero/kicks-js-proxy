import { describe, expect, it } from "vitest";
import { changedFields, editableFields, fieldChanges, fieldProblem } from "./fields";

const WRAP = "golden-hive/shortcode-wrapper";

describe("editable fields", () => {
  it("are what the config asks for, within what the plugin allows, in the plugin's order", () => {
    expect(editableFields(WRAP, ["title", "shortcode", "eyebrow"])).toEqual(["eyebrow", "title"]);
    expect(editableFields("golden-hive/hero-carousel", ["title"])).toEqual([]);
  });

  it("drop fields the site did not return (an older plugin returns none)", () => {
    expect(editableFields(WRAP, ["title", "eyebrow"], { title: "SALDI" })).toEqual(["title"]);
    expect(editableFields(WRAP, ["title"], {})).toEqual([]);
  });
});

describe("field checks mirror the plugin", () => {
  it("accept plain text within the limit, counting an emoji as one character", () => {
    expect(fieldProblem(WRAP, "title", "SALDI")).toBeNull();
    expect(fieldProblem(WRAP, "title", "🔥".repeat(120))).toBeNull();
    expect(fieldProblem(WRAP, "title", "x".repeat(121))).toBe("too_long");
  });

  it("accept http(s) and site-relative links, or nothing", () => {
    expect(fieldProblem(WRAP, "buttonUrl", "https://resellpiacenza.shop/saldi/")).toBeNull();
    expect(fieldProblem(WRAP, "buttonUrl", "/product-category/saldi/")).toBeNull();
    expect(fieldProblem(WRAP, "buttonUrl", "")).toBeNull();
    expect(fieldProblem(WRAP, "buttonUrl", "javascript:alert(1)")).toBe("bad_url");
    expect(fieldProblem(WRAP, "buttonUrl", "saldi")).toBe("bad_url");
  });

  it("accept only the listed backgrounds, and nothing outside the spec", () => {
    expect(fieldProblem(WRAP, "backgroundColor", "gray")).toBeNull();
    expect(fieldProblem(WRAP, "backgroundColor", "pink")).toBe("not_an_option");
    expect(fieldProblem(WRAP, "shortcode", "[gh_product_rail]")).toBe("not_editable");
  });
});

describe("field changes", () => {
  it("send only what changed, trimmed", () => {
    const before = { title: "SALDI", eyebrow: "Saldi primaverili", buttonUrl: "" };
    const after = { title: "SALDI", eyebrow: "  Saldi d'autunno ", buttonUrl: "/saldi" };
    expect(changedFields(before, after)).toEqual(["eyebrow", "buttonUrl"]);
    expect(fieldChanges(before, after)).toEqual({ eyebrow: "Saldi d'autunno", buttonUrl: "/saldi" });
  });
});
