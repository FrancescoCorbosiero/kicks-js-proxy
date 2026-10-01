import { beforeEach, describe, expect, it, vi } from "vitest";
import { publishBlock, publishRail, readHome, readRail } from "./service";

// The demo shop stands in for the site; no database behind the price locks.
vi.mock("@/lib/env", () => ({ env: { VETRINA_SOURCE: "fixture" } }));
vi.mock("@/server/overrides/repo", () => ({ getOverrides: async () => null }));

const SALDI = "category:saldi-sneakers-outlet#0";

async function draftOf(key: string) {
  const { rail } = await readRail(key);
  return {
    key,
    expectedModifiedGmt: rail.modifiedGmt,
    expectedAttrsHash: rail.attrsHash,
    pin: rail.pin,
    exclude: rail.exclude,
    fallback: rail.fallback,
    fields: rail.fields,
    limit: rail.limit,
  };
}

beforeEach(() => {
  delete (globalThis as { __vetrinaDemo?: unknown }).__vetrinaDemo;
});

describe("publishing a section's texts and size", () => {
  it("writes the texts, colour, button and size with the order, in one publish", async () => {
    const draft = await draftOf(SALDI);
    const result = await publishRail({
      ...draft,
      fields: { ...draft.fields, title: "SALDI AUTUNNO", backgroundColor: "black", buttonText: "Vedi tutti", buttonUrl: "/saldi" },
      limit: 6,
    });
    expect(result.changed).toBe(true);
    expect(result.rendered).toHaveLength(6);

    const { rail } = await readRail(SALDI);
    expect(rail.title).toBe("SALDI AUTUNNO");
    expect(rail.fields).toMatchObject({ title: "SALDI AUTUNNO", backgroundColor: "black", buttonUrl: "/saldi" });
    expect(rail.limit).toBe(6);
  });

  it("ignores fields the config does not let the customer edit", async () => {
    const draft = await draftOf(SALDI);
    const result = await publishRail({ ...draft, fields: { ...draft.fields, shortcode: "[gh_product_rail ids=\"1\"]" } });
    expect(result.changed).toBe(false);
  });

  it("refuses a value the plugin would refuse, before anything is sent", async () => {
    const draft = await draftOf(SALDI);
    await expect(publishRail({ ...draft, fields: { ...draft.fields, buttonUrl: "javascript:alert(1)" } })).rejects.toMatchObject({
      code: "invalid",
    });
    await expect(publishRail({ ...draft, limit: 500 })).rejects.toMatchObject({ code: "invalid" });
  });

  it("refuses a publish over a section that changed meanwhile", async () => {
    const draft = await draftOf(SALDI);
    await publishRail({ ...draft, fields: { ...draft.fields, eyebrow: "Prima modifica" } });
    await expect(publishRail({ ...draft, fields: { ...draft.fields, eyebrow: "Seconda" } })).rejects.toMatchObject({
      code: "stale",
    });
  });
});

describe("publishing a block's texts", () => {
  it("writes the FAQ subtitle, and refuses a stale write", async () => {
    const { home } = await readHome();
    const faq = home.blocks.find((b) => b.name === "golden-hive/faq-schema");
    if (!faq || faq.kind !== "static" || !faq.attrsHash) throw new Error("the demo homepage has an editable FAQ");

    const write = {
      path: faq.path,
      blockName: faq.name,
      expectedModifiedGmt: home.modifiedGmt,
      expectedAttrsHash: faq.attrsHash,
      fields: { subtitle: "Tutto quello che serve sapere" },
    };
    const result = await publishBlock(write);
    expect(result.fields.subtitle).toBe("Tutto quello che serve sapere");

    const after = await readHome();
    const faqAfter = after.home.blocks.find((b) => b.path === faq.path);
    expect(faqAfter?.kind === "static" && faqAfter.fields?.subtitle).toBe("Tutto quello che serve sapere");

    await expect(publishBlock({ ...write, fields: { subtitle: "Di nuovo" } })).rejects.toMatchObject({ code: "stale" });
  });

  it("refuses a block the config gives no fields", async () => {
    const { home } = await readHome();
    const hero = home.blocks.find((b) => b.name === "golden-hive/hero-carousel");
    await expect(
      publishBlock({
        path: hero?.path ?? "",
        blockName: "golden-hive/hero-carousel",
        expectedModifiedGmt: home.modifiedGmt,
        expectedAttrsHash: "x",
        fields: { title: "x" },
      }),
    ).rejects.toMatchObject({ code: "stale" });
  });
});
